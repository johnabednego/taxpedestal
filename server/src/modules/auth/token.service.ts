import crypto from 'node:crypto'
import jwt, { SignOptions } from 'jsonwebtoken'
import { Types } from 'mongoose'
import { env } from '../../config/env'
import { BRAND } from '../../core/brand'
import { logger } from '../../core/logger'
import { UnauthorizedError } from '../../core/errors'
import { RefreshToken, User } from '../../models'

/**
 * Token service.
 *
 * Access tokens are short-lived JWTs held in memory by the client. Refresh
 * tokens are long-lived opaque random strings stored hashed, rotated on every
 * use, and grouped into families for replay detection.
 *
 * Why not a single long-lived JWT: JWTs cannot be revoked without a
 * server-side deny-list, at which point the statelessness that motivated them
 * is gone. Splitting the two gives cheap stateless authorisation on the hot
 * path plus real revocation on the cold path.
 */

export interface AccessTokenClaims {
  sub: string
  email: string
  platformRole: string
  /** Invalidates the token when the user's tokenVersion is bumped. */
  tv: number
}

/**
 * Token issuer and audience.
 *
 * Derived from the brand but pinned as constants, because changing them
 * invalidates every token in circulation — a rename must not silently sign
 * every user out. If the brand changes again, these stay put.
 */
const BRAND_ISSUER = BRAND.name.toLowerCase()
const BRAND_AUDIENCE = `${BRAND.name.toLowerCase()}-api`

const SHA256 = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex')

export function hashToken(token: string): string {
  return SHA256(token)
}

/** 48 random bytes, base64url. Not a JWT — it carries no claims by design. */
export function generateOpaqueToken(): string {
  return crypto.randomBytes(48).toString('base64url')
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
    issuer: BRAND_ISSUER,
    audience: BRAND_AUDIENCE,
  } as SignOptions)
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: BRAND_ISSUER,
      audience: BRAND_AUDIENCE,
    }) as AccessTokenClaims
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      // Distinct code so the client knows to refresh rather than to sign in.
      throw new UnauthorizedError('Session expired', 'TOKEN_EXPIRED')
    }
    throw new UnauthorizedError('Invalid session token', 'TOKEN_INVALID')
  }
}

function refreshExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
}

export interface IssuedTokens {
  accessToken: string
  refreshToken: string
  refreshExpiresAt: Date
}

export interface SessionContext {
  userAgent?: string | null
  ip?: string | null
}

/** Issue a brand-new token pair, starting a fresh family. */
export async function issueTokenPair(
  user: { _id: Types.ObjectId; email: string; platformRole: string; tokenVersion: number },
  ctx: SessionContext = {},
): Promise<IssuedTokens> {
  const refreshToken = generateOpaqueToken()
  const expiresAt = refreshExpiry()

  await RefreshToken.create({
    user: user._id,
    tokenHash: hashToken(refreshToken),
    family: crypto.randomUUID(),
    expiresAt,
    userAgent: ctx.userAgent ?? null,
    ip: ctx.ip ?? null,
  })

  return {
    accessToken: signAccessToken({
      sub: user._id.toString(),
      email: user.email,
      platformRole: user.platformRole,
      tv: user.tokenVersion,
    }),
    refreshToken,
    refreshExpiresAt: expiresAt,
  }
}

/**
 * Exchange a refresh token for a new pair.
 *
 * REUSE DETECTION: if the presented token has already been rotated
 * (`replacedBy` is set) or was revoked, two parties hold the same secret. We
 * cannot tell which is the attacker, so the entire family is revoked and the
 * user's tokenVersion is bumped — every access token dies too. The legitimate
 * user is forced to sign in again, which is the correct trade against an
 * attacker retaining access.
 */
export async function rotateRefreshToken(
  presented: string,
  ctx: SessionContext = {},
): Promise<IssuedTokens> {
  const tokenHash = hashToken(presented)
  const existing = await RefreshToken.findOne({ tokenHash })

  if (!existing) {
    throw new UnauthorizedError('Session is no longer valid', 'REFRESH_INVALID')
  }

  const isReuse = Boolean(existing.replacedBy) || Boolean(existing.revokedAt)

  if (isReuse) {
    logger.warn(
      { userId: existing.user.toString(), family: existing.family },
      'Refresh token reuse detected — revoking token family',
    )
    await revokeFamily(existing.family, 'REUSE_DETECTED')
    await User.findByIdAndUpdate(existing.user, { $inc: { tokenVersion: 1 } })
    throw new UnauthorizedError('Session was revoked for security reasons', 'REFRESH_REUSED')
  }

  if (existing.expiresAt.getTime() <= Date.now()) {
    throw new UnauthorizedError('Session expired', 'REFRESH_EXPIRED')
  }

  const user = await User.findById(existing.user)
  if (!user || user.suspendedAt) {
    await revokeFamily(existing.family, 'USER_UNAVAILABLE')
    throw new UnauthorizedError('Account is not available', 'ACCOUNT_UNAVAILABLE')
  }

  const nextToken = generateOpaqueToken()
  const expiresAt = refreshExpiry()

  const created = await RefreshToken.create({
    user: user._id,
    tokenHash: hashToken(nextToken),
    // Same family: this is a continuation of one login session.
    family: existing.family,
    expiresAt,
    userAgent: ctx.userAgent ?? null,
    ip: ctx.ip ?? null,
  })

  existing.replacedBy = created._id
  existing.revokedAt = new Date()
  existing.revokedReason = 'ROTATED'
  await existing.save()

  return {
    accessToken: signAccessToken({
      sub: user._id.toString(),
      email: user.email,
      platformRole: user.platformRole,
      tv: user.tokenVersion,
    }),
    refreshToken: nextToken,
    refreshExpiresAt: expiresAt,
  }
}

export async function revokeFamily(family: string, reason: string): Promise<void> {
  await RefreshToken.updateMany(
    { family, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  )
}

/** Sign out of the current session only. */
export async function revokeRefreshToken(presented: string): Promise<void> {
  const tokenHash = hashToken(presented)
  await RefreshToken.updateOne(
    { tokenHash, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'SIGNED_OUT' } },
  )
}

/** Sign out everywhere. Used on password change and by the admin console. */
export async function revokeAllSessions(userId: Types.ObjectId, reason: string): Promise<void> {
  await RefreshToken.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  )
  await User.findByIdAndUpdate(userId, { $inc: { tokenVersion: 1 } })
}
