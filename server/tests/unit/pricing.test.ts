import { isSettled, outstanding, priceInvoice, type PricingContext } from '../../src/modules/invoices/pricing'
import { sum } from '../../src/core/money'
import { TaxTreatment } from '../../src/services/tax/types'

const GH_2026: PricingContext = {
  supplier: { country: 'GH', taxRegistered: true, taxId: 'GH-1' },
  customer: { country: 'GH', taxRegistered: false, isBusiness: false },
  currency: 'GHS',
  issueDate: new Date('2026-06-01T00:00:00Z'),
}

const NO_TAX: PricingContext = {
  supplier: { country: 'GH', taxRegistered: false },
  customer: { country: 'GH', taxRegistered: false },
  currency: 'GHS',
  issueDate: new Date('2026-06-01T00:00:00Z'),
}

describe('priceInvoice — line arithmetic', () => {
  it('multiplies fractional quantities correctly', () => {
    // 1.5 hours at GHS 200.00 = GHS 300.00
    const result = priceInvoice(
      [{ description: 'Design', quantityMilli: 1500, unitAmountMinor: 20_000 }],
      NO_TAX,
    )
    expect(result.lines[0]!.grossMinor).toBe(30_000)
    expect(result.totalMinor).toBe(30_000)
  })

  it('handles a quantity of one third without drift', () => {
    // 0.333 x 100.00 = 33.30
    const result = priceInvoice(
      [{ description: 'Partial', quantityMilli: 333, unitAmountMinor: 10_000 }],
      NO_TAX,
    )
    expect(result.lines[0]!.grossMinor).toBe(3330)
  })

  it('sums many lines without accumulating error', () => {
    // 100 lines of 0.07 would drift visibly with float arithmetic.
    const lines = Array.from({ length: 100 }, () => ({
      description: 'Unit',
      quantityMilli: 1000,
      unitAmountMinor: 7,
    }))
    const result = priceInvoice(lines, NO_TAX)
    expect(result.totalMinor).toBe(700)
  })

  it('applies a per-line discount before anything else', () => {
    // 1000.00 less 10% = 900.00
    const result = priceInvoice(
      [
        {
          description: 'Discounted',
          quantityMilli: 1000,
          unitAmountMinor: 100_000,
          discountBasisPoints: 1000,
        },
      ],
      NO_TAX,
    )
    expect(result.lines[0]!.lineDiscountMinor).toBe(10_000)
    expect(result.lines[0]!.netMinor).toBe(90_000)
  })
})

describe('priceInvoice — invoice-level discount allocation', () => {
  it('allocates the discount across lines with no rounding loss', () => {
    // 10% off three lines of 3.33 each. Independent rounding would leak a unit.
    const result = priceInvoice(
      [
        { description: 'A', quantityMilli: 1000, unitAmountMinor: 333 },
        { description: 'B', quantityMilli: 1000, unitAmountMinor: 333 },
        { description: 'C', quantityMilli: 1000, unitAmountMinor: 333 },
      ],
      { ...NO_TAX, discountBasisPoints: 1000 },
    )

    const allocated = sum(result.lines.map((l) => l.allocatedDiscountMinor))
    // The allocated parts must equal the discount printed on the invoice.
    expect(allocated).toBe(result.discountMinor)
    // And the net total must equal subtotal less discount exactly.
    expect(sum(result.lines.map((l) => l.netMinor))).toBe(
      result.subtotalMinor - result.discountMinor,
    )
  })

  it('holds the allocation invariant across random inputs', () => {
    for (let i = 0; i < 200; i += 1) {
      const lineCount = 1 + Math.floor(Math.random() * 6)
      const lines = Array.from({ length: lineCount }, () => ({
        description: 'X',
        quantityMilli: 1 + Math.floor(Math.random() * 5000),
        unitAmountMinor: 1 + Math.floor(Math.random() * 100_000),
      }))
      const bps = Math.floor(Math.random() * 10_000)
      const result = priceInvoice(lines, { ...NO_TAX, discountBasisPoints: bps })

      expect(sum(result.lines.map((l) => l.allocatedDiscountMinor))).toBe(result.discountMinor)
      expect(sum(result.lines.map((l) => l.netMinor))).toBe(
        result.subtotalMinor - result.discountMinor,
      )
      expect(result.totalMinor).toBe(sum(result.lines.map((l) => l.totalMinor)))
    }
  })

  it('taxes the POST-discount base, not the gross', () => {
    // 1000.00, 50% off, Ghana 20%. Tax must be 20% of 500, i.e. 100.
    const result = priceInvoice(
      [{ description: 'Work', quantityMilli: 1000, unitAmountMinor: 100_000 }],
      { ...GH_2026, discountBasisPoints: 5000 },
    )
    expect(result.discountMinor).toBe(50_000)
    expect(result.taxMinor).toBe(10_000)
    expect(result.totalMinor).toBe(60_000)
  })
})

describe('priceInvoice — tax integration', () => {
  it('itemises Ghana VAT, NHIL and GETFund separately', () => {
    const result = priceInvoice(
      [{ description: 'Consulting', quantityMilli: 1000, unitAmountMinor: 100_000 }],
      GH_2026,
    )
    expect(result.taxMinor).toBe(20_000)
    expect(result.taxComponents.map((c) => c.code)).toEqual(['GH_VAT', 'GH_NHIL', 'GH_GETFUND'])
    expect(result.totalMinor).toBe(120_000)
  })

  it('charges no tax when the supplier is not registered', () => {
    const result = priceInvoice(
      [{ description: 'Work', quantityMilli: 1000, unitAmountMinor: 100_000 }],
      NO_TAX,
    )
    expect(result.taxMinor).toBe(0)
    expect(result.taxTreatments).toContain(TaxTreatment.OUT_OF_SCOPE)
  })

  it('taxes a mixed invoice line by line', () => {
    // One standard line, one zero-rated. Subtotal-level tax would double-count.
    const result = priceInvoice(
      [
        { description: 'Taxable', quantityMilli: 1000, unitAmountMinor: 100_000 },
        {
          description: 'Zero-rated',
          quantityMilli: 1000,
          unitAmountMinor: 100_000,
          taxTreatmentOverride: TaxTreatment.ZERO_RATED,
        },
      ],
      GH_2026,
    )
    expect(result.taxMinor).toBe(20_000)
    expect(result.lines[0]!.taxMinor).toBe(20_000)
    expect(result.lines[1]!.taxMinor).toBe(0)
    expect(result.totalMinor).toBe(220_000)
  })

  it('carries the reverse-charge note for intra-EU B2B', () => {
    const result = priceInvoice(
      [{ description: 'Design', quantityMilli: 1000, unitAmountMinor: 100_000 }],
      {
        supplier: { country: 'DE', taxRegistered: true, taxId: 'DE123' },
        customer: { country: 'FR', taxRegistered: true, taxId: 'FR456', isBusiness: true },
        currency: 'EUR',
        issueDate: new Date('2026-06-01T00:00:00Z'),
      },
    )
    expect(result.taxMinor).toBe(0)
    expect(result.taxNotes.join(' ')).toMatch(/Article 196/)
    expect(result.totalMinor).toBe(100_000)
  })

  it('handles zero-decimal currencies without inflating tax', () => {
    // JPY 10,000 at Japan's 10% consumption tax = 1,000.
    const result = priceInvoice(
      [{ description: 'Service', quantityMilli: 1000, unitAmountMinor: 10_000 }],
      {
        supplier: { country: 'JP', taxRegistered: true, taxId: 'JP1' },
        customer: { country: 'JP', taxRegistered: false },
        currency: 'JPY',
        issueDate: new Date('2026-06-01T00:00:00Z'),
      },
    )
    expect(result.taxMinor).toBe(1000)
    expect(result.totalMinor).toBe(11_000)
  })
})

describe('priceInvoice — edge cases', () => {
  it('prices an empty invoice as zero', () => {
    const result = priceInvoice([], GH_2026)
    expect(result.subtotalMinor).toBe(0)
    expect(result.totalMinor).toBe(0)
    expect(result.taxComponents).toEqual([])
  })

  it('handles a zero-amount line', () => {
    const result = priceInvoice(
      [{ description: 'Free', quantityMilli: 1000, unitAmountMinor: 0 }],
      GH_2026,
    )
    expect(result.totalMinor).toBe(0)
    expect(result.taxMinor).toBe(0)
  })

  it('supports a 100% discount', () => {
    const result = priceInvoice(
      [{ description: 'Comped', quantityMilli: 1000, unitAmountMinor: 100_000 }],
      { ...GH_2026, discountBasisPoints: 10_000 },
    )
    expect(result.discountMinor).toBe(100_000)
    expect(result.totalMinor).toBe(0)
    expect(result.taxMinor).toBe(0)
  })

  it('supports negative line amounts for credits', () => {
    const result = priceInvoice(
      [
        { description: 'Work', quantityMilli: 1000, unitAmountMinor: 100_000 },
        { description: 'Credit', quantityMilli: 1000, unitAmountMinor: -20_000 },
      ],
      NO_TAX,
    )
    expect(result.subtotalMinor).toBe(80_000)
    expect(result.totalMinor).toBe(80_000)
  })

  it('allocates a discount across positive lines only, never onto credits', () => {
    // 10% off. The credit line must keep its full -200.00: discounting a credit
    // would reduce the reduction and increase the amount owed.
    const result = priceInvoice(
      [
        { description: 'Work', quantityMilli: 1000, unitAmountMinor: 100_000 },
        { description: 'Credit', quantityMilli: 1000, unitAmountMinor: -20_000 },
      ],
      { ...NO_TAX, discountBasisPoints: 1000 },
    )
    expect(result.discountMinor).toBe(8_000)
    expect(result.lines[1]!.allocatedDiscountMinor).toBe(0)
    expect(result.lines[1]!.netMinor).toBe(-20_000)
    // Whole discount landed on the positive line.
    expect(result.lines[0]!.allocatedDiscountMinor).toBe(8_000)
    expect(result.totalMinor).toBe(72_000)
  })

  it('does not turn a discount into a surcharge on a net-negative invoice', () => {
    const result = priceInvoice(
      [{ description: 'Refund', quantityMilli: 1000, unitAmountMinor: -50_000 }],
      { ...NO_TAX, discountBasisPoints: 2000 },
    )
    expect(result.subtotalMinor).toBe(-50_000)
    expect(result.discountMinor).toBe(0)
    expect(result.totalMinor).toBe(-50_000)
  })

  it('rejects fractional minor units', () => {
    expect(() =>
      priceInvoice([{ description: 'Bad', quantityMilli: 1000, unitAmountMinor: 12.5 }], NO_TAX),
    ).toThrow(/integer/)
  })
})

describe('outstanding / isSettled', () => {
  it('computes the remaining balance', () => {
    expect(outstanding(120_000, 0)).toBe(120_000)
    expect(outstanding(120_000, 50_000)).toBe(70_000)
    expect(outstanding(120_000, 120_000)).toBe(0)
  })

  it('never reports a negative balance on overpayment', () => {
    expect(outstanding(100_000, 150_000)).toBe(0)
  })

  it('settles on exact and over payment but not under', () => {
    expect(isSettled(100_000, 99_999)).toBe(false)
    expect(isSettled(100_000, 100_000)).toBe(true)
    expect(isSettled(100_000, 100_001)).toBe(true)
  })

  it('does not treat a zero-total invoice as settled by a zero payment', () => {
    expect(isSettled(0, 0)).toBe(false)
  })
})
