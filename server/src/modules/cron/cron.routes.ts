import { NextFunction, Request, Response, Router } from 'express'
import crypto from 'node:crypto'
import { env } from '../../config/env'
import { asyncHandler } from '../../core/asyncHandler'
import { NotFoundError } from '../../core/errors'
import { logger } from '../../core/logger'
import {
  markOverdueInvoices,
  reconcileBalances,
  reconcilePendingPayments,
} from '../invoices/reconciliation.service'
import { runReminderSweep } from '../../jobs/reminders'

/**
 * HTTP-triggered scheduled jobs.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * The in-process scheduler (`jobs/scheduler.ts`) needs a long-lived process.
 * On serverless there is none: a cron registered inside a function instance
 * either never fires or fires once per cold start. The platform's own
 * scheduler calls these routes instead, so the same four jobs keep running.
 *
 * The jobs themselves are unchanged and remain idempotent, which is what makes
 * it safe for the platform to retry a call or to overlap two.
 *
 * ============================================================================
 * AUTHORISATION
 * ============================================================================
 * These endpoints move money: they settle payments and repair balances. They
 * are therefore refused entirely unless CRON_SECRET is configured, an
 * unauthenticated reconciliation endpoint is worse than no endpoint at all.
 *
 * The comparison is constant-time. A plain `===` on a secret leaks its prefix
 * through response timing, which is the same reasoning already applied to
 * webhook signatures.
 */
const router = Router()

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. */
function extractSecret(req: Request): string | null {
  const header = req.header('authorization')
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null
  // Accepted as a fallback so the endpoint can be driven by other schedulers.
  return req.header('x-cron-secret')?.trim() || null
}

function requireCronSecret(req: Request, _res: Response, next: NextFunction): void {
  // 404, not 401: an unconfigured or wrongly-called cron surface should not
  // advertise that it exists. Same posture as the admin routes.
  if (!env.CRON_SECRET) {
    logger.warn('Cron endpoint called but CRON_SECRET is not configured')
    next(new NotFoundError('Route'))
    return
  }

  const supplied = extractSecret(req)
  if (!supplied) {
    next(new NotFoundError('Route'))
    return
  }

  const a = Buffer.from(supplied)
  const b = Buffer.from(env.CRON_SECRET)
  // timingSafeEqual throws on a length mismatch, so compare lengths first, // length is not the secret.
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b)
  if (!ok) {
    logger.warn({ path: req.path }, 'Cron endpoint called with an invalid secret')
    next(new NotFoundError('Route'))
    return
  }

  next()
}

/**
 * The job table. Keyed by the same names the in-process scheduler uses, so the
 * two paths cannot drift into running different work.
 */
const JOBS: Record<string, () => Promise<unknown>> = {
  'reconcile-payments': () => reconcilePendingPayments({ limit: 200 }),
  'mark-overdue': () => markOverdueInvoices(),
  reminders: () => runReminderSweep(),
  'reconcile-balances': () => reconcileBalances({ limit: 1000, repair: true }),
}

router.all(
  '/:job',
  requireCronSecret,
  asyncHandler(async (req, res) => {
    const name = req.params.job as string
    const job = JOBS[name]
    if (!job) throw new NotFoundError('Job')

    const startedAt = Date.now()
    const result = await job()
    const ms = Date.now() - startedAt

    logger.info({ job: name, ms, result }, 'Cron job finished')
    res.json({ job: name, ms, result })
  }),
)

export default router
