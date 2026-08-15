import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../../core/asyncHandler'
import { NotFoundError } from '../../core/errors'
import { isValidCountry } from '../../core/countries'
import { SUPPORTED_CURRENCY_CODES } from '../../core/money'
import { actorId, objectIdParam } from '../../core/params'
import { requireAuth, requireOrg, requireRole, scoped } from '../../middleware/auth'
import { idempotency } from '../../middleware/idempotency'
import { validate } from '../../middleware/validate'
import { Client, Invoice, OrgRole, InvoiceStatus } from '../../models'
import { recordAudit } from '../invoices/invoice.service'

const router = Router()
router.use(requireAuth, requireOrg)

const clientBody = z.object({
  name: z.string().trim().min(1, 'A client needs a name').max(180),
  email: z.string().trim().toLowerCase().email().nullish(),
  phone: z.string().trim().max(40).nullish(),
  contactName: z.string().trim().max(120).nullish(),
  country: z.string().trim().toUpperCase().length(2).refine(isValidCountry, 'Unknown country code'),
  region: z.string().trim().toUpperCase().max(10).nullish(),
  city: z.string().trim().max(120).nullish(),
  addressLine1: z.string().trim().max(200).nullish(),
  addressLine2: z.string().trim().max(200).nullish(),
  postalCode: z.string().trim().max(30).nullish(),
  isBusiness: z.boolean().default(true),
  taxId: z.string().trim().max(60).nullish(),
  taxRegistered: z.boolean().default(false),
  defaultCurrency: z.string().trim().toUpperCase().refine((c) => SUPPORTED_CURRENCY_CODES.includes(c)),
  paymentTermsDays: z.number().int().min(0).max(365).nullish(),
  notes: z.string().max(2000).nullish(),
  tags: z.array(z.string().trim().max(40)).max(20).default([]),
})

const listQuery = z.object({
  search: z.string().trim().max(120).optional(),
  includeArchived: z.enum(['true', 'false']).default('false'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

router.get(
  '/',
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { search, includeArchived, page, limit } = req.query as unknown as z.infer<typeof listQuery>

    // Tenant scope is applied from verified membership, never from user input.
    const filter: Record<string, unknown> = { ...scoped(req) }
    if (includeArchived === 'false') filter.archivedAt = null
    if (search) filter.name = { $regex: escapeRegex(search), $options: 'i' }

    const [clients, total] = await Promise.all([
      Client.find(filter).sort({ name: 1 }).skip((page - 1) * limit).limit(limit),
      Client.countDocuments(filter),
    ])

    res.json({
      data: clients,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  }),
)

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const client = await Client.findOne({ _id: objectIdParam(req, 'id', 'Client'), ...scoped(req) })
    if (!client) throw new NotFoundError('Client')

    // Lightweight summary so the client detail page is one request.
    const [invoiceCount, outstanding] = await Promise.all([
      Invoice.countDocuments({ client: client._id, ...scoped(req) }),
      Invoice.aggregate<{ total: number }>([
        {
          $match: {
            client: client._id,
            org: req.org!.id,
            status: { $nin: [InvoiceStatus.DRAFT, InvoiceStatus.VOID, InvoiceStatus.PAID] },
          },
        },
        { $group: { _id: null, total: { $sum: '$amountDueMinor' } } },
      ]),
    ])

    res.json({
      client,
      summary: {
        invoiceCount,
        outstandingMinor: outstanding[0]?.total ?? 0,
      },
    })
  }),
)

router.post(
  '/',
  requireRole(OrgRole.MEMBER),
  idempotency,
  validate(clientBody),
  asyncHandler(async (req, res) => {
    const client = await Client.create({
      ...req.body,
      org: req.org!.id,
      createdBy: actorId(req),
    })

    await recordAudit({
      org: req.org!.id,
      actor: actorId(req),
      action: 'client.created',
      entityType: 'Client',
      entityId: client._id.toString(),
      changes: { name: client.name },
      requestId: req.requestId,
    })

    res.status(201).json(client)
  }),
)

router.patch(
  '/:id',
  requireRole(OrgRole.MEMBER),
  validate(clientBody.partial()),
  asyncHandler(async (req, res) => {
    const client = await Client.findOneAndUpdate(
      { _id: objectIdParam(req, 'id', 'Client'), ...scoped(req) },
      { $set: req.body },
      { new: true, runValidators: true },
    )
    if (!client) throw new NotFoundError('Client')

    await recordAudit({
      org: req.org!.id,
      actor: actorId(req),
      action: 'client.updated',
      entityType: 'Client',
      entityId: client._id.toString(),
      changes: req.body,
      requestId: req.requestId,
    })

    res.json(client)
  }),
)

/**
 * Archive rather than delete.
 *
 * A client referenced by issued invoices cannot be removed without orphaning
 * financial records, so deletion is not offered at all, archiving hides them
 * from pickers while keeping history intact.
 */
router.post(
  '/:id/archive',
  requireRole(OrgRole.ADMIN),
  asyncHandler(async (req, res) => {
    const client = await Client.findOneAndUpdate(
      { _id: objectIdParam(req, 'id', 'Client'), ...scoped(req) },
      { $set: { archivedAt: new Date() } },
      { new: true },
    )
    if (!client) throw new NotFoundError('Client')
    res.json(client)
  }),
)

router.post(
  '/:id/restore',
  requireRole(OrgRole.ADMIN),
  asyncHandler(async (req, res) => {
    const client = await Client.findOneAndUpdate(
      { _id: objectIdParam(req, 'id', 'Client'), ...scoped(req) },
      { $set: { archivedAt: null } },
      { new: true },
    )
    if (!client) throw new NotFoundError('Client')
    res.json(client)
  }),
)

/** Escape user input before it reaches a regex, or a search term is a ReDoS. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export default router
