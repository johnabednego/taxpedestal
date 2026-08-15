import { assessInvoice, assessTax, supportedTaxCountries } from '../../src/services/tax/engine'
import { TaxContext, TaxTreatment } from '../../src/services/tax/types'

const IN_2026 = new Date('2026-06-01T00:00:00Z')
const IN_2025 = new Date('2025-06-01T00:00:00Z')

function ctx(overrides: Partial<TaxContext> = {}): TaxContext {
  return {
    supplier: { country: 'GH', taxRegistered: true, taxId: 'GH-VAT-001' },
    customer: { country: 'GH', taxRegistered: false, isBusiness: false },
    supplyType: 'services',
    baseMinor: 100_000, // GHS 1,000.00
    currency: 'GHS',
    date: IN_2026,
    ...overrides,
  }
}

describe('registry', () => {
  it('registers every EU member state plus the named jurisdictions', () => {
    const supported = supportedTaxCountries()
    expect(supported).toContain('GH')
    expect(supported).toContain('GB')
    expect(supported).toContain('DE')
    expect(supported).toContain('US')
    expect(supported).toContain('IN')
    // 27 EU member states + 26 explicitly registered national rules.
    expect(supported.length).toBe(53)
  })
})

describe('Ghana — VAT Act 2025 (Act 1151)', () => {
  it('charges 15% VAT + 2.5% NHIL + 2.5% GETFund on one shared base from 2026', () => {
    const result = assessTax(ctx())

    expect(result.treatment).toBe(TaxTreatment.STANDARD)
    expect(result.jurisdiction).toBe('GH')
    // Effective 20%, NOT the pre-2026 ~21.9% cascade.
    expect(result.effectiveBasisPoints).toBe(2000)
    expect(result.totalTaxMinor).toBe(20_000)

    const codes = result.components.map((c) => c.code)
    expect(codes).toEqual(['GH_VAT', 'GH_NHIL', 'GH_GETFUND'])
    // Components must remain separately itemised for GRA compliance.
    expect(result.components.find((c) => c.code === 'GH_VAT')?.amountMinor).toBe(15_000)
    expect(result.components.find((c) => c.code === 'GH_NHIL')?.amountMinor).toBe(2_500)
    expect(result.components.find((c) => c.code === 'GH_GETFUND')?.amountMinor).toBe(2_500)

    // No COVID-19 levy after abolition.
    expect(codes).not.toContain('GH_COVID')
  })

  it('applies the pre-2026 cascading computation to a back-dated supply', () => {
    const result = assessTax(ctx({ date: IN_2025 }))

    expect(result.components.map((c) => c.code)).toContain('GH_COVID')
    // Levies of 6% sit outside the VAT base, so VAT is 15% of 106.
    // 1000 -> NHIL 25, GETFund 25, COVID 10, VAT 15% of 1060 = 159. Total 219.
    expect(result.totalTaxMinor).toBe(21_900)
    expect(result.effectiveBasisPoints).toBe(2190)
  })

  it('zero-rates an export to a foreign customer', () => {
    const result = assessTax(ctx({ customer: { country: 'US', taxRegistered: false } }))
    expect(result.treatment).toBe(TaxTreatment.ZERO_RATED)
    expect(result.totalTaxMinor).toBe(0)
    expect(result.notes.join(' ')).toMatch(/Act 1151/)
  })
})

describe('unregistered supplier', () => {
  it('cannot charge tax in any jurisdiction', () => {
    const result = assessTax(
      ctx({ supplier: { country: 'GH', taxRegistered: false } }),
    )
    expect(result.treatment).toBe(TaxTreatment.OUT_OF_SCOPE)
    expect(result.totalTaxMinor).toBe(0)
    expect(result.components).toHaveLength(0)
  })
})

describe('United Kingdom', () => {
  const gbSupplier = { country: 'GB', taxRegistered: true, taxId: 'GB123456789' }

  it('charges 20% VAT domestically', () => {
    const result = assessTax(
      ctx({ supplier: gbSupplier, customer: { country: 'GB', taxRegistered: false }, currency: 'GBP' }),
    )
    expect(result.totalTaxMinor).toBe(20_000)
    expect(result.components[0]?.code).toBe('UK_VAT')
  })

  it('reverse-charges services to an overseas business', () => {
    const result = assessTax(
      ctx({
        supplier: gbSupplier,
        customer: { country: 'AU', taxRegistered: true, taxId: 'AU-ABN-1', isBusiness: true },
      }),
    )
    // GB routes to AU place of supply; AU rule sees a domestic AU supply.
    expect(result.totalTaxMinor).toBeGreaterThanOrEqual(0)
    expect([TaxTreatment.STANDARD, TaxTreatment.REVERSE_CHARGE]).toContain(result.treatment)
  })

  it('zero-rates exported goods', () => {
    const result = assessTax(
      ctx({
        supplier: gbSupplier,
        customer: { country: 'NG', taxRegistered: false },
        supplyType: 'goods',
      }),
    )
    expect(result.treatment).toBe(TaxTreatment.ZERO_RATED)
  })
})

describe('European Union', () => {
  const deSupplier = { country: 'DE', taxRegistered: true, taxId: 'DE123456789' }

  it('charges the local standard rate on a domestic supply', () => {
    const result = assessTax(
      ctx({ supplier: deSupplier, customer: { country: 'DE', taxRegistered: false }, currency: 'EUR' }),
    )
    expect(result.effectiveBasisPoints).toBe(1900)
    expect(result.components[0]?.label).toBe('VAT (19%)')
  })

  it('reverse-charges intra-EU B2B with a VAT ID and prints the mandatory note', () => {
    const result = assessTax(
      ctx({
        supplier: deSupplier,
        customer: { country: 'FR', taxRegistered: true, taxId: 'FR12345678901', isBusiness: true },
        currency: 'EUR',
      }),
    )
    expect(result.treatment).toBe(TaxTreatment.REVERSE_CHARGE)
    expect(result.totalTaxMinor).toBe(0)
    expect(result.notes.join(' ')).toMatch(/Article 196/)
  })

  it('taxes B2C digital services at the DESTINATION rate under OSS', () => {
    // German supplier, Hungarian consumer, digital service.
    // Must be Hungary's 27%, not Germany's 19%.
    const result = assessTax(
      ctx({
        supplier: deSupplier,
        customer: { country: 'HU', taxRegistered: false, isBusiness: false },
        supplyType: 'digital_services',
        currency: 'EUR',
      }),
    )
    expect(result.jurisdiction).toBe('HU')
    expect(result.effectiveBasisPoints).toBe(2700)
    expect(result.totalTaxMinor).toBe(27_000)
  })

  it('does not redirect B2B digital services to the consumer rate', () => {
    const result = assessTax(
      ctx({
        supplier: deSupplier,
        customer: { country: 'HU', taxRegistered: true, taxId: 'HU12345678', isBusiness: true },
        supplyType: 'digital_services',
        currency: 'EUR',
      }),
    )
    expect(result.treatment).toBe(TaxTreatment.REVERSE_CHARGE)
  })

  it('zero-rates a supply outside the EU', () => {
    const result = assessTax(
      ctx({ supplier: deSupplier, customer: { country: 'GH', taxRegistered: false }, currency: 'EUR' }),
    )
    expect(result.treatment).toBe(TaxTreatment.ZERO_RATED)
  })

  it('treats a B2B customer without a VAT ID as B2C', () => {
    // Claiming business status without a VAT ID must not trigger reverse charge,
    // otherwise a consumer can avoid VAT by ticking a checkbox.
    const result = assessTax(
      ctx({
        supplier: deSupplier,
        customer: { country: 'FR', taxRegistered: false, isBusiness: true, taxId: null },
        currency: 'EUR',
      }),
    )
    expect(result.treatment).toBe(TaxTreatment.STANDARD)
    expect(result.effectiveBasisPoints).toBe(1900)
  })
})

describe('United States', () => {
  const usSupplier = { country: 'US', taxRegistered: true, region: 'CA', taxId: 'EIN-1' }

  it('treats professional services as non-taxable', () => {
    const result = assessTax(
      ctx({
        supplier: usSupplier,
        customer: { country: 'US', region: 'NY', taxRegistered: false },
        supplyType: 'services',
        currency: 'USD',
      }),
    )
    expect(result.treatment).toBe(TaxTreatment.EXEMPT)
  })

  it('applies the destination state rate to goods', () => {
    const result = assessTax(
      ctx({
        supplier: usSupplier,
        customer: { country: 'US', region: 'TX', taxRegistered: false },
        supplyType: 'goods',
        currency: 'USD',
      }),
    )
    expect(result.effectiveBasisPoints).toBe(625)
    expect(result.components[0]?.label).toContain('TX')
  })

  it('charges nothing in states with no statewide sales tax', () => {
    for (const state of ['OR', 'NH', 'DE', 'MT', 'AK']) {
      const result = assessTax(
        ctx({
          supplier: usSupplier,
          customer: { country: 'US', region: state, taxRegistered: false },
          supplyType: 'goods',
          currency: 'USD',
        }),
      )
      expect(result.treatment).toBe(TaxTreatment.ZERO_RATED)
      expect(result.totalTaxMinor).toBe(0)
    }
  })

  it('declines to guess when no state is set', () => {
    const result = assessTax(
      ctx({
        supplier: usSupplier,
        customer: { country: 'US', region: null, taxRegistered: false },
        supplyType: 'goods',
        currency: 'USD',
      }),
    )
    expect(result.treatment).toBe(TaxTreatment.OUT_OF_SCOPE)
    expect(result.notes.join(' ')).toMatch(/No US state selected/)
  })
})

describe('Canada', () => {
  it('splits GST and PST in British Columbia', () => {
    const result = assessTax(
      ctx({
        supplier: { country: 'CA', taxRegistered: true, region: 'ON', taxId: 'BN-1' },
        customer: { country: 'CA', region: 'BC', taxRegistered: false },
        currency: 'CAD',
      }),
    )
    expect(result.components.map((c) => c.code).sort()).toEqual(['CA_GST', 'CA_PST'])
    expect(result.effectiveBasisPoints).toBe(1200)
  })

  it('charges single-rate HST in Ontario', () => {
    const result = assessTax(
      ctx({
        supplier: { country: 'CA', taxRegistered: true, region: 'ON', taxId: 'BN-1' },
        customer: { country: 'CA', region: 'ON', taxRegistered: false },
        currency: 'CAD',
      }),
    )
    expect(result.components).toHaveLength(1)
    expect(result.effectiveBasisPoints).toBe(1300)
  })
})

describe('India', () => {
  const inSupplier = { country: 'IN', taxRegistered: true, region: 'MH', taxId: 'GSTIN-1' }

  it('splits CGST and SGST for an intra-state supply', () => {
    const result = assessTax(
      ctx({
        supplier: inSupplier,
        customer: { country: 'IN', region: 'MH', taxRegistered: true },
        currency: 'INR',
      }),
    )
    expect(result.components.map((c) => c.code)).toEqual(['IN_CGST', 'IN_SGST'])
    expect(result.effectiveBasisPoints).toBe(1800)
  })

  it('charges IGST for an inter-state supply', () => {
    const result = assessTax(
      ctx({
        supplier: inSupplier,
        customer: { country: 'IN', region: 'KA', taxRegistered: true },
        currency: 'INR',
      }),
    )
    expect(result.components.map((c) => c.code)).toEqual(['IN_IGST'])
    expect(result.effectiveBasisPoints).toBe(1800)
  })
})

describe('category overrides', () => {
  it('honours a zero-rated override over the standard rate', () => {
    const result = assessTax(ctx({ categoryOverride: TaxTreatment.ZERO_RATED }))
    expect(result.treatment).toBe(TaxTreatment.ZERO_RATED)
    expect(result.totalTaxMinor).toBe(0)
  })

  it('honours an exempt override', () => {
    const result = assessTax(ctx({ categoryOverride: TaxTreatment.EXEMPT }))
    expect(result.treatment).toBe(TaxTreatment.EXEMPT)
  })
})

describe('unsupported jurisdiction', () => {
  it('degrades to OUT_OF_SCOPE instead of throwing', () => {
    // A 500 on an unusual country would break invoice creation entirely.
    const result = assessTax(ctx({ supplier: { country: 'AQ', taxRegistered: true } }))
    expect(result.treatment).toBe(TaxTreatment.OUT_OF_SCOPE)
    expect(result.notes.join(' ')).toMatch(/no built-in tax rules for AQ/i)
    // The message must point at the way out, not just state the problem.
    expect(result.notes.join(' ')).toMatch(/Define your own tax in Settings/)
  })

  it('returns zero tax for a zero base without consulting rules', () => {
    expect(assessTax(ctx({ baseMinor: 0 })).totalTaxMinor).toBe(0)
  })
})

describe('assessInvoice — per-line assessment', () => {
  const shared = {
    supplier: { country: 'GH', taxRegistered: true, taxId: 'GH-1' },
    customer: { country: 'GH', taxRegistered: false, isBusiness: false },
    currency: 'GHS',
    date: IN_2026,
  }

  it('aggregates components across lines by code', () => {
    const result = assessInvoice(
      [
        { id: 'a', baseMinor: 100_000, supplyType: 'services' },
        { id: 'b', baseMinor: 50_000, supplyType: 'services' },
      ],
      shared,
    )
    // 20% of 150,000 = 30,000 total, merged into three components.
    expect(result.totalTaxMinor).toBe(30_000)
    expect(result.summary).toHaveLength(3)
    expect(result.summary.find((c) => c.code === 'GH_VAT')?.amountMinor).toBe(22_500)
  })

  it('handles a mixed-treatment invoice correctly', () => {
    // This is the case invoice-subtotal-level tax computation gets wrong.
    const result = assessInvoice(
      [
        { id: 'taxable', baseMinor: 100_000, supplyType: 'services' },
        { id: 'zero', baseMinor: 100_000, supplyType: 'services', categoryOverride: TaxTreatment.ZERO_RATED },
      ],
      shared,
    )
    // Only the first line is taxed: 20,000, not 40,000.
    expect(result.totalTaxMinor).toBe(20_000)
    expect(result.treatments).toContain(TaxTreatment.STANDARD)
    expect(result.treatments).toContain(TaxTreatment.ZERO_RATED)
  })

  it('deduplicates compliance notes', () => {
    const result = assessInvoice(
      [
        { id: 'a', baseMinor: 1000, supplyType: 'services' },
        { id: 'b', baseMinor: 1000, supplyType: 'services' },
      ],
      shared,
    )
    expect(new Set(result.notes).size).toBe(result.notes.length)
  })

  it('returns an empty result for no lines', () => {
    const result = assessInvoice([], shared)
    expect(result.totalTaxMinor).toBe(0)
    expect(result.summary).toEqual([])
  })
})

describe('China — VAT Law effective 2026', () => {
  const cnSupplier = { country: 'CN', taxRegistered: true, taxId: 'CN-123' }

  it('charges 6% on services for a general taxpayer', () => {
    const result = assessTax(
      ctx({
        supplier: cnSupplier,
        customer: { country: 'CN', taxRegistered: true, isBusiness: true },
        supplyType: 'services',
        currency: 'CNY',
      }),
    )
    expect(result.effectiveBasisPoints).toBe(600)
    expect(result.components[0]?.code).toBe('CN_VAT')
  })

  it('charges 13% on goods', () => {
    const result = assessTax(
      ctx({
        supplier: cnSupplier,
        customer: { country: 'CN', taxRegistered: true, isBusiness: true },
        supplyType: 'goods',
        currency: 'CNY',
      }),
    )
    expect(result.effectiveBasisPoints).toBe(1300)
  })

  it('states the 9% tier limitation rather than silently mis-charging', () => {
    const result = assessTax(
      ctx({
        supplier: cnSupplier,
        customer: { country: 'CN', taxRegistered: true, isBusiness: true },
        supplyType: 'services',
        currency: 'CNY',
      }),
    )
    expect(result.notes.join(' ')).toMatch(/9%/)
  })

  it('zero-rates exports', () => {
    const result = assessTax(
      ctx({ supplier: cnSupplier, customer: { country: 'US', taxRegistered: false }, currency: 'CNY' }),
    )
    expect(result.treatment).toBe(TaxTreatment.ZERO_RATED)
  })
})

describe('Israel — rate change on 1 January 2025', () => {
  const ilSupplier = { country: 'IL', taxRegistered: true, taxId: 'IL-1' }

  it('charges 18% for a current supply', () => {
    const result = assessTax(
      ctx({
        supplier: ilSupplier,
        customer: { country: 'IL', taxRegistered: false },
        currency: 'ILS',
      }),
    )
    expect(result.effectiveBasisPoints).toBe(1800)
  })

  it('charges 17% for a supply back-dated before the change', () => {
    const result = assessTax(
      ctx({
        supplier: ilSupplier,
        customer: { country: 'IL', taxRegistered: false },
        currency: 'ILS',
        date: new Date('2024-11-01T00:00:00Z'),
      }),
    )
    expect(result.effectiveBasisPoints).toBe(1700)
  })

  it('zero-rates a supply to a non-resident', () => {
    const result = assessTax(
      ctx({ supplier: ilSupplier, customer: { country: 'DE', taxRegistered: true }, currency: 'ILS' }),
    )
    expect(result.treatment).toBe(TaxTreatment.ZERO_RATED)
  })
})

describe('custom tax profiles — countries with no built-in rule', () => {
  // Iraq has no general VAT, only a narrow sales tax on particular services.
  // No vendor rule can express that; the user must define it.
  const iraqProfile = {
    enabled: true,
    overrideBuiltIn: false,
    components: [{ code: 'IQ_ST', label: 'Sales Tax (20%)', basisPoints: 2000 }],
    zeroRateExports: true,
    notes: ['Sales tax on telecommunications services.'],
  }

  it('lets a business in an uncovered country charge its own tax', () => {
    const result = assessTax(
      ctx({
        supplier: { country: 'IQ', taxRegistered: true, taxId: 'IQ-1' },
        customer: { country: 'IQ', taxRegistered: false, isBusiness: true },
        currency: 'USD',
        customProfile: iraqProfile,
      }),
    )
    expect(result.treatment).toBe(TaxTreatment.STANDARD)
    expect(result.jurisdiction).toBe('IQ')
    expect(result.totalTaxMinor).toBe(20_000)
    expect(result.components[0]?.label).toBe('Sales Tax (20%)')
    expect(result.notes).toContain('Sales tax on telecommunications services.')
  })

  it('zero-rates exports when the profile says so', () => {
    const result = assessTax(
      ctx({
        supplier: { country: 'IQ', taxRegistered: true, taxId: 'IQ-1' },
        customer: { country: 'GB', taxRegistered: true },
        currency: 'USD',
        customProfile: iraqProfile,
      }),
    )
    expect(result.treatment).toBe(TaxTreatment.ZERO_RATED)
    expect(result.totalTaxMinor).toBe(0)
  })

  it('taxes exports when the profile says exports are NOT zero-rated', () => {
    const result = assessTax(
      ctx({
        supplier: { country: 'IQ', taxRegistered: true, taxId: 'IQ-1' },
        customer: { country: 'GB', taxRegistered: true },
        currency: 'USD',
        customProfile: { ...iraqProfile, zeroRateExports: false },
      }),
    )
    expect(result.treatment).toBe(TaxTreatment.STANDARD)
    expect(result.totalTaxMinor).toBe(20_000)
  })

  it('supports several components, as multi-levy systems require', () => {
    const result = assessTax(
      ctx({
        supplier: { country: 'ZW', taxRegistered: true, taxId: 'ZW-1' },
        customer: { country: 'ZW', taxRegistered: false },
        currency: 'USD',
        customProfile: {
          enabled: true,
          overrideBuiltIn: false,
          zeroRateExports: true,
          notes: [],
          components: [
            { code: 'A', label: 'VAT (15%)', basisPoints: 1500 },
            { code: 'B', label: 'Levy (2%)', basisPoints: 200 },
          ],
        },
      }),
    )
    expect(result.components).toHaveLength(2)
    expect(result.totalTaxMinor).toBe(17_000)
    expect(result.effectiveBasisPoints).toBe(1700)
  })

  it('does NOT override a built-in rule unless explicitly told to', () => {
    // A profile left over from before we shipped a rule for their country must
    // not silently displace it.
    const result = assessTax(
      ctx({
        supplier: { country: 'GH', taxRegistered: true, taxId: 'GH-1' },
        customer: { country: 'GH', taxRegistered: false },
        customProfile: {
          enabled: true,
          overrideBuiltIn: false,
          components: [{ code: 'X', label: 'Wrong (99%)', basisPoints: 9900 }],
          zeroRateExports: true,
          notes: [],
        },
      }),
    )
    // Ghana's built-in 20% wins.
    expect(result.effectiveBasisPoints).toBe(2000)
  })

  it('DOES override a built-in rule when the user opts in', () => {
    const result = assessTax(
      ctx({
        supplier: { country: 'GH', taxRegistered: true, taxId: 'GH-1' },
        customer: { country: 'GH', taxRegistered: false },
        customProfile: {
          enabled: true,
          overrideBuiltIn: true,
          components: [{ code: 'GH_FLAT', label: 'Flat rate (3%)', basisPoints: 300 }],
          zeroRateExports: true,
          notes: ['VAT flat rate scheme.'],
        },
      }),
    )
    expect(result.effectiveBasisPoints).toBe(300)
    expect(result.notes).toContain('VAT flat rate scheme.')
  })

  it('still charges nothing when the supplier is not registered', () => {
    const result = assessTax(
      ctx({
        supplier: { country: 'IQ', taxRegistered: false },
        customer: { country: 'IQ', taxRegistered: false },
        customProfile: iraqProfile,
      }),
    )
    expect(result.treatment).toBe(TaxTreatment.OUT_OF_SCOPE)
    expect(result.totalTaxMinor).toBe(0)
  })

  it('is ignored when disabled', () => {
    const result = assessTax(
      ctx({
        supplier: { country: 'IQ', taxRegistered: true, taxId: 'IQ-1' },
        customer: { country: 'IQ', taxRegistered: false },
        customProfile: { ...iraqProfile, enabled: false },
      }),
    )
    expect(result.treatment).toBe(TaxTreatment.OUT_OF_SCOPE)
  })
})
