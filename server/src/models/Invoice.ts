import { Schema, model, Document, Types } from 'mongoose'
import { SUPPORTED_CURRENCY_CODES } from '../core/money'
import { TaxTreatment } from '../services/tax/types'

export enum InvoiceStatus {
  DRAFT = 'DRAFT',
  SENT = 'SENT',
  VIEWED = 'VIEWED',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PAID = 'PAID',
  OVERDUE = 'OVERDUE',
  VOID = 'VOID',
}

/**
 * Legal states from which an invoice may transition.
 *
 * DESIGN DECISION: the state machine is declared as data, not scattered across
 * `if (invoice.status === ...)` checks in controllers. A finance document that
 * can go from PAID back to DRAFT is an audit failure, so the allowed edges are
 * written down once and enforced in one place.
 */
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  [InvoiceStatus.DRAFT]: [InvoiceStatus.SENT, InvoiceStatus.VOID],
  [InvoiceStatus.SENT]: [
    InvoiceStatus.VIEWED,
    InvoiceStatus.PARTIALLY_PAID,
    InvoiceStatus.PAID,
    InvoiceStatus.OVERDUE,
    InvoiceStatus.VOID,
  ],
  [InvoiceStatus.VIEWED]: [
    InvoiceStatus.PARTIALLY_PAID,
    InvoiceStatus.PAID,
    InvoiceStatus.OVERDUE,
    InvoiceStatus.VOID,
  ],
  [InvoiceStatus.PARTIALLY_PAID]: [InvoiceStatus.PAID, InvoiceStatus.OVERDUE, InvoiceStatus.VOID],
  [InvoiceStatus.OVERDUE]: [InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.PAID, InvoiceStatus.VOID],
  // Terminal states. A paid invoice is corrected by a credit note, never edited.
  [InvoiceStatus.PAID]: [],
  [InvoiceStatus.VOID]: [],
}

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return INVOICE_TRANSITIONS[from]?.includes(to) ?? false
}

/** A status the client is allowed to see as "still owed". */
export const OPEN_STATUSES = [
  InvoiceStatus.SENT,
  InvoiceStatus.VIEWED,
  InvoiceStatus.PARTIALLY_PAID,
  InvoiceStatus.OVERDUE,
]

export type SupplyType = 'goods' | 'services' | 'digital_services'

export interface IInvoiceLine {
  _id: Types.ObjectId
  description: string
  /** Quantity in thousandths, so 1.5 hours is 1500. Avoids fractional floats. */
  quantityMilli: number
  unitAmountMinor: number
  /** Per-line discount in basis points, applied before tax. */
  discountBasisPoints: number
  supplyType: SupplyType
  taxTreatmentOverride: TaxTreatment | null
  /** Computed: quantity x unit price, less discount. Persisted for auditability. */
  netMinor: number
  taxMinor: number
  totalMinor: number
  taxComponents: Array<{
    code: string
    label: string
    basisPoints: number
    amountMinor: number
  }>
}

const invoiceLineSchema = new Schema<IInvoiceLine>(
  {
    description: { type: String, required: true, trim: true, maxlength: 500 },
    quantityMilli: { type: Number, required: true, min: 0 },
    unitAmountMinor: { type: Number, required: true },
    discountBasisPoints: { type: Number, default: 0, min: 0, max: 10_000 },
    supplyType: {
      type: String,
      enum: ['goods', 'services', 'digital_services'],
      default: 'services',
    },
    taxTreatmentOverride: {
      type: String,
      enum: [...Object.values(TaxTreatment), null],
      default: null,
    },
    netMinor: { type: Number, required: true },
    taxMinor: { type: Number, required: true, default: 0 },
    totalMinor: { type: Number, required: true },
    taxComponents: {
      type: [
        {
          _id: false,
          code: String,
          label: String,
          basisPoints: Number,
          amountMinor: Number,
        },
      ],
      default: [],
    },
  },
  { _id: true },
)

export interface IInvoice extends Document {
  _id: Types.ObjectId
  org: Types.ObjectId
  client: Types.ObjectId
  /** Human-facing number, e.g. INV-0042. Unique per org, gapless, sequential. */
  number: string
  sequence: number
  status: InvoiceStatus
  currency: string
  issueDate: Date
  dueDate: Date
  lines: IInvoiceLine[]

  // --- Money, all integer minor units -------------------------------------
  subtotalMinor: number
  /** Invoice-level discount, allocated across lines without rounding loss. */
  discountBasisPoints: number
  discountMinor: number
  taxMinor: number
  totalMinor: number
  amountPaidMinor: number
  amountDueMinor: number

  /**
   * Snapshot of the tax determination at issue time.
   *
   * DESIGN DECISION: tax is frozen onto the document, not recomputed on read.
   * Rates change (Ghana's did on 2026-01-01) and re-deriving tax later would
   * silently rewrite history on invoices already sent and paid. An invoice is
   * evidence of what was charged, so it stores what was charged.
   */
  taxSnapshot: {
    supplierCountry: string
    supplierRegion: string | null
    supplierTaxRegistered: boolean
    supplierTaxId: string | null
    customerCountry: string
    customerRegion: string | null
    customerIsBusiness: boolean
    customerTaxId: string | null
    treatments: TaxTreatment[]
    components: Array<{ code: string; label: string; basisPoints: number; amountMinor: number }>
    notes: string[]
    assessedAt: Date
  }

  /** FX rate to org base currency, captured at issue for consistent reporting. */
  exchangeRateToBase: number

  // --- Presentation --------------------------------------------------------
  reference: string | null
  notes: string | null
  footer: string | null
  purchaseOrderNumber: string | null

  /**
   * Opaque high-entropy token for the public payment page.
   * Not the ObjectId: sequential-ish ids are guessable, and an enumerable
   * invoice URL exposes other customers' financial data.
   */
  publicToken: string
  /** Set when the customer first opens the public page. */
  firstViewedAt: Date | null
  viewCount: number

  sentAt: Date | null
  paidAt: Date | null
  voidedAt: Date | null
  voidReason: string | null
  lastReminderSentAt: Date | null
  reminderCount: number

  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const invoiceSchema = new Schema<IInvoice>(
  {
    org: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    client: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    number: { type: String, required: true },
    sequence: { type: Number, required: true },
    status: {
      type: String,
      enum: Object.values(InvoiceStatus),
      default: InvoiceStatus.DRAFT,
      index: true,
    },
    currency: { type: String, required: true, uppercase: true, enum: SUPPORTED_CURRENCY_CODES },
    issueDate: { type: Date, required: true },
    dueDate: { type: Date, required: true, index: true },
    lines: { type: [invoiceLineSchema], default: [] },

    subtotalMinor: { type: Number, required: true, default: 0 },
    discountBasisPoints: { type: Number, default: 0, min: 0, max: 10_000 },
    discountMinor: { type: Number, default: 0 },
    taxMinor: { type: Number, default: 0 },
    totalMinor: { type: Number, required: true, default: 0 },
    amountPaidMinor: { type: Number, default: 0 },
    amountDueMinor: { type: Number, default: 0 },

    taxSnapshot: {
      supplierCountry: { type: String, default: '' },
      supplierRegion: { type: String, default: null },
      supplierTaxRegistered: { type: Boolean, default: false },
      supplierTaxId: { type: String, default: null },
      customerCountry: { type: String, default: '' },
      customerRegion: { type: String, default: null },
      customerIsBusiness: { type: Boolean, default: false },
      customerTaxId: { type: String, default: null },
      treatments: { type: [String], default: [] },
      components: {
        type: [{ _id: false, code: String, label: String, basisPoints: Number, amountMinor: Number }],
        default: [],
      },
      notes: { type: [String], default: [] },
      assessedAt: { type: Date, default: Date.now },
    },

    exchangeRateToBase: { type: Number, default: 1 },

    reference: { type: String, default: null, trim: true, maxlength: 140 },
    notes: { type: String, default: null, maxlength: 4000 },
    footer: { type: String, default: null, maxlength: 1000 },
    purchaseOrderNumber: { type: String, default: null, trim: true, maxlength: 100 },

    publicToken: { type: String, required: true, unique: true, index: true },
    firstViewedAt: { type: Date, default: null },
    viewCount: { type: Number, default: 0 },

    sentAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    voidedAt: { type: Date, default: null },
    voidReason: { type: String, default: null },
    lastReminderSentAt: { type: Date, default: null },
    reminderCount: { type: Number, default: 0 },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

// Sequential numbering must be unique within a tenant, but the same number may
// legitimately exist in different tenants.
invoiceSchema.index({ org: 1, number: 1 }, { unique: true })
invoiceSchema.index({ org: 1, sequence: -1 })
// Supports the dashboard's default view and the aging report in one index.
invoiceSchema.index({ org: 1, status: 1, dueDate: 1 })
invoiceSchema.index({ org: 1, client: 1, issueDate: -1 })
// Drives the overdue sweep job.
invoiceSchema.index({ status: 1, dueDate: 1 })

export const Invoice = model<IInvoice>('Invoice', invoiceSchema)
