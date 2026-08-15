import crypto from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../config/env'
import { asyncHandler } from '../../core/asyncHandler'
import { BadRequestError, NotFoundError } from '../../core/errors'
import { formatMoney } from '../../core/money'
import { param } from '../../core/params'
import { paymentLimiter, publicLimiter } from '../../middleware/rateLimit'
import { validate } from '../../middleware/validate'
import {
  Client,
  Invoice,
  InvoiceStatus,
  Organisation,
  Payment,
  PaymentMethod,
  PaymentProviderName,
  PaymentStatus,
  type IInvoice,
} from '../../models'
import { availableRails, getProvider } from '../../services/payments'
import type { ProviderId } from '../../services/payments/types'
import { TaxTreatment } from '../../services/tax/types'
import { renderInvoicePdf } from '../../services/pdf/invoice.pdf'
import { describeTaxTreatment, recordAudit, registerPublicView } from '../invoices/invoice.service'

/**
 * Public invoice pages.
 *
 * UNAUTHENTICATED BY DESIGN — the recipient of an invoice does not have an
 * account and must not need one to pay. Access is by a 256-bit opaque token in
 * the URL, which is why Invoice.publicToken is random rather than the ObjectId:
 * sequential identifiers would let anyone enumerate other people's invoices.
 *
 * Everything here is rate limited and returns only the fields needed to render
 * and pay. Internal ids, audit history and org settings are never exposed.
 */
const router = Router()

router.use(publicLimiter)

/** Strictly the fields a payer needs. Anything else is a data leak. */
function presentInvoice(
  invoice: IInvoice,
  org: {
    name: string
    logoUrl: string | null
    brandColor: string
    email: string | null
    country: string
    taxId: string | null
  },
  client: { name: string; contactName: string | null; country: string },
) {
  return {
    number: invoice.number,
    status: invoice.status,
    currency: invoice.currency,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    reference: invoice.reference,
    purchaseOrderNumber: invoice.purchaseOrderNumber,
    notes: invoice.notes,
    footer: invoice.footer,
    lines: invoice.lines.map((l) => ({
      description: l.description,
      quantityMilli: l.quantityMilli,
      unitAmountMinor: l.unitAmountMinor,
      discountBasisPoints: l.discountBasisPoints,
      netMinor: l.netMinor,
      taxMinor: l.taxMinor,
      totalMinor: l.totalMinor,
    })),
    subtotalMinor: invoice.subtotalMinor,
    discountMinor: invoice.discountMinor,
    taxMinor: invoice.taxMinor,
    totalMinor: invoice.totalMinor,
    amountPaidMinor: invoice.amountPaidMinor,
    amountDueMinor: invoice.amountDueMinor,
    taxComponents: invoice.taxSnapshot?.components ?? [],
    taxNotes: invoice.taxSnapshot?.notes ?? [],
    treatmentLabel: describeTaxTreatment(
      (invoice.taxSnapshot?.treatments ?? []) as TaxTreatment[],
    ),
    formatted: {
      subtotal: formatMoney(invoice.subtotalMinor, invoice.currency),
      discount: formatMoney(invoice.discountMinor, invoice.currency),
      tax: formatMoney(invoice.taxMinor, invoice.currency),
      total: formatMoney(invoice.totalMinor, invoice.currency),
      amountDue: formatMoney(invoice.amountDueMinor, invoice.currency),
      amountPaid: formatMoney(invoice.amountPaidMinor, invoice.currency),
    },
    supplier: {
      name: org.name,
      logoUrl: org.logoUrl,
      brandColor: org.brandColor,
      email: org.email,
      country: org.country,
      taxId: org.taxId,
    },
    customer: {
      name: client.name,
      contactName: client.contactName,
      country: client.country,
    },
  }
}

router.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const token = param(req, 'token')
    const invoice = await Invoice.findOne({ publicToken: token })
    if (!invoice) throw new NotFoundError('Invoice')

    // A draft has not been issued and must not be publicly visible even if the
    // token leaks.
    if (invoice.status === InvoiceStatus.DRAFT) throw new NotFoundError('Invoice')

    const [org, client] = await Promise.all([
      Organisation.findById(invoice.org),
      Client.findById(invoice.client),
    ])
    if (!org || !client) throw new NotFoundError('Invoice')

    // Records the first view and moves SENT -> VIEWED so the sender knows it
    // arrived. Failure here must not block rendering.
    await registerPublicView(invoice).catch(() => undefined)

    const settled = invoice.status === InvoiceStatus.VOID || invoice.amountDueMinor <= 0

    // Merchant country matters: a gateway only settles if it onboards
    // businesses where the SUPPLIER is registered.
    const rails = settled
      ? []
      : availableRails(invoice.currency, client.country, org.country)

    const instructions = org.paymentInstructions
    // The universal fallback. Shown whenever the business has filled it in,
    // and it is the ONLY option for businesses in countries no gateway serves.
    const bankTransfer =
      !settled && instructions?.enabled
        ? {
            accountName: instructions.accountName,
            bankName: instructions.bankName,
            accountNumber: instructions.accountNumber,
            routingCode: instructions.routingCode,
            swiftBic: instructions.swiftBic,
            mobileMoneyNumber: instructions.mobileMoneyNumber,
            mobileMoneyProvider: instructions.mobileMoneyProvider,
            additionalDetails: instructions.additionalDetails,
            // Give the payer a reference so the supplier can reconcile.
            reference: invoice.number,
          }
        : null

    res.json({
      invoice: presentInvoice(invoice, org, client),
      payment: {
        rails,
        bankTransfer,
        // Publishable keys only. Secrets never reach the browser.
        stripePublishableKey: env.STRIPE_PUBLISHABLE_KEY ?? null,
        paystackPublicKey: env.PAYSTACK_PUBLIC_KEY ?? null,
      },
    })
  }),
)

/**
 * Public PDF download.
 *
 * The recipient needs a copy for their own records and has no account, so this
 * is reachable with the invoice token alone — the same secret that already
 * grants sight of the invoice.
 */
router.get(
  '/:token/pdf',
  asyncHandler(async (req, res) => {
    const token = param(req, 'token')
    const invoice = await Invoice.findOne({ publicToken: token })
    if (!invoice) throw new NotFoundError('Invoice')
    if (invoice.status === InvoiceStatus.DRAFT) throw new NotFoundError('Invoice')

    const [org, client] = await Promise.all([
      Organisation.findById(invoice.org),
      Client.findById(invoice.client),
    ])
    if (!org || !client) throw new NotFoundError('Invoice')

    const pdf = await renderInvoicePdf({
      invoice,
      organisation: org,
      client,
      payUrl: `${env.APP_URL}/pay/${token}`,
    })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${invoice.number.replace(/[^\w.-]/g, '_')}.pdf"`,
    )
    res.send(pdf)
  }),
)

const checkoutSchema = z.object({
  providerId: z.enum(['STRIPE', 'PAYSTACK']),
  /** Optional partial payment. Defaults to the full outstanding balance. */
  amountMinor: z.number().int().positive().optional(),
  mobileMoney: z
    .object({
      phone: z.string().trim().min(6).max(20),
      provider: z.enum(['mtn', 'vod', 'atl', 'mpesa']),
    })
    .nullish(),
})

/**
 * Start a payment.
 *
 * The AMOUNT IS COMPUTED SERVER-SIDE from the invoice balance and is never
 * taken from the request except as a capped partial payment. A client that
 * posts `amountMinor: 1` for a 1,200.00 invoice can only underpay itself — it
 * can never cause us to request less from the gateway than we record, because
 * both come from the same server-side value.
 */
router.post(
  '/:token/checkout',
  paymentLimiter,
  validate(checkoutSchema),
  asyncHandler(async (req, res) => {
    const token = param(req, 'token')
    const invoice = await Invoice.findOne({ publicToken: token })
    if (!invoice) throw new NotFoundError('Invoice')

    if (invoice.status === InvoiceStatus.DRAFT) throw new NotFoundError('Invoice')
    if (invoice.status === InvoiceStatus.VOID) {
      throw new BadRequestError('This invoice has been cancelled')
    }
    if (invoice.amountDueMinor <= 0) {
      throw new BadRequestError('This invoice is already paid in full')
    }

    const [org, client] = await Promise.all([
      Organisation.findById(invoice.org),
      Client.findById(invoice.client),
    ])
    if (!org || !client) throw new NotFoundError('Invoice')

    const requested = req.body.amountMinor ?? invoice.amountDueMinor
    if (requested > invoice.amountDueMinor) {
      throw new BadRequestError('That is more than the outstanding balance')
    }

    const providerId = req.body.providerId as ProviderId
    const provider = getProvider(providerId)
    if (!provider.isConfigured() || !provider.supports(invoice.currency, client.country)) {
      throw new BadRequestError('That payment method is not available for this invoice')
    }

    // Our reference, embedded in the provider transaction so webhooks correlate.
    const reference = `mrd_${crypto.randomBytes(12).toString('hex')}`
    const idempotencyKey = crypto.randomUUID()

    const payment = await Payment.create({
      org: invoice.org,
      invoice: invoice._id,
      provider: providerId as unknown as PaymentProviderName,
      status: PaymentStatus.PENDING,
      method: req.body.mobileMoney ? PaymentMethod.MOBILE_MONEY : PaymentMethod.CARD,
      amountMinor: requested,
      currency: invoice.currency,
      idempotencyKey,
      providerReference: reference,
    })

    try {
      const checkout = await provider.createCheckout({
        amountMinor: requested,
        currency: invoice.currency,
        reference,
        idempotencyKey,
        customerEmail: client.email ?? org.email ?? 'billing@taxpedestal.app',
        customerName: client.name,
        description: `Invoice ${invoice.number} — ${org.name}`,
        returnUrl: `${env.APP_URL}/pay/${token}`,
        metadata: {
          invoiceId: invoice._id.toString(),
          invoiceNumber: invoice.number,
          orgId: invoice.org.toString(),
        },
        mobileMoney: req.body.mobileMoney ?? null,
      })

      // The provider may substitute its own reference (Stripe PaymentIntent id).
      if (checkout.providerReference !== reference) {
        payment.providerReference = checkout.providerReference
      }
      payment.method = checkout.method
      if (checkout.action === 'otp') payment.status = PaymentStatus.AWAITING_CUSTOMER
      await payment.save()

      await recordAudit({
        org: invoice.org,
        actor: null,
        actorLabel: 'public payment page',
        action: 'payment.initiated',
        entityType: 'Payment',
        entityId: payment._id.toString(),
        changes: { amountMinor: requested, provider: providerId },
        ip: req.ip,
        requestId: req.requestId,
      })

      res.status(201).json({
        action: checkout.action,
        redirectUrl: checkout.redirectUrl ?? null,
        clientSecret: checkout.clientSecret ?? null,
        instruction: checkout.instruction ?? null,
        reference: payment.providerReference,
        amountMinor: requested,
        formattedAmount: formatMoney(requested, invoice.currency),
      })
    } catch (error) {
      payment.status = PaymentStatus.FAILED
      payment.failureMessage = error instanceof Error ? error.message : String(error)
      await payment.save().catch(() => undefined)
      throw error
    }
  }),
)

/**
 * Poll a payment's status.
 *
 * Mobile money completes asynchronously: the customer approves a prompt on
 * their handset and the result arrives by webhook. The browser polls this while
 * showing "waiting for approval". Reads our own record only — it does not hit
 * the provider, so polling cannot be used to hammer their API.
 */
router.get(
  '/:token/payments/:reference',
  asyncHandler(async (req, res) => {
    const token = param(req, 'token')
    const reference = param(req, 'reference')

    const invoice = await Invoice.findOne({ publicToken: token })
    if (!invoice) throw new NotFoundError('Invoice')

    const payment = await Payment.findOne({
      invoice: invoice._id,
      providerReference: reference,
    })
    if (!payment) throw new NotFoundError('Payment')

    res.json({
      status: payment.status,
      amountMinor: payment.amountMinor,
      failureMessage: payment.failureMessage,
      invoiceStatus: invoice.status,
      amountDueMinor: invoice.amountDueMinor,
      formattedAmountDue: formatMoney(invoice.amountDueMinor, invoice.currency),
    })
  }),
)

/**
 * Download the invoice PDF from the public payment page.
 *
 * Same token gate as viewing it — a customer who can see the invoice can keep
 * a copy, which is what they need for their own bookkeeping.
 */
router.get(
  '/:token/pdf',
  asyncHandler(async (req, res) => {
    const token = param(req, 'token')
    const invoice = await Invoice.findOne({ publicToken: token })
    if (!invoice) throw new NotFoundError('Invoice')
    if (invoice.status === InvoiceStatus.DRAFT) throw new NotFoundError('Invoice')

    const [organisation, client] = await Promise.all([
      Organisation.findById(invoice.org),
      Client.findById(invoice.client),
    ])
    if (!organisation || !client) throw new NotFoundError('Invoice')

    const { renderInvoicePdf } = await import('../../services/pdf/invoice.pdf')
    const pdf = await renderInvoicePdf({ invoice, organisation, client })

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Length', pdf.length)
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.number}.pdf"`)
    res.send(pdf)
  }),
)

/**
 * Customer declares that they have paid by bank transfer.
 *
 * Creates a PENDING payment for the supplier to confirm. It deliberately does
 * NOT credit the invoice: an unauthenticated caller must never be able to mark
 * an invoice paid, or anyone with the link could clear their own debt. The
 * ledger entry is written only when the supplier confirms receipt.
 *
 * What this does buy is the thing that actually matters operationally — the
 * supplier is told money is coming, with a reference to match against their
 * bank statement.
 */
router.post(
  '/:token/declare-transfer',
  paymentLimiter,
  validate(
    z.object({
      amountMinor: z.number().int().positive().optional(),
      note: z.string().trim().max(300).optional(),
      paidAt: z.string().datetime().or(z.string().date()).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const token = param(req, 'token')
    const invoice = await Invoice.findOne({ publicToken: token })
    if (!invoice) throw new NotFoundError('Invoice')
    if (invoice.status === InvoiceStatus.DRAFT) throw new NotFoundError('Invoice')
    if (invoice.status === InvoiceStatus.VOID) {
      throw new BadRequestError('This invoice has been cancelled')
    }
    if (invoice.amountDueMinor <= 0) {
      throw new BadRequestError('This invoice is already paid in full')
    }

    const amount = req.body.amountMinor ?? invoice.amountDueMinor
    if (amount > invoice.amountDueMinor) {
      throw new BadRequestError('That is more than the outstanding balance')
    }

    // One open declaration at a time, so a customer refreshing the page does
    // not create a queue of duplicates for the supplier to sift through.
    const existing = await Payment.findOne({
      invoice: invoice._id,
      provider: PaymentProviderName.MANUAL,
      status: PaymentStatus.PENDING,
    })
    if (existing) {
      res.json({
        declared: true,
        alreadyDeclared: true,
        message: 'Thanks — this transfer is already awaiting confirmation.',
      })
      return
    }

    const payment = await Payment.create({
      org: invoice.org,
      invoice: invoice._id,
      provider: PaymentProviderName.MANUAL,
      // PENDING, not SUCCEEDED. The supplier is the only party who can confirm
      // that money actually arrived.
      status: PaymentStatus.PENDING,
      method: PaymentMethod.BANK_TRANSFER,
      amountMinor: amount,
      currency: invoice.currency,
      idempotencyKey: `declared:${invoice._id.toString()}:${Date.now()}`,
      note: req.body.note ?? 'Customer declared a bank transfer',
      paidAt: req.body.paidAt ? new Date(req.body.paidAt) : null,
    })

    await recordAudit({
      org: invoice.org,
      actor: null,
      actorLabel: 'customer (public page)',
      action: 'payment.declared',
      entityType: 'Payment',
      entityId: payment._id.toString(),
      changes: { amountMinor: amount, invoiceNumber: invoice.number },
      ip: req.ip,
      requestId: req.requestId,
    })

    res.status(201).json({
      declared: true,
      alreadyDeclared: false,
      message:
        'Thanks. We have told the sender to expect your transfer — they will confirm once it arrives.',
    })
  }),
)

export default router
