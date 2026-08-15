import { Types } from 'mongoose'
import { logger } from '../../core/logger'
import { BadRequestError, ConflictError } from '../../core/errors'
import { assertInteger } from '../../core/money'
import {
  ENTRY_SIGN,
  Invoice,
  LedgerEntry,
  LedgerEntryType,
  type IInvoice,
  type ILedgerEntry,
} from '../../models'

/**
 * Ledger service.
 *
 * The balance of an invoice is DERIVED from immutable entries, never stored as
 * the primary truth. `Invoice.amountPaidMinor` and `amountDueMinor` are caches
 * maintained by `reproject()` and checked by `auditInvoiceBalance()`.
 *
 * This is the part of the design that differs deliberately from how most
 * billing systems (including Stripe Invoicing) track balances. The cost is one
 * extra collection and an aggregation. The benefit is that every balance is
 * explainable and every error is recoverable:
 *
 *   Counter approach:  balance = 240000. Why? Unknowable. Fix = guess.
 *   Ledger approach:   two PAYMENT entries of 120000, one a duplicate with a
 *                      known idempotency key. Fix = one ADJUSTMENT entry, with
 *                      the original evidence intact for audit.
 */

export interface PostEntryInput {
  invoice: IInvoice
  type: LedgerEntryType
  /** UNSIGNED magnitude in minor units. The sign comes from the entry type. */
  amountMinor: number
  /** Must be unique per invoice. This is the idempotency guarantee. */
  idempotencyKey: string
  description: string
  payment?: Types.ObjectId | null
  reverses?: Types.ObjectId | null
  actor?: Types.ObjectId | null
  actorLabel?: string | null
  effectiveAt?: Date
  metadata?: Record<string, unknown> | null
  /** ADJUSTMENT only: caller supplies the sign explicitly. */
  signOverride?: 1 | -1
}

export interface PostEntryResult {
  entry: ILedgerEntry
  /** False when an entry with this key already existed, nothing was written. */
  created: boolean
  outstandingMinor: number
}

/**
 * Append one entry and reproject the invoice.
 *
 * IDEMPOTENT BY CONSTRUCTION. A duplicate (invoice, idempotencyKey) pair is
 * rejected by a unique index, caught here, and reported as `created: false`.
 * Callers do not need to check first, the check-then-write pattern races.
 */
export async function postEntry(input: PostEntryInput): Promise<PostEntryResult> {
  assertInteger(input.amountMinor, 'amountMinor')

  if (input.amountMinor < 0) {
    throw new BadRequestError(
      'Ledger amounts are unsigned magnitudes; the sign is determined by the entry type',
    )
  }
  if (input.type === LedgerEntryType.ADJUSTMENT && !input.signOverride) {
    throw new BadRequestError('An ADJUSTMENT entry must specify signOverride')
  }

  const sign = input.signOverride ?? ENTRY_SIGN[input.type]
  const signedAmount = sign * input.amountMinor

  try {
    const entry = await LedgerEntry.create({
      org: input.invoice.org,
      invoice: input.invoice._id,
      client: input.invoice.client,
      type: input.type,
      amountMinor: signedAmount,
      currency: input.invoice.currency,
      payment: input.payment ?? null,
      idempotencyKey: input.idempotencyKey,
      reverses: input.reverses ?? null,
      description: input.description,
      actor: input.actor ?? null,
      actorLabel: input.actorLabel ?? null,
      effectiveAt: input.effectiveAt ?? new Date(),
      metadata: input.metadata ?? null,
    })

    const outstandingMinor = await reproject(input.invoice)
    return { entry, created: true, outstandingMinor }
  } catch (error) {
    if (isDuplicateKey(error)) {
      const existing = await LedgerEntry.findOne({
        invoice: input.invoice._id,
        idempotencyKey: input.idempotencyKey,
      })
      if (!existing) throw error

      logger.info(
        {
          invoiceId: input.invoice._id.toString(),
          idempotencyKey: input.idempotencyKey,
          type: input.type,
        },
        'Ledger entry already exists, no double credit',
      )

      return {
        entry: existing,
        created: false,
        outstandingMinor: await computeOutstanding(input.invoice._id),
      }
    }
    throw error
  }
}

/** Sum of all signed entries. Zero means settled. */
export async function computeOutstanding(invoiceId: Types.ObjectId): Promise<number> {
  const [result] = await LedgerEntry.aggregate<{ total: number }>([
    { $match: { invoice: invoiceId } },
    { $group: { _id: null, total: { $sum: '$amountMinor' } } },
  ])
  return result?.total ?? 0
}

/** Total value of PAYMENT entries, i.e. money actually received. */
export async function computePaid(invoiceId: Types.ObjectId): Promise<number> {
  const [result] = await LedgerEntry.aggregate<{ total: number }>([
    { $match: { invoice: invoiceId, type: LedgerEntryType.PAYMENT } },
    { $group: { _id: null, total: { $sum: '$amountMinor' } } },
  ])
  // PAYMENT entries are negative by convention; report the magnitude.
  return Math.abs(result?.total ?? 0)
}

/**
 * Refresh the cached projection on the invoice from the ledger.
 *
 * The cache exists so listing 500 invoices does not require 500 aggregations.
 * It is written only from derived values, never incremented in place, that
 * distinction is what keeps the ledger authoritative.
 */
export async function reproject(invoice: IInvoice): Promise<number> {
  const [outstanding, paid] = await Promise.all([
    computeOutstanding(invoice._id),
    computePaid(invoice._id),
  ])

  await Invoice.updateOne(
    { _id: invoice._id },
    { $set: { amountPaidMinor: paid, amountDueMinor: Math.max(0, outstanding) } },
  )

  invoice.amountPaidMinor = paid
  invoice.amountDueMinor = Math.max(0, outstanding)

  return outstanding
}

export interface BalanceAudit {
  invoiceId: string
  invoiceNumber: string
  /** What the ledger says. */
  ledgerPaidMinor: number
  ledgerOutstandingMinor: number
  /** What the cached fields say. */
  cachedPaidMinor: number
  cachedOutstandingMinor: number
  drifted: boolean
  entryCount: number
}

/**
 * Compare the cached projection against the ledger.
 *
 * This is the check a counter-based design cannot perform, because there is
 * nothing to compare against. Run by the reconciliation job; any drift is a
 * defect that gets reported rather than accumulating silently.
 */
export async function auditInvoiceBalance(invoice: IInvoice): Promise<BalanceAudit> {
  const [ledgerOutstanding, ledgerPaid, entryCount] = await Promise.all([
    computeOutstanding(invoice._id),
    computePaid(invoice._id),
    LedgerEntry.countDocuments({ invoice: invoice._id }),
  ])

  const expectedOutstanding = Math.max(0, ledgerOutstanding)

  return {
    invoiceId: invoice._id.toString(),
    invoiceNumber: invoice.number,
    ledgerPaidMinor: ledgerPaid,
    ledgerOutstandingMinor: expectedOutstanding,
    cachedPaidMinor: invoice.amountPaidMinor,
    cachedOutstandingMinor: invoice.amountDueMinor,
    drifted:
      ledgerPaid !== invoice.amountPaidMinor || expectedOutstanding !== invoice.amountDueMinor,
    entryCount,
  }
}

/**
 * Correct an erroneous entry without deleting it.
 *
 * The original stays; a reversing ADJUSTMENT is appended pointing at it. This is
 * how accounting corrections work, and why the ledger is auditable: the record
 * shows both the mistake and the fix.
 */
export async function reverseEntry(
  entryId: Types.ObjectId,
  reason: string,
  actor: Types.ObjectId | null,
): Promise<PostEntryResult> {
  const original = await LedgerEntry.findById(entryId)
  if (!original) throw new BadRequestError('That ledger entry does not exist')

  const alreadyReversed = await LedgerEntry.findOne({ reverses: original._id })
  if (alreadyReversed) {
    throw new ConflictError('That entry has already been reversed', {
      reversalId: alreadyReversed._id.toString(),
    })
  }

  const invoice = await Invoice.findById(original.invoice)
  if (!invoice) throw new BadRequestError('The invoice for that entry no longer exists')

  return postEntry({
    invoice,
    type: LedgerEntryType.ADJUSTMENT,
    amountMinor: Math.abs(original.amountMinor),
    // Opposite sign to the entry being cancelled.
    signOverride: original.amountMinor > 0 ? -1 : 1,
    idempotencyKey: `reversal:${original._id.toString()}`,
    description: `Reversal of ${original.type}: ${reason}`,
    reverses: original._id,
    actor,
    metadata: { originalType: original.type, originalAmountMinor: original.amountMinor },
  })
}

/** Full entry history for an invoice, oldest first. Powers the audit view. */
export async function entryHistory(invoiceId: Types.ObjectId): Promise<ILedgerEntry[]> {
  return LedgerEntry.find({ invoice: invoiceId }).sort({ createdAt: 1 })
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 11000
  )
}
