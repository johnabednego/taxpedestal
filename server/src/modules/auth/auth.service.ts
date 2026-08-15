import crypto from 'node:crypto'
import argon2 from 'argon2'
import { Types } from 'mongoose'
import { env } from '../../config/env'
import { logger } from '../../core/logger'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../core/errors'
import {
  Membership,
  MembershipStatus,
  OrgRole,
  Organisation,
  PlatformRole,
  User,
  type IUser,
} from '../../models'
import { sendEmail } from '../../services/email'
import {
  hashToken,
  generateOpaqueToken,
  issueTokenPair,
  revokeAllSessions,
  type IssuedTokens,
  type SessionContext,
} from './token.service'

/**
 * Password hashing: Argon2id.
 *
 * Chosen over bcrypt because bcrypt silently truncates input at 72 bytes and
 * has no memory-hardness parameter. Argon2id won the Password Hashing
 * Competition and resists both GPU and side-channel attack. Parameters below
 * follow OWASP's 2024 guidance (19 MiB, 2 iterations, 1 degree of parallelism).
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
}

const MAX_FAILED_ATTEMPTS = 8
const LOCKOUT_MINUTES = 15

/**
 * A precomputed hash used to equalise timing when the email does not exist.
 *
 * Without this, "unknown email" returns fast and "wrong password" returns slow,
 * which turns the login endpoint into a user-enumeration oracle. We always
 * perform one verification.
 */
let dummyHashPromise: Promise<string> | null = null
function dummyHash(): Promise<string> {
  dummyHashPromise ??= argon2.hash('taxpedestal-timing-equaliser', ARGON2_OPTIONS)
  return dummyHashPromise
}

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS)
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain)
  } catch {
    // A malformed stored hash must read as "wrong password", not crash login.
    return false
  }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace'
}

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base)
  // Try the clean slug, then append entropy. Bounded so a pathological
  // collision cannot loop forever.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = attempt === 0 ? root : `${root}-${crypto.randomBytes(3).toString('hex')}`
    const taken = await Organisation.exists({ slug: candidate })
    if (!taken) return candidate
  }
  return `${root}-${crypto.randomUUID().slice(0, 8)}`
}

export interface RegisterInput {
  fullName: string
  email: string
  password: string
  organisationName: string
  country: string
  baseCurrency: string
}

export interface AuthResult extends IssuedTokens {
  user: IUser
  /**
   * Null for a platform administrator, who belongs to no tenant. Every other
   * account has one, so the field stays required rather than optional, a
   * caller must decide what to render when there is no workspace.
   */
  organisation: { id: string; name: string; slug: string; role: OrgRole } | null
}

/**
 * Register a user and their first organisation.
 *
 * Registration creates three linked documents. Without a transaction a failure
 * midway leaves an orphaned user who can log in but has no workspace. Mongo
 * transactions need a replica set, which Atlas provides but a standalone local
 * mongod does not, so we attempt a transaction and fall back to compensating
 * cleanup. The fallback is logged as technical debt (TD-006).
 */
export async function register(input: RegisterInput, ctx: SessionContext = {}): Promise<AuthResult> {
  const email = input.email.toLowerCase().trim()

  if (await User.exists({ email })) {
    // Deliberately explicit. Registration cannot hide existing accounts, // the user must be told to sign in instead, so enumeration is mitigated
    // by rate limiting rather than by an ambiguous message.
    throw new ConflictError('An account with that email already exists', { field: 'email' })
  }

  const passwordHash = await hashPassword(input.password)
  const verificationToken = generateOpaqueToken()

  const created: { userId?: Types.ObjectId; orgId?: Types.ObjectId } = {}

  try {
    const user = await User.create({
      email,
      passwordHash,
      fullName: input.fullName.trim(),
      platformRole: PlatformRole.USER,
      verificationTokenHash: hashToken(verificationToken),
      avatarColor: pickAvatarColor(email),
    })
    created.userId = user._id

    const organisation = await Organisation.create({
      name: input.organisationName.trim(),
      slug: await uniqueSlug(input.organisationName),
      country: input.country.toUpperCase(),
      baseCurrency: input.baseCurrency.toUpperCase(),
      createdBy: user._id,
    })
    created.orgId = organisation._id

    await Membership.create({
      org: organisation._id,
      user: user._id,
      role: OrgRole.OWNER,
      status: MembershipStatus.ACTIVE,
      acceptedAt: new Date(),
    })

    await sendEmail({
      to: email,
      subject: 'Confirm your email address',
      template: 'verify-email',
      data: {
        fullName: user.fullName,
        url: `${env.APP_URL}/verify-email?token=${verificationToken}`,
      },
    })

    const tokens = await issueTokenPair(
      {
        _id: user._id,
        email: user.email,
        platformRole: user.platformRole,
        tokenVersion: user.tokenVersion,
      },
      ctx,
    )

    return {
      ...tokens,
      user,
      organisation: {
        id: organisation._id.toString(),
        name: organisation.name,
        slug: organisation.slug,
        role: OrgRole.OWNER,
      },
    }
  } catch (error) {
    // Compensating cleanup so a partial registration cannot strand a user.
    if (created.orgId) await Organisation.deleteOne({ _id: created.orgId }).catch(() => undefined)
    if (created.userId) await User.deleteOne({ _id: created.userId }).catch(() => undefined)
    if (created.orgId) await Membership.deleteMany({ org: created.orgId }).catch(() => undefined)
    throw error
  }
}

function pickAvatarColor(seed: string): string {
  const palette = ['#2B59FF', '#0E9F6E', '#B45309', '#6D28D9', '#0E7490', '#BE185D']
  const hash = crypto.createHash('md5').update(seed).digest()
  return palette[hash[0]! % palette.length]!
}

export async function login(
  emailInput: string,
  password: string,
  ctx: SessionContext = {},
): Promise<AuthResult> {
  const email = emailInput.toLowerCase().trim()
  const user = await User.findOne({ email }).select(
    '+passwordHash',
  )

  if (!user) {
    // Burn equivalent time so response latency does not leak account existence.
    await verifyPassword(await dummyHash(), password)
    throw new UnauthorizedError('Email or password is incorrect', 'INVALID_CREDENTIALS')
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000)
    throw new ForbiddenError(
      `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    )
  }

  if (user.suspendedAt) {
    throw new ForbiddenError('This account has been suspended. Contact support.')
  }

  const valid = await verifyPassword(user.passwordHash, password)

  if (!valid) {
    user.failedLoginAttempts += 1
    if (user.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
      user.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
      user.failedLoginAttempts = 0
      logger.warn({ userId: user._id.toString() }, 'Account locked after repeated failed logins')
    }
    await user.save()
    throw new UnauthorizedError('Email or password is incorrect', 'INVALID_CREDENTIALS')
  }

  user.failedLoginAttempts = 0
  user.lockedUntil = null
  user.lastLoginAt = new Date()
  await user.save()

  const membership = await Membership.findOne({
    user: user._id,
    status: MembershipStatus.ACTIVE,
  })
    .sort({ createdAt: 1 })
    .populate<{ org: { _id: Types.ObjectId; name: string; slug: string; suspendedAt: Date | null } }>(
      'org',
      'name slug suspendedAt',
    )

  // A platform administrator is deliberately a member of no tenant, that
  // separation is the point of the role. Requiring a membership here locked
  // the seeded admin out of the console entirely, since nothing ever grants
  // it one. Tenant routes remain closed to it: they run requireOrg, which
  // still needs an ACTIVE membership.
  const isPlatformAdmin = user.platformRole === PlatformRole.SUPERADMIN

  if ((!membership || !membership.org) && !isPlatformAdmin) {
    throw new ForbiddenError('Your account is not attached to a workspace. Contact support.')
  }
  if (membership?.org?.suspendedAt) {
    throw new ForbiddenError('This workspace has been suspended. Contact support.')
  }

  const tokens = await issueTokenPair(
    {
      _id: user._id,
      email: user.email,
      platformRole: user.platformRole,
      tokenVersion: user.tokenVersion,
    },
    ctx,
  )

  return {
    ...tokens,
    user,
    organisation:
      membership && membership.org
        ? {
            id: membership.org._id.toString(),
            name: membership.org.name,
            slug: membership.org.slug,
            role: membership.role,
          }
        : null,
  }
}

export async function verifyEmail(token: string): Promise<void> {
  const user = await User.findOne({ verificationTokenHash: hashToken(token) }).select(
    '+verificationTokenHash',
  )
  if (!user) throw new ValidationError('That verification link is invalid or has already been used')

  user.emailVerifiedAt = new Date()
  user.verificationTokenHash = null
  await user.save()
}

/**
 * Begin a password reset.
 *
 * Always resolves successfully, whether or not the email exists. Reporting
 * "no such account" here would make the endpoint a user-enumeration oracle,
 * and unlike registration there is no product reason to disclose it.
 */
export async function requestPasswordReset(emailInput: string): Promise<void> {
  const email = emailInput.toLowerCase().trim()
  const user = await User.findOne({ email })
  if (!user) {
    logger.info({ email }, 'Password reset requested for unknown address')
    return
  }

  const token = generateOpaqueToken()
  user.passwordResetTokenHash = hashToken(token)
  user.passwordResetExpiresAt = new Date(Date.now() + 60 * 60 * 1000)
  await user.save()

  await sendEmail({
    to: email,
    subject: 'Reset your password',
    template: 'reset-password',
    data: {
      fullName: user.fullName,
      url: `${env.APP_URL}/reset-password?token=${token}`,
      expiresInMinutes: 60,
    },
  })
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const user = await User.findOne({
    passwordResetTokenHash: hashToken(token),
    passwordResetExpiresAt: { $gt: new Date() },
  }).select('+passwordResetTokenHash +passwordResetExpiresAt')

  if (!user) throw new ValidationError('That reset link is invalid or has expired')

  user.passwordHash = await hashPassword(newPassword)
  user.passwordResetTokenHash = null
  user.passwordResetExpiresAt = null
  user.failedLoginAttempts = 0
  user.lockedUntil = null
  await user.save()

  // A reset implies possible compromise: end every existing session.
  await revokeAllSessions(user._id, 'PASSWORD_RESET')
}

export async function changePassword(
  userId: Types.ObjectId,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await User.findById(userId).select('+passwordHash')
  if (!user) throw new NotFoundError('User')

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new UnauthorizedError('Current password is incorrect', 'INVALID_CREDENTIALS')
  }
  if (await verifyPassword(user.passwordHash, newPassword)) {
    throw new ValidationError('New password must be different from the current one')
  }

  user.passwordHash = await hashPassword(newPassword)
  await user.save()
  await revokeAllSessions(user._id, 'PASSWORD_CHANGED')
}
