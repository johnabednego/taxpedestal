import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../../core/asyncHandler'
import { BadRequestError, NotFoundError } from '../../core/errors'
import { SUPPORTED_CURRENCY_CODES, formatMoney } from '../../core/money'
import { actorId, objectIdParam } from '../../core/params'
import { requireAuth, requireOrg, requireRole, scoped } from '../../middleware/auth'
import { idempotency } from '../../middleware/idempotency'
import { validate } from '../../middleware/validate'
import {
  Client,
  Invoice,
  InvoiceStatus,
  LedgerEntryType,
  OrgRole,
  Organisation,
  Payment,
  PaymentMethod,
  PaymentProviderName,
  PaymentStatus,
} from '../../models'
import { TaxTreatment } from '../../services/tax/types'
import {
  applyPayment,
  createDraft,
  describeTaxTreatment,
  issueAndSend,
  publicInvoiceUrl,
  recordAudit,
  updateDraft,
  voidInvoice,
} from './invoice.service'
import { checkInvoiceCompliance } from '../../services/documents/requirements'
import { renderInvoicePdf } from '../../services/pdf/invoice.pdf'
import { auditInvoiceBalance, entryHistory } from './ledger.service'
import { priceInvoice } from './pricing'

const router = Router()
router.use(requireAuth, requireOrg)

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

const lineSchema = z.object({
  description: z.string().trim().min(1, 'Describe what you are billing for').max(500),
  // Quantity in thousandths so 1.5 hours is 1500, never a float.
  quantityMilli: z.number().int().min(0).max(1_000_000_000),
  // Minor units, integer. See core/money.ts for why floats are refused.
  unitAmountMinor: z.number().int().min(-100_000_000_000).max(100_000_000_000),
  discountBasisPoints: z.number().int().min(0).max(10_000).default(0),
  supplyType: z.enum(['goods', 'services', 'digital_services']).default('services'),
  taxTreatmentOverride: z
    .enum([TaxTreatment.ZERO_RATED, TaxTreatment.EXEMPT])
    .nullish(),
})

const draftSchema = z.object({
  clientId: z.string().min(1),
  currency: z.string().trim().toUpperCase().refine((c) => SUPPORTED_CURRENCY_CODES.includes(c)).optional(),
  issueDate: z.string().datetime().or(z.string().date()).optional(),
  dueDate: z.string().datetime().or(z.string().date()).optional(),
  lines: z.array(lineSchema).min(1, 'Add at least one line').max(200),
  discountBasisPoints: z.number().int().min(0).max(10_000).default(0),
  reference: z.string().trim().max(140).nullish(),
  notes: z.string().max(4000).nullish(),
  footer: z.string().max(1000).nullish(),
  purchaseOrderNumber: z.string().trim().max(100).nullish(),
})

const listQuery = z.object({
  status: z.string().optional(),
  clientId: z.string().optional(),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['issueDate', 'dueDate', 'totalMinor', 'number']).default('issueDate'),
  order: z.enum(['asc', 'desc']).default('desc'),
})

const manualPaymentSchema = z.object({
  amountMinor: z.number().int().positive('A payment must be greater than zero'),
  method: z.nativeEnum(PaymentMethod).default(PaymentMethod.BANK_TRANSFER),
  paidAt: z.string().datetime().or(z.string().date()).optional(),
  note: z.string().max(1000).nullish(),
})

/* -------------------------------------------------------------------------- */
/* Live tax preview, powers the invoice builder and the marketing page        */
/* -------------------------------------------------------------------------- */

/**
 * Price an invoice WITHOUT persisting it.
 *
 * The builder calls this on every edit so the customer sees correct tax before
 * committing. Sharing the exact pricing function with creation means the
 * preview can never disagree with the saved invoice, a class of bug that
 * plagues invoicing tools where the UI recomputes totals in its own JavaScript.
 */
router.post(
  '/preview',
  validate(
    z.object({
      clientId: z.string().optional(),
      // Allow an ad-hoc counterparty so the preview works before a client exists.
      customer: z
        .object({
          country: z.string().trim().toUpperCase().length(2),
          region: z.string().trim().toUpperCase().max(10).nullish(),
          isBusiness: z.boolean().default(true),
          taxId: z.string().trim().max(60).nullish(),
          taxRegistered: z.boolean().default(false),
        })
        .optional(),
      currency: z.string().trim().toUpperCase().refine((c) => SUPPORTED_CURRENCY_CODES.includes(c)),
      issueDate: z.string().datetime().or(z.string().date()).optional(),
      lines: z.array(lineSchema).max(200),
      discountBasisPoints: z.number().int().min(0).max(10_000).default(0),
    }),
  ),
  asyncHandler(async (req, res) => {
    const org = await Organisation.findById(req.org!.id)
    if (!org) throw new NotFoundError('Workspace')

    let customer = req.body.customer
    if (req.body.clientId) {
      const client = await Client.findOne({ _id: req.body.clientId, ...scoped(req) })
      if (!client) throw new NotFoundError('Client')
      customer = {
        country: client.country,
        region: client.region,
        isBusiness: client.isBusiness,
        taxId: client.taxId,
        taxRegistered: client.taxRegistered,
      }
    }
    if (!customer) throw new BadRequestError('Provide either a clientId or customer details')

    const priced = priceInvoice(req.body.lines, {
      supplier: {
        country: org.country,
        region: org.region,
        taxRegistered: org.taxRegistered,
        taxId: org.taxId,
      },
      customer: {
        country: customer.country,
        region: customer.region ?? null,
        taxRegistered: customer.taxRegistered ?? false,
        taxId: customer.taxId ?? null,
        isBusiness: customer.isBusiness ?? true,
      },
      currency: req.body.currency,
      issueDate: req.body.issueDate ? new Date(req.body.issueDate) : new Date(),
      discountBasisPoints: req.body.discountBasisPoints,
      customTaxProfile: org.customTaxProfile ?? null,
    })

    res.json({
      ...priced,
      treatmentLabel: describeTaxTreatment(priced.taxTreatments),
      formatted: {
        subtotal: formatMoney(priced.subtotalMinor, req.body.currency),
        discount: formatMoney(priced.discountMinor, req.body.currency),
        tax: formatMoney(priced.taxMinor, req.body.currency),
        total: formatMoney(priced.totalMinor, req.body.currency),
      },
    })
  }),
)

/* -------------------------------------------------------------------------- */
/* CRUD                                                                        */
/* -------------------------------------------------------------------------- */

router.get(
  '/',
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>
    const filter: Record<string, unknown> = { ...scoped(req) }

    if (q.status) {
      const statuses = q.status.split(',').filter((s) => s in InvoiceStatus)
      if (statuses.length > 0) filter.status = { $in: statuses }
    }
    if (q.clientId) filter.client = q.clientId
    if (q.search) {
      filter.$or = [
        { number: { $regex: escapeRegex(q.search), $options: 'i' } },
        { reference: { $regex: escapeRegex(q.search), $options: 'i' } },
      ]
    }

    const [invoices, total] = await Promise.all([
      Invoice.find(filter)
        .sort({ [q.sort]: q.order === 'asc' ? 1 : -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit)
        .populate('client', 'name email country'),
      Invoice.countDocuments(filter),
    ])

    res.json({
      data: invoices,
      pagination: { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) },
    })
  }),
)

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const invoice = await Invoice.findOne({
      _id: objectIdParam(req, 'id', 'Invoice'),
      ...scoped(req),
    }).populate('client')
    if (!invoice) throw new NotFoundError('Invoice')

    const [payments, ledger] = await Promise.all([
      Payment.find({ invoice: invoice._id }).sort({ createdAt: -1 }),
      entryHistory(invoice._id),
    ])

    // Compliance is advisory and computed on read, so a rule added after the
    // invoice was created still surfaces.
    const org = await Organisation.findById(invoice.org)
    const clientDoc = await Client.findById(invoice.client)
    const compliance =
      org && clientDoc ? checkInvoiceCompliance(invoice, org, clientDoc) : null

    res.json({
      invoice,
      payments,
      ledger,
      compliance,
      publicUrl: publicInvoiceUrl(invoice.publicToken),
      treatmentLabel: describeTaxTreatment(
        (invoice.taxSnapshot?.treatments ?? []) as TaxTreatment[],
      ),
    })
  }),
)

router.post(
  '/',
  requireRole(OrgRole.MEMBER),
  idempotency,
  validate(draftSchema),
  asyncHandler(async (req, res) => {
    const invoice = await createDraft(req.org!.id, actorId(req), req.body)
    res.status(201).json(invoice)
  }),
)

router.patch(
  '/:id',
  requireRole(OrgRole.MEMBER),
  validate(draftSchema.partial()),
  asyncHandler(async (req, res) => {
    const invoice = await updateDraft(
      req.org!.id,
      actorId(req),
      objectIdParam(req, 'id', 'Invoice').toString(),
      req.body,
    )
    res.json(invoice)
  }),
)

/** Only drafts can be deleted; issued invoices are voided instead. */
router.delete(
  '/:id',
  requireRole(OrgRole.ADMIN),
  asyncHandler(async (req, res) => {
    const invoice = await Invoice.findOne({
      _id: objectIdParam(req, 'id', 'Invoice'),
      ...scoped(req),
    })
    if (!invoice) throw new NotFoundError('Invoice')
    if (invoice.status !== InvoiceStatus.DRAFT) {
      throw new BadRequestError(
        `Invoice ${invoice.number} has been issued. Void it instead of deleting it.`,
      )
    }

    await Invoice.deleteOne({ _id: invoice._id })
    await recordAudit({
      org: req.org!.id,
      actor: actorId(req),
      action: 'invoice.draft_deleted',
      entityType: 'Invoice',
      entityId: invoice._id.toString(),
      changes: { number: invoice.number },
      requestId: req.requestId,
    })

    res.status(204).send()
  }),
)

/* -------------------------------------------------------------------------- */
/* Lifecycle actions                                                           */
/* -------------------------------------------------------------------------- */

router.post(
  '/:id/send',
  requireRole(OrgRole.MEMBER),
  idempotency,
  validate(z.object({ sendEmail: z.boolean().default(true) })),
  asyncHandler(async (req, res) => {
    const invoice = await issueAndSend(
      req.org!.id,
      actorId(req),
      objectIdParam(req, 'id', 'Invoice').toString(),
      { sendEmail: req.body.sendEmail },
    )
    res.json({ invoice, publicUrl: publicInvoiceUrl(invoice.publicToken) })
  }),
)

router.post(
  '/:id/void',
  requireRole(OrgRole.ADMIN),
  validate(z.object({ reason: z.string().trim().min(3, 'Give a reason').max(500) })),
  asyncHandler(async (req, res) => {
    const invoice = await voidInvoice(
      req.org!.id,
      actorId(req),
      objectIdParam(req, 'id', 'Invoice').toString(),
      req.body.reason,
    )
    res.json(invoice)
  }),
)

/**
 * Record a payment received outside the platform.
 *
 * Goes through the SAME ledger path as gateway payments, so cash and card
 * behave identically for reporting and audit, there is no second code path
 * that skips the ledger.
 */
router.post(
  '/:id/payments',
  requireRole(OrgRole.MEMBER),
  idempotency,
  validate(manualPaymentSchema),
  asyncHandler(async (req, res) => {
    const invoice = await Invoice.findOne({
      _id: objectIdParam(req, 'id', 'Invoice'),
      ...scoped(req),
    })
    if (!invoice) throw new NotFoundError('Invoice')
    if (invoice.status === InvoiceStatus.DRAFT) {
      throw new BadRequestError('Send the invoice before recording a payment against it')
    }
    if (invoice.status === InvoiceStatus.VOID) {
      throw new BadRequestError('This invoice has been voided')
    }

    const payment = await Payment.create({
      org: req.org!.id,
      invoice: invoice._id,
      provider: PaymentProviderName.MANUAL,
      status: PaymentStatus.SUCCEEDED,
      method: req.body.method,
      amountMinor: req.body.amountMinor,
      currency: invoice.currency,
      idempotencyKey: `manual:${invoice._id.toString()}:${Date.now()}`,
      paidAt: req.body.paidAt ? new Date(req.body.paidAt) : new Date(),
      recordedBy: actorId(req),
      note: req.body.note ?? null,
    })

    await applyPayment(invoice, req.body.amountMinor, {
      actor: actorId(req),
      source: 'manual',
      paymentId: payment._id,
      idempotencyKey: `payment:${payment._id.toString()}`,
      description: `Manual payment (${req.body.method})`,
    })

    const updated = await Invoice.findById(invoice._id)
    res.status(201).json({ payment, invoice: updated })
  }),
)

/**
 * Confirm a bank transfer the customer declared.
 *
 * This is where a declared payment becomes real money in the ledger. Separating
 * declaration from confirmation is the whole point: the customer says "I sent
 * it", the supplier checks their bank, and only then is the invoice credited.
 */
router.post(
  '/:id/payments/:paymentId/confirm',
  requireRole(OrgRole.MEMBER),
  idempotency,
  validate(z.object({ amountMinor: z.number().int().positive().optional() })),
  asyncHandler(async (req, res) => {
    const invoice = await Invoice.findOne({
      _id: objectIdParam(req, 'id', 'Invoice'),
      ...scoped(req),
    })
    if (!invoice) throw new NotFoundError('Invoice')

    const payment = await Payment.findOne({
      _id: objectIdParam(req, 'paymentId', 'Payment'),
      invoice: invoice._id,
      ...scoped(req),
    })
    if (!payment) throw new NotFoundError('Payment')
    if (payment.status === PaymentStatus.SUCCEEDED) {
      throw new BadRequestError('That payment has already been confirmed')
    }
    if (payment.provider !== PaymentProviderName.MANUAL) {
      throw new BadRequestError(
        'Gateway payments are confirmed automatically and cannot be confirmed by hand',
      )
    }

    const amount = req.body.amountMinor ?? payment.amountMinor
    payment.status = PaymentStatus.SUCCEEDED
    payment.amountMinor = amount
    payment.paidAt = payment.paidAt ?? new Date()
    payment.recordedBy = actorId(req)
    await payment.save()

    await applyPayment(invoice, amount, {
      actor: actorId(req),
      source: 'bank-transfer-confirmed',
      paymentId: payment._id,
      idempotencyKey: `payment:${payment._id.toString()}`,
      description: 'Bank transfer confirmed by the supplier',
    })

    const updated = await Invoice.findById(invoice._id)
    res.json({ payment, invoice: updated })
  }),
)

/** Reject a declared transfer that never arrived. */
router.post(
  '/:id/payments/:paymentId/reject',
  requireRole(OrgRole.MEMBER),
  validate(z.object({ reason: z.string().trim().max(300).optional() })),
  asyncHandler(async (req, res) => {
    const payment = await Payment.findOne({
      _id: objectIdParam(req, 'paymentId', 'Payment'),
      invoice: objectIdParam(req, 'id', 'Invoice'),
      ...scoped(req),
    })
    if (!payment) throw new NotFoundError('Payment')
    if (payment.status === PaymentStatus.SUCCEEDED) {
      throw new BadRequestError('That payment has already been confirmed')
    }

    payment.status = PaymentStatus.FAILED
    payment.failureCode = 'NOT_RECEIVED'
    payment.failureMessage = req.body.reason ?? 'Supplier did not receive this transfer'
    await payment.save()

    res.json(payment)
  }),
)

/** Resend the invoice email without changing state. */
router.post(
  '/:id/remind',
  requireRole(OrgRole.MEMBER),
  asyncHandler(async (req, res) => {
    const invoice = await Invoice.findOne({
      _id: objectIdParam(req, 'id', 'Invoice'),
      ...scoped(req),
    })
    if (!invoice) throw new NotFoundError('Invoice')
    if (invoice.status === InvoiceStatus.DRAFT) {
      throw new BadRequestError('Send the invoice before reminding')
    }

    const { sendReminder } = await import('../../jobs/reminders')
    const sent = await sendReminder(invoice, 'manual')

    res.json({ sent, reminderCount: invoice.reminderCount })
  }),
)

/** Download the invoice as a PDF. */
router.get(
  '/:id/pdf',
  asyncHandler(async (req, res) => {
    const invoice = await Invoice.findOne({
      _id: objectIdParam(req, 'id', 'Invoice'),
      ...scoped(req),
    })
    if (!invoice) throw new NotFoundError('Invoice')

    const [organisation, client] = await Promise.all([
      Organisation.findById(invoice.org),
      Client.findById(invoice.client),
    ])
    if (!organisation || !client) throw new NotFoundError('Invoice')

    const { renderInvoicePdf } = await import('../../services/pdf/invoice.pdf')
    const pdf = await renderInvoicePdf({ invoice, organisation, client })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Length', pdf.length)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${invoice.number}.pdf"`,
    )
    res.send(pdf)
  }),
)

/**
 * Download the invoice as a PDF.
 *
 * Streamed with an explicit filename so browsers save something meaningful
 * rather than "download.pdf".
 */
router.get(
  '/:id/pdf',
  asyncHandler(async (req, res) => {
    const invoice = await Invoice.findOne({
      _id: objectIdParam(req, 'id', 'Invoice'),
      ...scoped(req),
    })
    if (!invoice) throw new NotFoundError('Invoice')

    const [org, client] = await Promise.all([
      Organisation.findById(invoice.org),
      Client.findById(invoice.client),
    ])
    if (!org || !client) throw new NotFoundError('Invoice')

    const pdf = await renderInvoicePdf({
      invoice,
      organisation: org,
      client,
      payUrl: invoice.status === 'DRAFT' ? null : publicInvoiceUrl(invoice.publicToken),
    })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${invoice.number.replace(/[^\w.-]/g, '_')}.pdf"`,
    )
    res.setHeader('Content-Length', pdf.length)
    res.send(pdf)
  }),
)

/** Ledger view: every movement of money, with the derived-vs-cached audit. */
router.get(
  '/:id/ledger',
  asyncHandler(async (req, res) => {
    const invoice = await Invoice.findOne({
      _id: objectIdParam(req, 'id', 'Invoice'),
      ...scoped(req),
    })
    if (!invoice) throw new NotFoundError('Invoice')

    const [entries, audit] = await Promise.all([
      entryHistory(invoice._id),
      auditInvoiceBalance(invoice),
    ])

    res.json({
      entries: entries.map((e) => ({
        id: e._id.toString(),
        type: e.type,
        amountMinor: e.amountMinor,
        formatted: formatMoney(e.amountMinor, e.currency),
        description: e.description,
        actorLabel: e.actorLabel,
        reverses: e.reverses?.toString() ?? null,
        effectiveAt: e.effectiveAt,
        createdAt: e.createdAt,
      })),
      audit,
      types: Object.values(LedgerEntryType),
    })
  }),
)

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export default router
