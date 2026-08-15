import rateLimit, { Options } from 'express-rate-limit'
import { Request } from 'express'
import { env, isTest } from '../config/env'
import { RateLimitError } from '../core/errors'

/**
 * Rate limiting.
 *
 * Tiered rather than uniform, because the endpoints differ by orders of
 * magnitude in cost and risk. A single global limit is either too loose to stop
 * credential stuffing or too tight to browse invoices.
 *
 * NOTE (technical debt TD-004): the default store is in-memory, so limits are
 * per-instance. Behind more than one Render instance the effective limit
 * multiplies by the instance count. Redis is the fix; documented, not hidden.
 */

function base(overrides: Partial<Options>): ReturnType<typeof rateLimit> {
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Disabled under test so integration suites are not throttled.
    skip: () => isTest,
    handler: (_req, _res, next) => {
      next(new RateLimitError())
    },
    ...overrides,
  })
}

/** Applied to the whole API. Generous, a working session makes many calls. */
export const globalLimiter = base({})

/**
 * Credential endpoints. Keyed on IP + email so one attacker cannot lock out
 * every user from a shared NAT, and one victim cannot be targeted from a
 * rotating IP pool without also tripping the email key.
 */
export const authLimiter = base({
  windowMs: 15 * 60_000,
  max: 10,
  keyGenerator: (req: Request) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : 'anonymous'
    return `${req.ip}:${email}`
  },
})

/** Password reset and verification resends, expensive and abusable for spam. */
export const sensitiveLimiter = base({ windowMs: 60 * 60_000, max: 5 })

/**
 * Public invoice pages. Higher than auth (a customer may refresh while paying)
 * but bounded, since the endpoint is unauthenticated and enumerable in principle.
 */
export const publicLimiter = base({ windowMs: 60_000, max: 60 })

/** Payment initiation. Tight: each call may create a provider-side charge. */
export const paymentLimiter = base({ windowMs: 60_000, max: 12 })
