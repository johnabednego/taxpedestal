import { allocate, applyBasisPoints, assertInteger, roundHalfAwayFromZero, sum } from '../../core/money'
import { assessInvoice, type LineForTax } from '../../services/tax/engine'
import { TaxTreatment, type CustomTaxProfile, type TaxParty } from '../../services/tax/types'
import type { SupplyType } from '../../models/Invoice'

/**
 * Invoice pricing.
 *
 * Pure functions, no database. Given line inputs and the two parties, produce
 * every monetary figure on the invoice. Keeping this separate from the
 * persistence layer is what lets the frontend preview totals live via the same
 * logic path and lets the whole calculation be unit-tested exhaustively.
 *
 * ORDER OF OPERATIONS matters and is fixed:
 *   1. Line gross      = quantity x unit price
 *   2. Line discount   (per-line basis points)
 *   3. Invoice discount, ALLOCATED across lines without rounding loss
 *   4. Tax, assessed PER LINE on the post-discount net
 *   5. Totals
 *
 * Applying invoice-level discount after tax would produce a figure that no tax
 * authority recognises: the taxable base must be the amount actually charged.
 */

export interface PricingLineInput {
  description: string
  /** Quantity in thousandths. 1.5 hours => 1500. */
  quantityMilli: number
  unitAmountMinor: number
  discountBasisPoints?: number
  supplyType?: SupplyType
  taxTreatmentOverride?: TaxTreatment | null
}

export interface PricedLine {
  description: string
  quantityMilli: number
  unitAmountMinor: number
  discountBasisPoints: number
  supplyType: SupplyType
  taxTreatmentOverride: TaxTreatment | null
  /** Gross before any discount. Not persisted; useful for the UI. */
  grossMinor: number
  lineDiscountMinor: number
  /** Share of the invoice-level discount allocated to this line. */
  allocatedDiscountMinor: number
  /** Taxable base for this line. */
  netMinor: number
  taxMinor: number
  totalMinor: number
  taxComponents: Array<{ code: string; label: string; basisPoints: number; amountMinor: number }>
}

export interface PricingResult {
  lines: PricedLine[]
  /** Sum of line nets before invoice-level discount. */
  subtotalMinor: number
  discountBasisPoints: number
  discountMinor: number
  taxMinor: number
  totalMinor: number
  taxComponents: Array<{ code: string; label: string; basisPoints: number; amountMinor: number }>
  taxTreatments: TaxTreatment[]
  taxNotes: string[]
}

export interface PricingContext {
  supplier: TaxParty
  customer: TaxParty
  currency: string
  issueDate: Date
  /** Invoice-level discount in basis points, applied after line discounts. */
  discountBasisPoints?: number
  /** The supplier's own tax definition, where they have set one. */
  customTaxProfile?: CustomTaxProfile | null
}

/** Quantity is in thousandths, so gross = qty * price / 1000. */
function lineGross(quantityMilli: number, unitAmountMinor: number): number {
  assertInteger(quantityMilli, 'quantityMilli')
  assertInteger(unitAmountMinor, 'unitAmountMinor')
  return roundHalfAwayFromZero((quantityMilli * unitAmountMinor) / 1000)
}

export function priceInvoice(
  inputs: PricingLineInput[],
  ctx: PricingContext,
): PricingResult {
  const invoiceDiscountBps = ctx.discountBasisPoints ?? 0

  // --- Steps 1 and 2: gross and per-line discount --------------------------
  const staged = inputs.map((input) => {
    const grossMinor = lineGross(input.quantityMilli, input.unitAmountMinor)
    const lineDiscountBps = input.discountBasisPoints ?? 0
    const lineDiscountMinor = applyBasisPoints(grossMinor, lineDiscountBps)
    return {
      input,
      grossMinor,
      lineDiscountBps,
      lineDiscountMinor,
      afterLineDiscount: grossMinor - lineDiscountMinor,
    }
  })

  const subtotalMinor = sum(staged.map((s) => s.afterLineDiscount))

  // --- Step 3: allocate the invoice-level discount -------------------------
  // Computing the total discount first and then distributing it by
  // largest-remainder guarantees the parts sum exactly to the discount shown on
  // the invoice. Rounding each line's share independently does not.
  //
  // NEGATIVE LINES: an invoice may carry credit lines (a returned item, a
  // goodwill adjustment) with a negative amount. Two rules follow:
  //
  //  1. The discount is allocated across POSITIVE lines only. A credit line is
  //     already a reduction; applying a discount to it would make it less
  //     negative and therefore INCREASE the amount owed — the opposite of what
  //     "10% off" means.
  //  2. If the subtotal is zero or negative there is nothing to discount, so the
  //     discount is zero rather than a negative number (which would silently
  //     become a surcharge).
  //
  // This was found by a unit test rather than in production; see
  // tests/unit/pricing.test.ts "supports negative line amounts for credits".
  const invoiceDiscountMinor =
    subtotalMinor > 0 ? applyBasisPoints(subtotalMinor, invoiceDiscountBps) : 0

  const allocationWeights = staged.map((s) => Math.max(0, s.afterLineDiscount))
  const allocatedDiscounts = allocate(invoiceDiscountMinor, allocationWeights)

  const withNet = staged.map((s, index) => {
    const allocatedDiscountMinor = allocatedDiscounts[index] ?? 0
    return { ...s, allocatedDiscountMinor, netMinor: s.afterLineDiscount - allocatedDiscountMinor }
  })

  // --- Step 4: assess tax per line ----------------------------------------
  const taxInputs: LineForTax[] = withNet.map((s, index) => ({
    id: String(index),
    baseMinor: s.netMinor,
    supplyType: s.input.supplyType ?? 'services',
    categoryOverride: s.input.taxTreatmentOverride ?? null,
  }))

  const taxResult = assessInvoice(taxInputs, {
    supplier: ctx.supplier,
    customer: ctx.customer,
    currency: ctx.currency,
    date: ctx.issueDate,
    customProfile: ctx.customTaxProfile ?? null,
  })

  const assessmentByLine = new Map(taxResult.perLine.map((p) => [p.id, p.assessment]))

  const lines: PricedLine[] = withNet.map((s, index) => {
    const assessment = assessmentByLine.get(String(index))
    const taxMinor = assessment?.totalTaxMinor ?? 0
    return {
      description: s.input.description,
      quantityMilli: s.input.quantityMilli,
      unitAmountMinor: s.input.unitAmountMinor,
      discountBasisPoints: s.lineDiscountBps,
      supplyType: s.input.supplyType ?? 'services',
      taxTreatmentOverride: s.input.taxTreatmentOverride ?? null,
      grossMinor: s.grossMinor,
      lineDiscountMinor: s.lineDiscountMinor,
      allocatedDiscountMinor: s.allocatedDiscountMinor,
      netMinor: s.netMinor,
      taxMinor,
      totalMinor: s.netMinor + taxMinor,
      taxComponents: assessment?.components.map((c) => ({ ...c })) ?? [],
    }
  })

  // --- Step 5: totals ------------------------------------------------------
  const netTotal = sum(lines.map((l) => l.netMinor))
  const taxMinor = taxResult.totalTaxMinor

  return {
    lines,
    subtotalMinor,
    discountBasisPoints: invoiceDiscountBps,
    discountMinor: invoiceDiscountMinor,
    taxMinor,
    totalMinor: netTotal + taxMinor,
    taxComponents: taxResult.summary,
    taxTreatments: taxResult.treatments,
    taxNotes: taxResult.notes,
  }
}

/**
 * Recompute the amount outstanding on an invoice.
 *
 * Kept as a function rather than a stored-only field so the value can be
 * re-derived from the payment ledger during reconciliation. `amountDueMinor` is
 * still persisted for query performance, but this is the source of truth.
 */
export function outstanding(totalMinor: number, amountPaidMinor: number): number {
  return Math.max(0, totalMinor - amountPaidMinor)
}

export function isSettled(totalMinor: number, amountPaidMinor: number): boolean {
  // >= rather than === so an overpayment settles rather than leaving the invoice
  // permanently open.
  return amountPaidMinor >= totalMinor && totalMinor > 0
}
