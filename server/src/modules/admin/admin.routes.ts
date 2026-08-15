import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../../core/asyncHandler'
import { NotFoundError } from '../../core/errors'
import { objectIdParam } from '../../core/params'
import { requireAuth, requireSuperAdmin } from '../../middleware/auth'
import { validate } from '../../middleware/validate'
import {
  AuditLog,
  Client,
  Invoice,
  InvoiceStatus,
  Organisation,
  Payment,
  User,
  WebhookEvent,
} from '../../models'
import {
  reconcileBalances,
  reconcilePendingPayments,
} from '../invoices/reconciliation.service'
import { revokeAllSessions } from '../auth/token.service'
import {
  addCoverageOverride,
  coverageAgeDays,
  COVERAGE_REVIEWED_AT,
  isCoverageStale,
} from '../../services/payments/coverage'
import { clearProbeCache, probeAll } from '../../services/payments/health'

/**
 * Platform administration.
 *
 * Guarded by requireSuperAdmin, which returns 404 rather than 403 so the admin
 * surface is not discoverable by probing. Operational rather than analytical:
 * these are the tools needed when something has gone wrong in production.
 */
const router = Router()
router.use(requireAuth, requireSuperAdmin)

router.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const [orgs, users, invoices, issued, payments, failedWebhooks, pendingWebhooks] =
      await Promise.all([
        Organisation.countDocuments(),
        User.countDocuments(),
        Invoice.countDocuments(),
        Invoice.countDocuments({ status: { $ne: InvoiceStatus.DRAFT } }),
        Payment.countDocuments({ status: 'SUCCEEDED' }),
        WebhookEvent.countDocuments({ status: 'FAILED' }),
        WebhookEvent.countDocuments({ status: 'RECEIVED' }),
      ])

    res.json({
      organisations: orgs,
      users,
      invoices: { total: invoices, issued },
      successfulPayments: payments,
      webhooks: { failed: failedWebhooks, pending: pendingWebhooks },
    })
  }),
)

router.get(
  '/organisations',
  validate(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      search: z.string().trim().max(120).optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const { page, limit, search } = req.query as unknown as {
      page: number
      limit: number
      search?: string
    }
    const filter: Record<string, unknown> = {}
    if (search) filter.name = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }

    const [orgs, total] = await Promise.all([
      Organisation.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Organisation.countDocuments(filter),
    ])

    // Per-org counts for the list view.
    const enriched = await Promise.all(
      orgs.map(async (org) => ({
        id: org._id.toString(),
        name: org.name,
        slug: org.slug,
        country: org.country,
        baseCurrency: org.baseCurrency,
        plan: org.plan,
        suspendedAt: org.suspendedAt,
        createdAt: org.createdAt,
        invoiceCount: await Invoice.countDocuments({ org: org._id }),
        clientCount: await Client.countDocuments({ org: org._id }),
      })),
    )

    res.json({ data: enriched, pagination: { page, limit, total, pages: Math.ceil(total / limit) } })
  }),
)

router.post(
  '/organisations/:id/suspend',
  validate(z.object({ suspended: z.boolean() })),
  asyncHandler(async (req, res) => {
    const org = await Organisation.findByIdAndUpdate(
      objectIdParam(req, 'id', 'Workspace'),
      { $set: { suspendedAt: req.body.suspended ? new Date() : null } },
      { new: true },
    )
    if (!org) throw new NotFoundError('Workspace')
    res.json(org)
  }),
)

router.post(
  '/users/:id/suspend',
  validate(z.object({ suspended: z.boolean() })),
  asyncHandler(async (req, res) => {
    const userId = objectIdParam(req, 'id', 'User')
    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { suspendedAt: req.body.suspended ? new Date() : null } },
      { new: true },
    )
    if (!user) throw new NotFoundError('User')
    // Suspension must take effect immediately, not when the access token expires.
    if (req.body.suspended) await revokeAllSessions(userId, 'ADMIN_SUSPENDED')
    res.json(user)
  }),
)

/**
 * Webhook inspector.
 *
 * Neither Stripe nor Paystack can show you what YOUR system did with an event.
 * This does: the stored payload, verification outcome, processing status and
 * error. It is the difference between "the payment is missing" and "here is the
 * event, here is why it failed".
 */
router.get(
  '/webhooks',
  validate(
    z.object({
      status: z.enum(['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED']).optional(),
      provider: z.string().optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const { status, provider, page, limit } = req.query as unknown as {
      status?: string
      provider?: string
      page: number
      limit: number
    }
    const filter: Record<string, unknown> = {}
    if (status) filter.status = status
    if (provider) filter.provider = provider

    const [events, total] = await Promise.all([
      WebhookEvent.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      WebhookEvent.countDocuments(filter),
    ])

    res.json({ data: events, pagination: { page, limit, total, pages: Math.ceil(total / limit) } })
  }),
)

/** Trigger reconciliation on demand rather than waiting for the schedule. */
router.post(
  '/reconcile/payments',
  asyncHandler(async (_req, res) => {
    const report = await reconcilePendingPayments({ limit: 500 })
    res.json(report)
  }),
)

router.post(
  '/reconcile/balances',
  validate(z.object({ repair: z.boolean().default(true) })),
  asyncHandler(async (req, res) => {
    const report = await reconcileBalances({ limit: 2000, repair: req.body.repair })
    res.json(report)
  }),
)

/**
 * Re-probe the payment providers.
 *
 * Run this after rotating credentials or when a provider announces a new
 * market. Bypasses the probe cache.
 */
router.post(
  '/payments/probe',
  asyncHandler(async (_req, res) => {
    clearProbeCache()
    const health = await probeAll({ force: true })
    res.json({ providers: health.all })
  }),
)

/**
 * Record that a provider now onboards merchants in a country our reference
 * table does not yet list.
 *
 * Coverage snapshots go stale between deploys. This closes the gap in minutes
 * rather than waiting for a release, the difference between a user in a newly
 * supported market signing up and giving up.
 *
 * In-memory, so it resets on restart; the durable fix is to update
 * coverage.ts. Deliberately a stopgap, and labelled as one.
 */
router.post(
  '/payments/coverage-override',
  validate(
    z.object({
      provider: z.enum(['STRIPE', 'PAYSTACK']),
      country: z.string().trim().toUpperCase().length(2),
    }),
  ),
  asyncHandler(async (req, res) => {
    addCoverageOverride(req.body.provider, req.body.country)
    res.json({
      applied: true,
      note: 'In-memory override. Update coverage.ts to make it permanent.',
      reviewedAt: COVERAGE_REVIEWED_AT,
      referenceAgeDays: coverageAgeDays(),
      referenceStale: isCoverageStale(),
    })
  }),
)

router.get(
  '/coverage-status',
  asyncHandler(async (_req, res) => {
    res.json({
      reviewedAt: COVERAGE_REVIEWED_AT,
      ageDays: coverageAgeDays(),
      stale: isCoverageStale(),
      note: isCoverageStale()
        ? 'Provider coverage data has not been reviewed recently and may understate what is available.'
        : 'Coverage data is current.',
    })
  }),
)

router.get(
  '/audit',
  validate(
    z.object({
      action: z.string().optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const { action, page, limit } = req.query as unknown as {
      action?: string
      page: number
      limit: number
    }
    const filter: Record<string, unknown> = {}
    if (action) filter.action = action

    const [logs, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      AuditLog.countDocuments(filter),
    ])

    res.json({ data: logs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } })
  }),
)

export default router
