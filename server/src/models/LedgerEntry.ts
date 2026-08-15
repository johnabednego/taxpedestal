import { Schema, model, Document, Types } from 'mongoose'
import { SUPPORTED_CURRENCY_CODES } from '../core/money'

/**
 * Append-only financial ledger.
 *
 * WHY THIS EXISTS, and why it is better than the counter it replaces.
 *
 * The obvious way to track what an invoice has been paid is a mutable field
 * incremented on each payment (`$inc amountPaidMinor`). Stripe Invoicing works
 * this way, and so did the first version of this codebase. It has a fatal
 * property: it is DESTRUCTIVE. If a bug credits an invoice twice even once, the
 * field is wrong and there is no way to reconstruct what it should have been.
 * You cannot audit a number that overwrote its own history.
 *
 * A ledger inverts this. Every movement of money is an immutable entry. The
 * balance is DERIVED by summing entries, so:
 *
 *  - The balance is always reconstructable from first principles.
 *  - A double-credit is visible as two entries, not an inflated number, and can
 *    be corrected by a reversing entry that leaves the original intact.
 *  - "Why does this invoice say it is paid?" is answerable months later.
 *  - Reconciliation against a payment provider becomes a set comparison rather
 *    than a guess.
 *
 * `Invoice.amountPaidMinor` is retained purely as a CACHED PROJECTION for query
 * performance, and is verified against the ledger by the reconciliation job.
 * Divergence is a reported defect, not a silent corruption.
 *
 * Entries are never updated or deleted. Mongoose-level guards below enforce
 * that at the application boundary; a production deployment should also revoke
 * update and delete privileges on this collection at the database role level.
 */

export enum LedgerEntryType {
  /** Invoice issued, the customer now owes this amount. */
  CHARGE = 'CHARGE',
  /** Money received. */
  PAYMENT = 'PAYMENT',
  /** Money returned to the customer. */
  REFUND = 'REFUND',
  /** Invoice cancelled, reverses the outstanding charge. */
  VOID = 'VOID',
  /** Written off as uncollectable. */
  WRITE_OFF = 'WRITE_OFF',
  /** Correction of an earlier erroneous entry. Always references it. */
  ADJUSTMENT = 'ADJUSTMENT',
}

/**
 * Sign convention, stated once so it cannot drift:
 *   POSITIVE  increases what the customer owes  (CHARGE)
 *   NEGATIVE  decreases what the customer owes  (PAYMENT, VOID, WRITE_OFF)
 *
 * Outstanding balance = SUM(amountMinor) over all entries for the invoice.
 * A fully paid invoice sums to zero. That single invariant is the whole point.
 */
export const ENTRY_SIGN: Record<LedgerEntryType, 1 | -1> = {
  [LedgerEntryType.CHARGE]: 1,
  [LedgerEntryType.PAYMENT]: -1,
  [LedgerEntryType.REFUND]: 1,
  [LedgerEntryType.VOID]: -1,
  [LedgerEntryType.WRITE_OFF]: -1,
  // Adjustments carry their own sign, decided by the caller.
  [LedgerEntryType.ADJUSTMENT]: 1,
}

export interface ILedgerEntry extends Document {
  _id: Types.ObjectId
  org: Types.ObjectId
  invoice: Types.ObjectId
  client: Types.ObjectId
  type: LedgerEntryType
  /** Signed, integer minor units. See ENTRY_SIGN. */
  amountMinor: number
  currency: string
  /** The payment that caused this entry, where one exists. */
  payment: Types.ObjectId | null
  /**
   * Deduplication key, unique per invoice.
   *
   * This is the second line of defence behind webhook dedupe: even if two
   * different code paths try to record the same payment, the unique index makes
   * the second insert fail rather than double-credit. Idempotency enforced by
   * the database, not by application discipline.
   */
  idempotencyKey: string
  /** For ADJUSTMENT and REFUND: the entry being corrected or reversed. */
  reverses: Types.ObjectId | null
  description: string
  /** Who or what caused this. Null for system-generated entries. */
  actor: Types.ObjectId | null
  actorLabel: string | null
  /** Effective accounting date, which may differ from createdAt. */
  effectiveAt: Date
  metadata: Record<string, unknown> | null
  createdAt: Date
}

const ledgerEntrySchema = new Schema<ILedgerEntry>(
  {
    org: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    invoice: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true, index: true },
    client: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    type: { type: String, enum: Object.values(LedgerEntryType), required: true },
    amountMinor: {
      type: Number,
      required: true,
      validate: {
        validator: Number.isInteger,
        message: 'Ledger amounts must be integer minor units',
      },
    },
    currency: { type: String, required: true, uppercase: true, enum: SUPPORTED_CURRENCY_CODES },
    payment: { type: Schema.Types.ObjectId, ref: 'Payment', default: null },
    idempotencyKey: { type: String, required: true },
    reverses: { type: Schema.Types.ObjectId, ref: 'LedgerEntry', default: null },
    description: { type: String, required: true, maxlength: 500 },
    actor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorLabel: { type: String, default: null },
    effectiveAt: { type: Date, required: true, default: Date.now },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  // No updatedAt: these documents are never updated.
  { timestamps: { createdAt: true, updatedAt: false } },
)

/** The database-level idempotency guarantee. */
ledgerEntrySchema.index({ invoice: 1, idempotencyKey: 1 }, { unique: true })
ledgerEntrySchema.index({ org: 1, effectiveAt: -1 })
ledgerEntrySchema.index({ org: 1, type: 1, effectiveAt: -1 })
ledgerEntrySchema.index({ invoice: 1, createdAt: 1 })

/**
 * Immutability guards.
 *
 * Mongoose cannot make a collection genuinely append-only, but it can refuse
 * every mutation path the application might use by accident. Anything that
 * bypasses these (a raw driver call, a DBA) is deliberate and outside the
 * application's threat model.
 */
const REJECT = function reject(this: unknown, next: (err?: Error) => void): void {
  next(new Error('Ledger entries are immutable and cannot be modified or deleted'))
}

ledgerEntrySchema.pre('updateOne', REJECT)
ledgerEntrySchema.pre('updateMany', REJECT)
ledgerEntrySchema.pre('findOneAndUpdate', REJECT)
ledgerEntrySchema.pre('deleteOne', REJECT)
ledgerEntrySchema.pre('deleteMany', REJECT)
ledgerEntrySchema.pre('findOneAndDelete', REJECT)

// Block save() on an already-persisted document, while allowing initial insert.
ledgerEntrySchema.pre('save', function preventUpdate(next) {
  if (!this.isNew) {
    next(new Error('Ledger entries are immutable and cannot be modified'))
    return
  }
  next()
})

export const LedgerEntry = model<ILedgerEntry>('LedgerEntry', ledgerEntrySchema)
