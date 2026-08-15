import crypto from 'node:crypto'
import dayjs from 'dayjs'
import { Types } from 'mongoose'
import { env } from '../../config/env'
import { logger } from '../../core/logger'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../core/errors'
import { formatMoney } from '../../core/money'
import {
  AuditLog,
  Client,
  Invoice,
  InvoiceStatus,
  LedgerEntryType,
  Organisation,
  canTransition,
  nextSequence,
  type IInvoice,
  type IOrganisation,
} from '../../models'
import { sendEmail } from '../../services/email'
import { TaxTreatment } from '../../services/tax/types'
import { postEntry } from './ledger.service'
import { outstanding, priceInvoice, type PricingLineInput } from './pricing'

/**
 * Invoice service.
 *
 * Holds the rules that must not be duplicated in controllers: who may edit
 * what, which transitions are legal, how a number is allocated, and how a
 * payment updates state.
 */

export interface InvoiceDraftInput {
  clientId: string
  currency?: string
  issueDate?: string | Date
  dueDate?: string | Date
  lines: PricingLineInput[]
  discountBasisPoints?: number
  reference?: string | null
  notes?: string | null
  footer?: string | null
  purchaseOrderNumber?: string | null
}

/** 32 bytes base64url — 256 bits of entropy for the public payment URL. */
function generatePublicToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function formatInvoiceNumber(org: IOrganisation, sequence: number): string {
  return `${org.invoicePrefix}-${String(sequence).padStart(org.invoiceNumberPadding, '0')}`
}

/**
 * Assemble the tax parties from the organisation and client records.
 *
 * Extracted because both creation and re-pricing need identical inputs — if
 * these diverged, an edit could silently change the tax on an invoice.
 */
function buildTaxParties(org: IOrganisation, client: { country: string; region?: string | null; isBusiness: boolean; taxId?: string | null; taxRegistered: boolean }) {
  return {
    supplier: {
      country: org.country,
      region: org.region,
      taxRegistered: org.taxRegistered,
      taxId: org.taxId,
    },
    customer: {
      country: client.country,
      region: client.region ?? null,
      taxRegistered: client.taxRegistered,
      taxId: client.taxId ?? null,
      isBusiness: client.isBusiness,
    },
  }
}

export async function createDraft(
  orgId: Types.ObjectId,
  userId: Types.ObjectId,
  input: InvoiceDraftInput,
): Promise<IInvoice> {
  const org = await Organisation.findById(orgId)
  if (!org) throw new NotFoundError('Workspace')

  if (!Types.ObjectId.isValid(input.clientId)) throw new NotFoundError('Client')
  // Tenant-scoped lookup: a client id from another workspace must 404.
  const client = await Client.findOne({ _id: input.clientId, org: orgId })
  if (!client) throw new NotFoundError('Client')
  if (client.archivedAt) {
    throw new BadRequestError('That client is archived. Restore it before invoicing.')
  }

  if (input.lines.length === 0) {
    throw new BadRequestError('An invoice needs at least one line')
  }

  const currency = (input.currency ?? client.defaultCurrency ?? org.baseCurrency).toUpperCase()
  const issueDate = input.issueDate ? dayjs(input.issueDate).toDate() : new Date()
  const termsDays = client.paymentTermsDays ?? org.defaultPaymentTermsDays
  const dueDate = input.dueDate
    ? dayjs(input.dueDate).toDate()
    : dayjs(issueDate).add(termsDays, 'day').toDate()

  if (dayjs(dueDate).isBefore(dayjs(issueDate), 'day')) {
    throw new BadRequestError('The due date cannot be before the issue date')
  }

  const parties = buildTaxParties(org, client)
  const priced = priceInvoice(input.lines, {
    ...parties,
    currency,
    issueDate,
    discountBasisPoints: input.discountBasisPoints,
    customTaxProfile: org.customTaxProfile ?? null,
  })

  // Sequence is allocated at DRAFT creation so the number is stable and visible
  // while editing. A gap therefore appears if a draft is deleted — which is
  // acceptable and is why deletion is disallowed after issuing (see voidInvoice).
  const sequence = await nextSequence(orgId, 'invoice')

  const invoice = await Invoice.create({
    org: orgId,
    client: client._id,
    number: formatInvoiceNumber(org, sequence),
    sequence,
    status: InvoiceStatus.DRAFT,
    currency,
    issueDate,
    dueDate,
    lines: priced.lines.map((line) => ({
      description: line.description,
      quantityMilli: line.quantityMilli,
      unitAmountMinor: line.unitAmountMinor,
      discountBasisPoints: line.discountBasisPoints,
      supplyType: line.supplyType,
      taxTreatmentOverride: line.taxTreatmentOverride,
      netMinor: line.netMinor,
      taxMinor: line.taxMinor,
      totalMinor: line.totalMinor,
      taxComponents: line.taxComponents,
    })),
    subtotalMinor: priced.subtotalMinor,
    discountBasisPoints: priced.discountBasisPoints,
    discountMinor: priced.discountMinor,
    taxMinor: priced.taxMinor,
    totalMinor: priced.totalMinor,
    amountPaidMinor: 0,
    amountDueMinor: priced.totalMinor,
    taxSnapshot: {
      supplierCountry: parties.supplier.country,
      supplierRegion: parties.supplier.region ?? null,
      supplierTaxRegistered: parties.supplier.taxRegistered,
      supplierTaxId: parties.supplier.taxId ?? null,
      customerCountry: parties.customer.country,
      customerRegion: parties.customer.region ?? null,
      customerIsBusiness: parties.customer.isBusiness,
      customerTaxId: parties.customer.taxId ?? null,
      treatments: priced.taxTreatments,
      components: priced.taxComponents,
      notes: priced.taxNotes,
      assessedAt: new Date(),
    },
    reference: input.reference ?? null,
    notes: input.notes ?? org.defaultNotes,
    footer: input.footer ?? org.defaultFooter,
    purchaseOrderNumber: input.purchaseOrderNumber ?? null,
    publicToken: generatePublicToken(),
    createdBy: userId,
  })

  await recordAudit({
    org: orgId,
    actor: userId,
    action: 'invoice.created',
    entityType: 'Invoice',
    entityId: invoice._id.toString(),
    changes: { number: invoice.number, totalMinor: invoice.totalMinor, currency },
  })

  return invoice
}

/**
 * Update a draft.
 *
 * Only DRAFT invoices are editable. Once issued, the document has been sent to
 * a third party and is evidence of what was charged; changing it retroactively
 * is the kind of thing that ends an audit badly. Corrections after issue are
 * made by voiding and reissuing.
 */
export async function updateDraft(
  orgId: Types.ObjectId,
  userId: Types.ObjectId,
  invoiceId: string,
  input: Partial<InvoiceDraftInput>,
): Promise<IInvoice> {
  const invoice = await Invoice.findOne({ _id: invoiceId, org: orgId })
  if (!invoice) throw new NotFoundError('Invoice')

  if (invoice.status !== InvoiceStatus.DRAFT) {
    throw new ForbiddenError(
      `Invoice ${invoice.number} has been issued and can no longer be edited. Void it and create a new one instead.`,
    )
  }

  const org = await Organisation.findById(orgId)
  if (!org) throw new NotFoundError('Workspace')

  const clientId = input.clientId ?? invoice.client.toString()
  const client = await Client.findOne({ _id: clientId, org: orgId })
  if (!client) throw new NotFoundError('Client')

  const currency = (input.currency ?? invoice.currency).toUpperCase()
  const issueDate = input.issueDate ? dayjs(input.issueDate).toDate() : invoice.issueDate
  const dueDate = input.dueDate ? dayjs(input.dueDate).toDate() : invoice.dueDate

  if (dayjs(dueDate).isBefore(dayjs(issueDate), 'day')) {
    throw new BadRequestError('The due date cannot be before the issue date')
  }

  const lines: PricingLineInput[] =
    input.lines ??
    invoice.lines.map((l) => ({
      description: l.description,
      quantityMilli: l.quantityMilli,
      unitAmountMinor: l.unitAmountMinor,
      discountBasisPoints: l.discountBasisPoints,
      supplyType: l.supplyType,
      taxTreatmentOverride: l.taxTreatmentOverride,
    }))

  if (lines.length === 0) throw new BadRequestError('An invoice needs at least one line')

  const parties = buildTaxParties(org, client)
  const priced = priceInvoice(lines, {
    ...parties,
    currency,
    issueDate,
    discountBasisPoints: input.discountBasisPoints ?? invoice.discountBasisPoints,
    customTaxProfile: org.customTaxProfile ?? null,
  })

  invoice.client = client._id
  invoice.currency = currency
  invoice.issueDate = issueDate
  invoice.dueDate = dueDate
  invoice.lines = priced.lines.map((line) => ({
    description: line.description,
    quantityMilli: line.quantityMilli,
    unitAmountMinor: line.unitAmountMinor,
    discountBasisPoints: line.discountBasisPoints,
    supplyType: line.supplyType,
    taxTreatmentOverride: line.taxTreatmentOverride,
    netMinor: line.netMinor,
    taxMinor: line.taxMinor,
    totalMinor: line.totalMinor,
    taxComponents: line.taxComponents,
  })) as IInvoice['lines']
  invoice.subtotalMinor = priced.subtotalMinor
  invoice.discountBasisPoints = priced.discountBasisPoints
  invoice.discountMinor = priced.discountMinor
  invoice.taxMinor = priced.taxMinor
  invoice.totalMinor = priced.totalMinor
  invoice.amountDueMinor = outstanding(priced.totalMinor, invoice.amountPaidMinor)
  invoice.taxSnapshot = {
    supplierCountry: parties.supplier.country,
    supplierRegion: parties.supplier.region ?? null,
    supplierTaxRegistered: parties.supplier.taxRegistered,
    supplierTaxId: parties.supplier.taxId ?? null,
    customerCountry: parties.customer.country,
    customerRegion: parties.customer.region ?? null,
    customerIsBusiness: parties.customer.isBusiness,
    customerTaxId: parties.customer.taxId ?? null,
    treatments: priced.taxTreatments,
    components: priced.taxComponents,
    notes: priced.taxNotes,
    assessedAt: new Date(),
  } as IInvoice['taxSnapshot']

  if (input.reference !== undefined) invoice.reference = input.reference
  if (input.notes !== undefined) invoice.notes = input.notes
  if (input.footer !== undefined) invoice.footer = input.footer
  if (input.purchaseOrderNumber !== undefined) {
    invoice.purchaseOrderNumber = input.purchaseOrderNumber
  }

  await invoice.save()

  await recordAudit({
    org: orgId,
    actor: userId,
    action: 'invoice.updated',
    entityType: 'Invoice',
    entityId: invoice._id.toString(),
    changes: { totalMinor: invoice.totalMinor },
  })

  return invoice
}

/**
 * Transition an invoice, enforcing the state machine.
 *
 * Single choke point. Every status change goes through here so an illegal edge
 * cannot be introduced by a new controller.
 */
export async function transition(
  invoice: IInvoice,
  to: InvoiceStatus,
  meta: { actor?: Types.ObjectId | null; reason?: string } = {},
): Promise<IInvoice> {
  if (invoice.status === to) return invoice

  if (!canTransition(invoice.status, to)) {
    throw new ConflictError(
      `Invoice ${invoice.number} cannot move from ${invoice.status} to ${to}`,
      { from: invoice.status, to },
    )
  }

  const from = invoice.status
  invoice.status = to

  const now = new Date()
  if (to === InvoiceStatus.SENT && !invoice.sentAt) invoice.sentAt = now
  if (to === InvoiceStatus.PAID) invoice.paidAt = now
  if (to === InvoiceStatus.VOID) {
    invoice.voidedAt = now
    invoice.voidReason = meta.reason ?? null
  }

  await invoice.save()

  await recordAudit({
    org: invoice.org,
    actor: meta.actor ?? null,
    action: `invoice.${to.toLowerCase()}`,
    entityType: 'Invoice',
    entityId: invoice._id.toString(),
    changes: { from, to, reason: meta.reason },
  })

  return invoice
}

export async function issueAndSend(
  orgId: Types.ObjectId,
  userId: Types.ObjectId,
  invoiceId: string,
  options: { sendEmail?: boolean } = {},
): Promise<IInvoice> {
  const invoice = await Invoice.findOne({ _id: invoiceId, org: orgId })
  if (!invoice) throw new NotFoundError('Invoice')

  const org = await Organisation.findById(orgId)
  const client = await Client.findOne({ _id: invoice.client, org: orgId })
  if (!org || !client) throw new NotFoundError('Invoice')

  if (invoice.lines.length === 0) {
    throw new BadRequestError('Add at least one line before sending')
  }

  await transition(invoice, InvoiceStatus.SENT, { actor: userId })

  // The invoice becomes a receivable at issue, so that is when the CHARGE entry
  // is posted. Posting it at draft creation would put unissued drafts into the
  // accounts-receivable balance. Idempotent, so a resend does not double-charge.
  await postEntry({
    invoice,
    type: LedgerEntryType.CHARGE,
    amountMinor: invoice.totalMinor,
    idempotencyKey: `charge:${invoice._id.toString()}`,
    description: `Invoice ${invoice.number} issued`,
    actor: userId,
    effectiveAt: invoice.issueDate,
  })

  if (options.sendEmail !== false) {
    if (!client.email) {
      logger.warn(
        { invoiceId: invoice._id.toString() },
        'Invoice issued but client has no email address',
      )
    } else {
      // Delivery failure does not roll back the issue: the invoice IS issued,
      // and the user can resend. sendEmail never throws.
      await sendEmail({
        to: client.email,
        subject: `Invoice ${invoice.number} from ${org.name}`,
        template: 'invoice-sent',
        data: {
          clientName: client.contactName ?? client.name,
          orgName: org.name,
          invoiceNumber: invoice.number,
          amount: formatMoney(invoice.totalMinor, invoice.currency),
          dueDate: dayjs(invoice.dueDate).format('D MMMM YYYY'),
          url: publicInvoiceUrl(invoice.publicToken),
          notes: invoice.notes,
        },
        replyTo: org.email ?? undefined,
      })
    }
  }

  return invoice
}

export function publicInvoiceUrl(publicToken: string): string {
  return `${env.APP_URL}/pay/${publicToken}`
}

export async function voidInvoice(
  orgId: Types.ObjectId,
  userId: Types.ObjectId,
  invoiceId: string,
  reason: string,
): Promise<IInvoice> {
  const invoice = await Invoice.findOne({ _id: invoiceId, org: orgId })
  if (!invoice) throw new NotFoundError('Invoice')

  if (invoice.amountPaidMinor > 0) {
    throw new ConflictError(
      'This invoice has payments against it. Refund them before voiding.',
      { amountPaidMinor: invoice.amountPaidMinor },
    )
  }

  // Reverse the receivable so a voided invoice stops counting as money owed.
  // Only if it was ever issued — a voided draft never had a CHARGE entry.
  if (invoice.sentAt) {
    await postEntry({
      invoice,
      type: LedgerEntryType.VOID,
      amountMinor: invoice.totalMinor,
      idempotencyKey: `void:${invoice._id.toString()}`,
      description: `Invoice ${invoice.number} voided: ${reason}`,
      actor: userId,
    })
  }

  return transition(invoice, InvoiceStatus.VOID, { actor: userId, reason })
}

/**
 * Record a successful payment against an invoice and advance its status.
 *
 * LEDGER-BACKED AND IDEMPOTENT. The caller supplies an `idempotencyKey`; the
 * ledger's unique (invoice, idempotencyKey) index guarantees the credit is
 * applied at most once no matter how many code paths race. That is what lets
 * the webhook handler and the reconciliation sweeper both call this freely
 * without coordinating: whichever arrives second gets `created: false` and
 * changes nothing.
 *
 * Status is then derived from the ledger balance rather than from the amount
 * just added, so a partial payment followed by a missed webhook followed by a
 * recovery sweep still lands on the correct final state.
 */
export async function applyPayment(
  invoice: IInvoice,
  amountMinor: number,
  meta: {
    actor?: Types.ObjectId | null
    actorLabel?: string | null
    source: string
    paymentId?: Types.ObjectId | null
    /** Must be stable for a given payment. Convention: `payment:<paymentId>`. */
    idempotencyKey: string
    description?: string
  },
): Promise<{ invoice: IInvoice; created: boolean }> {
  if (amountMinor <= 0) throw new BadRequestError('A payment must be greater than zero')

  const result = await postEntry({
    invoice,
    type: LedgerEntryType.PAYMENT,
    amountMinor,
    idempotencyKey: meta.idempotencyKey,
    description: meta.description ?? `Payment received via ${meta.source}`,
    payment: meta.paymentId ?? null,
    actor: meta.actor ?? null,
    actorLabel: meta.actorLabel ?? meta.source,
    metadata: { source: meta.source },
  })

  if (!result.created) {
    // Already credited. Not an error — this is the expected outcome of a
    // provider retry or of reconciliation catching up with a webhook.
    logger.info(
      { invoiceId: invoice._id.toString(), source: meta.source },
      'Payment already applied — no double credit',
    )
    return { invoice, created: false }
  }

  // Balance comes from the ledger via reproject(), which postEntry already ran.
  const settled = invoice.amountDueMinor <= 0
  const target = settled ? InvoiceStatus.PAID : InvoiceStatus.PARTIALLY_PAID

  if (canTransition(invoice.status, target)) {
    await transition(invoice, target, { actor: meta.actor ?? null })
  } else {
    // The money is recorded in the ledger regardless — it must never vanish
    // because a status edge was disallowed. Surface it for review instead.
    logger.warn(
      {
        invoiceId: invoice._id.toString(),
        status: invoice.status,
        target,
        source: meta.source,
      },
      'Payment recorded in ledger but status transition is not permitted — needs review',
    )
    await recordAudit({
      org: invoice.org,
      actor: meta.actor ?? null,
      action: 'invoice.payment_status_conflict',
      entityType: 'Invoice',
      entityId: invoice._id.toString(),
      changes: { status: invoice.status, attemptedTarget: target, amountMinor },
    })
  }

  return { invoice, created: true }
}

/** Marks the invoice viewed the first time the customer opens the public page. */
export async function registerPublicView(invoice: IInvoice): Promise<void> {
  invoice.viewCount += 1
  if (!invoice.firstViewedAt) invoice.firstViewedAt = new Date()

  if (invoice.status === InvoiceStatus.SENT) {
    await transition(invoice, InvoiceStatus.VIEWED, { actor: null })
  } else {
    await invoice.save()
  }
}

export interface AuditInput {
  org: Types.ObjectId | null
  actor: Types.ObjectId | null
  actorLabel?: string | null
  action: string
  entityType: string
  entityId?: string | null
  changes?: unknown
  ip?: string | null
  userAgent?: string | null
  requestId?: string | null
}

/**
 * Write an audit record.
 *
 * Never throws. An audit write failure must not fail the user's action — but it
 * must be loud in the logs, because a silently missing audit trail is worse than
 * a visibly broken one.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await AuditLog.create({
      org: input.org,
      actor: input.actor,
      actorLabel: input.actorLabel ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      changes: input.changes ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
    })
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error), action: input.action },
      'Failed to write audit log entry',
    )
  }
}

/** Human-readable summary of the tax treatment, for the invoice face and UI. */
export function describeTaxTreatment(treatments: TaxTreatment[]): string | null {
  if (treatments.includes(TaxTreatment.REVERSE_CHARGE)) return 'Reverse charge applies'
  if (treatments.includes(TaxTreatment.ZERO_RATED)) return 'Zero-rated supply'
  if (treatments.includes(TaxTreatment.EXEMPT)) return 'Exempt supply'
  if (treatments.includes(TaxTreatment.OUT_OF_SCOPE)) return 'No tax charged'
  return null
}
