import { Router } from 'express'
import { asyncHandler } from '../../core/asyncHandler'
import { isProduction } from '../../config/env'
import { requireAuth } from '../../middleware/auth'
import { authLimiter, sensitiveLimiter } from '../../middleware/rateLimit'
import { validate } from '../../middleware/validate'
import { z } from 'zod'
import { NotFoundError, ValidationError } from '../../core/errors'
import { Membership, MembershipStatus, Organisation, User } from '../../models'
import { recordAudit } from '../invoices/invoice.service'
import {
  changePassword,
  hashPassword,
  login,
  register,
  requestPasswordReset,
  resetPassword,
  verifyEmail,
} from './auth.service'
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  passwordSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './auth.schemas'
import {
  hashToken,
  issueTokenPair,
  revokeAllSessions,
  revokeRefreshToken,
  rotateRefreshToken,
} from './token.service'

const router = Router()

/**
 * Refresh tokens travel in an httpOnly cookie, not in the JSON body.
 *
 * A refresh token in localStorage is readable by any successful XSS. httpOnly
 * puts it out of JavaScript's reach entirely. The short-lived ACCESS token is
 * still returned in the body and held in memory, which is the standard split.
 *
 * sameSite=none is required because the frontend (Vercel) and API (Render) are
 * on different registrable domains; it mandates secure=true, hence the
 * environment check.
 */
const REFRESH_COOKIE = 'taxpedestal_rt'

function refreshCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: (isProduction ? 'none' : 'lax') as 'none' | 'lax',
    expires,
    path: '/api/v1/auth',
  }
}

router.post(
  '/register',
  authLimiter,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const result = await register(req.body, {
      userAgent: req.header('user-agent'),
      ip: req.ip,
    })

    res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions(result.refreshExpiresAt))

    await recordAudit({
      org: null,
      actor: result.user._id,
      action: 'auth.registered',
      entityType: 'User',
      entityId: result.user._id.toString(),
      ip: req.ip,
      requestId: req.requestId,
    })

    res.status(201).json({
      user: result.user.toJSON(),
      organisation: result.organisation,
      accessToken: result.accessToken,
    })
  }),
)

router.post(
  '/login',
  authLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await login(req.body.email, req.body.password, {
      userAgent: req.header('user-agent'),
      ip: req.ip,
    })

    res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions(result.refreshExpiresAt))

    res.json({
      user: result.user.toJSON(),
      organisation: result.organisation,
      accessToken: result.accessToken,
    })
  }),
)

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    // Cookie first; body fallback supports non-browser clients.
    const presented = (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? req.body?.refreshToken
    if (!presented) {
      res.status(401).json({
        error: { code: 'NO_REFRESH_TOKEN', message: 'Sign in to continue' },
      })
      return
    }

    const tokens = await rotateRefreshToken(presented, {
      userAgent: req.header('user-agent'),
      ip: req.ip,
    })

    res.cookie(REFRESH_COOKIE, tokens.refreshToken, refreshCookieOptions(tokens.refreshExpiresAt))
    res.json({ accessToken: tokens.accessToken })
  }),
)

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined
    if (presented) await revokeRefreshToken(presented)
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' })
    res.status(204).send()
  }),
)

router.post(
  '/logout-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.auth!.userId)
    if (user) await revokeAllSessions(user._id, 'USER_REQUESTED')
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' })
    res.status(204).send()
  }),
)

router.post(
  '/verify-email',
  validate(verifyEmailSchema),
  asyncHandler(async (req, res) => {
    await verifyEmail(req.body.token)
    res.json({ verified: true })
  }),
)

router.post(
  '/forgot-password',
  sensitiveLimiter,
  validate(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    await requestPasswordReset(req.body.email)
    // Always the same response, whether or not the account exists.
    res.json({
      message: 'If an account exists for that address, a reset link is on its way.',
    })
  }),
)

router.post(
  '/reset-password',
  sensitiveLimiter,
  validate(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    await resetPassword(req.body.token, req.body.password)
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' })
    res.json({ message: 'Password updated. Sign in with your new password.' })
  }),
)

router.post(
  '/change-password',
  requireAuth,
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const { Types } = await import('mongoose')
    await changePassword(
      new Types.ObjectId(req.auth!.userId),
      req.body.currentPassword,
      req.body.newPassword,
    )
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' })
    res.json({ message: 'Password changed. Sign in again on your other devices.' })
  }),
)

/**
 * Look up a pending invitation.
 *
 * Unauthenticated: the recipient may not have an account yet, and the page must
 * be able to say "Ama invited you to Northwind Studio" before asking them to
 * sign up. Returns only what is needed to render that, never the org's data.
 */
router.get(
  '/invitation/:token',
  asyncHandler(async (req, res) => {
    const token = req.params.token
    if (!token) throw new ValidationError('That invitation link is not valid')

    const membership = await Membership.findOne({
      invitationTokenHash: hashToken(token),
      status: MembershipStatus.INVITED,
    }).select('+invitationTokenHash')

    if (!membership || !membership.invitationExpiresAt) {
      throw new ValidationError('That invitation is invalid or has already been used')
    }
    if (membership.invitationExpiresAt.getTime() < Date.now()) {
      throw new ValidationError('That invitation has expired. Ask for a new one.')
    }

    const [org, inviter] = await Promise.all([
      Organisation.findById(membership.org).select('name'),
      membership.invitedBy ? User.findById(membership.invitedBy).select('fullName') : null,
    ])

    // If the invited address already has an account, the page shows a sign-in
    // prompt instead of a registration form.
    const email = membership.invitedEmail
    const existingUser = email ? await User.exists({ email }) : Boolean(membership.user)

    res.json({
      organisationName: org?.name ?? 'a workspace',
      inviterName: inviter?.fullName ?? null,
      role: membership.role,
      email,
      hasAccount: Boolean(existingUser),
    })
  }),
)

/**
 * Accept an invitation.
 *
 * Two paths: an existing user accepts while signed in, or a new user supplies a
 * name and password and is created here. Both converge on activating the
 * membership and issuing a session.
 */
router.post(
  '/invitation/:token/accept',
  authLimiter,
  validate(
    z.object({
      fullName: z.string().trim().min(2).max(120).optional(),
      password: passwordSchema.optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const token = req.params.token
    if (!token) throw new ValidationError('That invitation link is not valid')

    const membership = await Membership.findOne({
      invitationTokenHash: hashToken(token),
      status: MembershipStatus.INVITED,
    }).select('+invitationTokenHash')

    if (!membership || !membership.invitationExpiresAt) {
      throw new ValidationError('That invitation is invalid or has already been used')
    }
    if (membership.invitationExpiresAt.getTime() < Date.now()) {
      throw new ValidationError('That invitation has expired. Ask for a new one.')
    }

    let user = membership.user ? await User.findById(membership.user) : null

    if (!user && membership.invitedEmail) {
      user = await User.findOne({ email: membership.invitedEmail })
    }

    if (!user) {
      // New person. Creating the account here is what makes the invitation a
      // single click rather than "register, then find the email again".
      if (!req.body.fullName || !req.body.password) {
        throw new ValidationError('Tell us your name and choose a password', {
          fields: {
            ...(req.body.fullName ? {} : { fullName: 'Enter your name' }),
            ...(req.body.password ? {} : { password: 'Choose a password' }),
          },
        })
      }
      if (!membership.invitedEmail) {
        throw new ValidationError('That invitation is missing an email address')
      }

      user = await User.create({
        email: membership.invitedEmail,
        passwordHash: await hashPassword(req.body.password),
        fullName: req.body.fullName.trim(),
        // Receiving the invitation at that address proves control of it.
        emailVerifiedAt: new Date(),
      })
    }

    membership.user = user._id
    membership.invitedEmail = null
    membership.status = MembershipStatus.ACTIVE
    membership.acceptedAt = new Date()
    membership.invitationTokenHash = null
    membership.invitationExpiresAt = null
    await membership.save()

    const org = await Organisation.findById(membership.org).select('name slug')

    const tokens = await issueTokenPair(
      {
        _id: user._id,
        email: user.email,
        platformRole: user.platformRole,
        tokenVersion: user.tokenVersion,
      },
      { userAgent: req.header('user-agent'), ip: req.ip },
    )

    res.cookie(REFRESH_COOKIE, tokens.refreshToken, refreshCookieOptions(tokens.refreshExpiresAt))

    await recordAudit({
      org: membership.org,
      actor: user._id,
      action: 'invitation.accepted',
      entityType: 'Membership',
      entityId: membership._id.toString(),
      changes: { role: membership.role },
      requestId: req.requestId,
    })

    res.json({
      user: user.toJSON(),
      organisation: {
        id: membership.org.toString(),
        name: org?.name ?? '',
        slug: org?.slug ?? '',
        role: membership.role,
      },
      accessToken: tokens.accessToken,
    })
  }),
)

/**
 * Save the user's interface language.
 *
 * Deliberately its own tiny endpoint rather than part of a general profile
 * update: it fires whenever someone touches the language switcher, so it must
 * be cheap, and it must never be able to carry other fields along with it.
 */
router.patch(
  '/preferences',
  requireAuth,
  validate(
    z.object({
      // Validated as a real locale, not stored as arbitrary text — this value
      // is later passed to Intl, which throws on malformed input.
      preferredLocale: z
        .string()
        .trim()
        .min(2)
        .max(10)
        .refine((value) => {
          try {
            return Intl.getCanonicalLocales(value).length > 0
          } catch {
            return false
          }
        }, 'Not a valid language tag')
        .nullable(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const user = await User.findByIdAndUpdate(
      req.auth!.userId,
      { $set: { preferredLocale: req.body.preferredLocale } },
      { new: true },
    )
    if (!user) throw new NotFoundError('User')
    res.json({ preferredLocale: user.preferredLocale })
  }),
)

/** Current user plus every workspace they belong to. Powers app bootstrap. */
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.auth!.userId)
    if (!user) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } })
      return
    }

    const memberships = await Membership.find({
      user: user._id,
      status: MembershipStatus.ACTIVE,
    }).sort({ createdAt: 1 })

    const orgs = await Organisation.find({
      _id: { $in: memberships.map((m) => m.org) },
    }).select('name slug country baseCurrency taxRegistered brandColor logoUrl plan onboardingCompletedAt')

    const roleByOrg = new Map(memberships.map((m) => [m.org.toString(), m.role]))

    res.json({
      user: user.toJSON(),
      organisations: orgs.map((o) => ({
        id: o._id.toString(),
        name: o.name,
        slug: o.slug,
        country: o.country,
        baseCurrency: o.baseCurrency,
        taxRegistered: o.taxRegistered,
        brandColor: o.brandColor,
        logoUrl: o.logoUrl,
        plan: o.plan,
        onboardingCompletedAt: o.onboardingCompletedAt,
        role: roleByOrg.get(o._id.toString()),
      })),
    })
  }),
)

export default router
