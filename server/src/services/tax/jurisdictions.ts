/**
 * Jurisdiction rules.
 *
 * Each export is self-contained. To support a new country, write a rule here
 * (or in its own file) and register it in registry.ts. Nothing in engine.ts
 * changes.
 *
 * Sources are cited inline because tax rates are the one thing in this codebase
 * that a reviewer cannot verify by reading the code.
 */

import { applyBasisPoints, sum } from '../../core/money'
import {
  JurisdictionRule,
  TaxAssessment,
  TaxComponent,
  TaxContext,
  TaxTreatment,
} from './types'

/** Countries in the EU VAT area, for reverse-charge and OSS determination. */
export const EU_MEMBER_STATES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR',
  'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO',
  'SE', 'SI', 'SK',
])

/** Standard VAT rates in basis points, by member state. */
const EU_STANDARD_RATES: Record<string, number> = {
  AT: 2000, BE: 2100, BG: 2000, CY: 1900, CZ: 2100, DE: 1900, DK: 2500,
  EE: 2200, ES: 2100, FI: 2550, FR: 2000, GR: 2400, HR: 2500, HU: 2700,
  IE: 2300, IT: 2200, LT: 2100, LU: 1700, LV: 2100, MT: 1800, NL: 2100,
  PL: 2300, PT: 2300, RO: 2100, SE: 2500, SI: 2200, SK: 2300,
}

function emptyAssessment(
  treatment: TaxTreatment,
  jurisdiction: string | null,
  notes: string[] = [],
): TaxAssessment {
  return {
    treatment,
    jurisdiction,
    components: [],
    totalTaxMinor: 0,
    effectiveBasisPoints: 0,
    notes,
  }
}

function build(
  jurisdiction: string,
  specs: Array<{ code: string; label: string; basisPoints: number }>,
  ctx: TaxContext,
  notes: string[] = [],
): TaxAssessment {
  const components: TaxComponent[] = specs.map((s) => ({
    code: s.code,
    label: s.label,
    basisPoints: s.basisPoints,
    amountMinor: applyBasisPoints(ctx.baseMinor, s.basisPoints),
  }))
  const totalTaxMinor = sum(components.map((c) => c.amountMinor))
  return {
    treatment: TaxTreatment.STANDARD,
    jurisdiction,
    components,
    totalTaxMinor,
    effectiveBasisPoints: specs.reduce((a, s) => a + s.basisPoints, 0),
    notes,
  }
}

/**
 * Shared preamble applied to every jurisdiction: an unregistered supplier
 * cannot charge tax, and an explicit category override wins over rate lookup.
 */
function preamble(ctx: TaxContext, jurisdiction: string): TaxAssessment | null {
  if (!ctx.supplier.taxRegistered) {
    return emptyAssessment(TaxTreatment.OUT_OF_SCOPE, null, [
      'Supplier is not registered for indirect tax; no tax charged.',
    ])
  }
  if (ctx.categoryOverride === TaxTreatment.ZERO_RATED) {
    return emptyAssessment(TaxTreatment.ZERO_RATED, jurisdiction, [
      'Zero-rated supply.',
    ])
  }
  if (ctx.categoryOverride === TaxTreatment.EXEMPT) {
    return emptyAssessment(TaxTreatment.EXEMPT, jurisdiction, ['Exempt supply.'])
  }
  return null
}

/* ------------------------------------------------------------------------- */
/* Ghana                                                                      */
/* ------------------------------------------------------------------------- */

/** Act 1151 commencement: 1 January 2026. */
const GH_ACT_1151_START = new Date('2026-01-01T00:00:00Z')

/**
 * Ghana. Value Added Tax Act, 2025 (Act 1151), effective 1 Jan 2026.
 *
 * Under Act 1151 the COVID-19 Health Recovery Levy is abolished and NHIL and
 * GETFund are re-coupled onto the SAME taxable value as VAT, giving a flat
 * 20% effective rate (15% + 2.5% + 2.5%) rather than the old cascading
 * computation that produced ~21.9%.
 *
 * The pre-2026 branch is retained because invoices can be back-dated, and
 * silently applying today's rate to last year's supply is a compliance defect.
 * Source: GRA, "VAT" (gra.gov.gh); VAT Act 2025 (Act 1151).
 */
export const ghanaRule: JurisdictionRule = {
  country: 'GH',
  name: 'Ghana VAT & Levies',

  placeOfSupply() {
    // Exports of goods and services from Ghana are zero-rated, so the supply
    // stays in Ghana's jurisdiction but attracts a 0% rate (handled in assess).
    return 'GH'
  },

  assess(ctx) {
    const pre = preamble(ctx, 'GH')
    if (pre) return pre

    // Export of goods or services to a non-resident: zero-rated.
    if (ctx.customer.country !== 'GH') {
      return emptyAssessment(TaxTreatment.ZERO_RATED, 'GH', [
        'Zero-rated export of goods or services under the VAT Act, 2025 (Act 1151).',
      ])
    }

    if (ctx.date >= GH_ACT_1151_START) {
      return build(
        'GH',
        [
          { code: 'GH_VAT', label: 'VAT (15%)', basisPoints: 1500 },
          { code: 'GH_NHIL', label: 'NHIL (2.5%)', basisPoints: 250 },
          { code: 'GH_GETFUND', label: 'GETFund Levy (2.5%)', basisPoints: 250 },
        ],
        ctx,
        ['VAT, NHIL and GETFund Levy charged on the same taxable value (Act 1151).'],
      )
    }

    // Legacy computation: NHIL + GETFund + COVID levy sit OUTSIDE the VAT base,
    // so VAT is charged on (base + those levies), the cascade Act 1151 removed.
    const nhil = applyBasisPoints(ctx.baseMinor, 250)
    const getfund = applyBasisPoints(ctx.baseMinor, 250)
    const covid = applyBasisPoints(ctx.baseMinor, 100)
    const vatBase = ctx.baseMinor + nhil + getfund + covid
    const vat = applyBasisPoints(vatBase, 1500)
    const components: TaxComponent[] = [
      { code: 'GH_NHIL', label: 'NHIL (2.5%)', basisPoints: 250, amountMinor: nhil },
      { code: 'GH_GETFUND', label: 'GETFund Levy (2.5%)', basisPoints: 250, amountMinor: getfund },
      { code: 'GH_COVID', label: 'COVID-19 Levy (1%)', basisPoints: 100, amountMinor: covid },
      { code: 'GH_VAT', label: 'VAT (15%)', basisPoints: 1500, amountMinor: vat },
    ]
    const totalTaxMinor = sum(components.map((c) => c.amountMinor))
    return {
      treatment: TaxTreatment.STANDARD,
      jurisdiction: 'GH',
      components,
      totalTaxMinor,
      effectiveBasisPoints: Math.round((totalTaxMinor / ctx.baseMinor) * 10_000) || 0,
      notes: ['Pre-2026 cascading computation applied for a back-dated supply.'],
    }
  },
}

/* ------------------------------------------------------------------------- */
/* United Kingdom                                                             */
/* ------------------------------------------------------------------------- */

/**
 * United Kingdom. VAT at 20% standard rate.
 * Services supplied to an overseas business customer are outside the scope of
 * UK VAT under the general place-of-supply rule (VATA 1994 s.7A); the customer
 * accounts for it under reverse charge.
 */
export const unitedKingdomRule: JurisdictionRule = {
  country: 'GB',
  name: 'UK VAT',

  placeOfSupply(ctx) {
    const isB2B = ctx.customer.isBusiness === true && Boolean(ctx.customer.taxId)
    if (ctx.supplyType !== 'goods' && isB2B && ctx.customer.country !== 'GB') {
      return ctx.customer.country
    }
    return 'GB'
  },

  assess(ctx) {
    const pre = preamble(ctx, 'GB')
    if (pre) return pre

    if (ctx.customer.country !== 'GB') {
      if (ctx.supplyType === 'goods') {
        return emptyAssessment(TaxTreatment.ZERO_RATED, 'GB', [
          'Zero-rated export of goods.',
        ])
      }
      return emptyAssessment(TaxTreatment.REVERSE_CHARGE, 'GB', [
        'Reverse charge: customer to account for VAT in their own jurisdiction.',
      ])
    }

    return build('GB', [{ code: 'UK_VAT', label: 'VAT (20%)', basisPoints: 2000 }], ctx)
  },
}

/* ------------------------------------------------------------------------- */
/* European Union                                                             */
/* ------------------------------------------------------------------------- */

/**
 * EU member state VAT.
 *
 * Three distinct paths, and getting them confused is the classic freelancer
 * invoicing error:
 *  1. Domestic  -> local standard rate.
 *  2. Intra-EU B2B with a valid VAT ID -> reverse charge at 0%, mandatory note.
 *  3. Intra-EU B2C digital services -> DESTINATION rate under the OSS regime,
 *     which is why placeOfSupply can redirect to the customer's country.
 */
export function createEuRule(country: string): JurisdictionRule {
  const rate = EU_STANDARD_RATES[country]
  if (rate === undefined) throw new Error(`No EU VAT rate configured for ${country}`)

  return {
    country,
    name: `${country} VAT`,

    placeOfSupply(ctx) {
      const cc = ctx.customer.country
      const isB2B = ctx.customer.isBusiness === true && Boolean(ctx.customer.taxId)

      // B2C digital services to another member state are taxed where the
      // consumer is (One Stop Shop).
      if (
        ctx.supplyType === 'digital_services' &&
        !isB2B &&
        EU_MEMBER_STATES.has(cc) &&
        cc !== country
      ) {
        return cc
      }
      return country
    },

    assess(ctx) {
      const pre = preamble(ctx, country)
      if (pre) return pre

      const cc = ctx.customer.country
      const isB2B = ctx.customer.isBusiness === true && Boolean(ctx.customer.taxId)

      // Domestic supply.
      if (cc === country) {
        return build(
          country,
          [{ code: `${country}_VAT`, label: `VAT (${rate / 100}%)`, basisPoints: rate }],
          ctx,
        )
      }

      // Intra-EU B2B: liability shifts to the customer.
      if (EU_MEMBER_STATES.has(cc) && isB2B) {
        return emptyAssessment(TaxTreatment.REVERSE_CHARGE, country, [
          'Reverse charge. VAT to be accounted for by the recipient under Article 196, Council Directive 2006/112/EC.',
        ])
      }

      // Intra-EU B2C: engine will have redirected via placeOfSupply for digital
      // services. Anything still here is taxed at origin.
      if (EU_MEMBER_STATES.has(cc)) {
        return build(
          country,
          [{ code: `${country}_VAT`, label: `VAT (${rate / 100}%)`, basisPoints: rate }],
          ctx,
        )
      }

      // Export outside the EU.
      return emptyAssessment(TaxTreatment.ZERO_RATED, country, [
        'Supply outside the European Union, zero-rated.',
      ])
    },
  }
}

/* ------------------------------------------------------------------------- */
/* United States                                                              */
/* ------------------------------------------------------------------------- */

/**
 * United States sales tax.
 *
 * There is no federal sales tax and rates are set at state (and often county
 * and city) level, so a genuinely correct engine needs a rate service and
 * economic-nexus tracking. TaxPedestal ships state-level standard rates and
 * treats professional services as non-taxable by default, which is right in
 * most states and wrong in a few.
 *
 * This is a KNOWN, DOCUMENTED limitation, logged as technical debt item
 * TD-003 rather than pretended away, and the reason US tax is surfaced in the
 * UI with a "verify before filing" affordance.
 */
const US_STATE_RATES: Record<string, number> = {
  AL: 400, AZ: 560, AR: 650, CA: 725, CO: 290, CT: 635, DC: 600, FL: 600,
  GA: 400, HI: 400, ID: 600, IL: 625, IN: 700, IA: 600, KS: 650, KY: 600,
  LA: 500, ME: 550, MD: 600, MA: 625, MI: 600, MN: 688, MS: 700, MO: 423,
  NE: 550, NV: 685, NJ: 663, NM: 488, NY: 400, NC: 475, ND: 500, OH: 575,
  OK: 450, PA: 600, RI: 700, SC: 600, SD: 420, TN: 700, TX: 625, UT: 610,
  VT: 600, VA: 530, WA: 650, WV: 600, WI: 500, WY: 400,
  // No statewide sales tax.
  AK: 0, DE: 0, MT: 0, NH: 0, OR: 0,
}

export const unitedStatesRule: JurisdictionRule = {
  country: 'US',
  name: 'US Sales Tax',

  placeOfSupply() {
    // Destination-based sourcing is the majority rule post-Wayfair.
    return 'US'
  },

  assess(ctx) {
    const pre = preamble(ctx, 'US')
    if (pre) return pre

    if (ctx.customer.country !== 'US') {
      return emptyAssessment(TaxTreatment.OUT_OF_SCOPE, 'US', [
        'Customer outside the United States, no US sales tax applied.',
      ])
    }

    // Services are not generally subject to sales tax; goods and digital
    // products usually are. Users can override per line.
    if (ctx.supplyType === 'services') {
      return emptyAssessment(TaxTreatment.EXEMPT, 'US', [
        'Professional services treated as non-taxable. Verify against your state rules.',
      ])
    }

    const state = (ctx.customer.region ?? '').toUpperCase()
    const rate = US_STATE_RATES[state]

    if (rate === undefined) {
      return emptyAssessment(TaxTreatment.OUT_OF_SCOPE, 'US', [
        'No US state selected for the customer, sales tax not calculated.',
      ])
    }
    if (rate === 0) {
      return emptyAssessment(TaxTreatment.ZERO_RATED, 'US', [
        `${state} has no statewide sales tax.`,
      ])
    }

    return build(
      'US',
      [{ code: 'US_SALES_TAX', label: `${state} Sales Tax (${rate / 100}%)`, basisPoints: rate }],
      ctx,
      ['State-level base rate only. Local district taxes may apply.'],
    )
  },
}

/* ------------------------------------------------------------------------- */
/* Canada                                                                     */
/* ------------------------------------------------------------------------- */

/** GST/HST/PST by province, in basis points. */
const CA_PROVINCE_TAX: Record<string, Array<{ code: string; label: string; basisPoints: number }>> = {
  AB: [{ code: 'CA_GST', label: 'GST (5%)', basisPoints: 500 }],
  BC: [
    { code: 'CA_GST', label: 'GST (5%)', basisPoints: 500 },
    { code: 'CA_PST', label: 'PST (7%)', basisPoints: 700 },
  ],
  MB: [
    { code: 'CA_GST', label: 'GST (5%)', basisPoints: 500 },
    { code: 'CA_RST', label: 'RST (7%)', basisPoints: 700 },
  ],
  NB: [{ code: 'CA_HST', label: 'HST (15%)', basisPoints: 1500 }],
  NL: [{ code: 'CA_HST', label: 'HST (15%)', basisPoints: 1500 }],
  NS: [{ code: 'CA_HST', label: 'HST (14%)', basisPoints: 1400 }],
  NT: [{ code: 'CA_GST', label: 'GST (5%)', basisPoints: 500 }],
  NU: [{ code: 'CA_GST', label: 'GST (5%)', basisPoints: 500 }],
  ON: [{ code: 'CA_HST', label: 'HST (13%)', basisPoints: 1300 }],
  PE: [{ code: 'CA_HST', label: 'HST (15%)', basisPoints: 1500 }],
  QC: [
    { code: 'CA_GST', label: 'GST (5%)', basisPoints: 500 },
    { code: 'CA_QST', label: 'QST (9.975%)', basisPoints: 998 },
  ],
  SK: [
    { code: 'CA_GST', label: 'GST (5%)', basisPoints: 500 },
    { code: 'CA_PST', label: 'PST (6%)', basisPoints: 600 },
  ],
  YT: [{ code: 'CA_GST', label: 'GST (5%)', basisPoints: 500 }],
}

export const canadaRule: JurisdictionRule = {
  country: 'CA',
  name: 'Canada GST/HST',
  placeOfSupply() {
    return 'CA'
  },
  assess(ctx) {
    const pre = preamble(ctx, 'CA')
    if (pre) return pre

    if (ctx.customer.country !== 'CA') {
      return emptyAssessment(TaxTreatment.ZERO_RATED, 'CA', [
        'Zero-rated export outside Canada.',
      ])
    }

    const province = (ctx.customer.region ?? '').toUpperCase()
    const specs = CA_PROVINCE_TAX[province]
    if (!specs) {
      return emptyAssessment(TaxTreatment.OUT_OF_SCOPE, 'CA', [
        'No Canadian province selected for the customer. GST/HST not calculated.',
      ])
    }
    return build('CA', specs, ctx)
  },
}

/* ------------------------------------------------------------------------- */
/* India                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * India GST. Intra-state supplies split into CGST + SGST; inter-state supplies
 * attract a single IGST at the combined rate. Default slab is 18%.
 */
export const indiaRule: JurisdictionRule = {
  country: 'IN',
  name: 'India GST',
  placeOfSupply() {
    return 'IN'
  },
  assess(ctx) {
    const pre = preamble(ctx, 'IN')
    if (pre) return pre

    if (ctx.customer.country !== 'IN') {
      return emptyAssessment(TaxTreatment.ZERO_RATED, 'IN', [
        'Zero-rated export of services under LUT/Bond.',
      ])
    }

    const supplierState = (ctx.supplier.region ?? '').toUpperCase()
    const customerState = (ctx.customer.region ?? '').toUpperCase()
    const interState = Boolean(supplierState && customerState && supplierState !== customerState)

    if (interState) {
      return build('IN', [{ code: 'IN_IGST', label: 'IGST (18%)', basisPoints: 1800 }], ctx)
    }
    return build(
      'IN',
      [
        { code: 'IN_CGST', label: 'CGST (9%)', basisPoints: 900 },
        { code: 'IN_SGST', label: 'SGST (9%)', basisPoints: 900 },
      ],
      ctx,
    )
  },
}

/* ------------------------------------------------------------------------- */
/* Australia                                                                  */
/* ------------------------------------------------------------------------- */

export const australiaRule: JurisdictionRule = {
  country: 'AU',
  name: 'Australia GST',
  placeOfSupply() {
    return 'AU'
  },
  assess(ctx) {
    const pre = preamble(ctx, 'AU')
    if (pre) return pre
    if (ctx.customer.country !== 'AU') {
      return emptyAssessment(TaxTreatment.ZERO_RATED, 'AU', [
        'GST-free supply to a non-resident.',
      ])
    }
    return build('AU', [{ code: 'AU_GST', label: 'GST (10%)', basisPoints: 1000 }], ctx)
  },
}

/* ------------------------------------------------------------------------- */
/* Other single-rate jurisdictions                                            */
/* ------------------------------------------------------------------------- */

/**
 * Factory for the common shape: one national rate, exports zero-rated.
 * Covers the long tail without a bespoke module each time.
 */
export function createSingleRateRule(opts: {
  country: string
  name: string
  code: string
  label: string
  basisPoints: number
  exportNote?: string
}): JurisdictionRule {
  return {
    country: opts.country,
    name: opts.name,
    placeOfSupply() {
      return opts.country
    },
    assess(ctx) {
      const pre = preamble(ctx, opts.country)
      if (pre) return pre
      if (ctx.customer.country !== opts.country) {
        return emptyAssessment(TaxTreatment.ZERO_RATED, opts.country, [
          opts.exportNote ?? 'Zero-rated export.',
        ])
      }
      return build(
        opts.country,
        [{ code: opts.code, label: opts.label, basisPoints: opts.basisPoints }],
        ctx,
      )
    },
  }
}

export const nigeriaRule = createSingleRateRule({
  country: 'NG', name: 'Nigeria VAT', code: 'NG_VAT', label: 'VAT (7.5%)', basisPoints: 750,
})
export const kenyaRule = createSingleRateRule({
  country: 'KE', name: 'Kenya VAT', code: 'KE_VAT', label: 'VAT (16%)', basisPoints: 1600,
})
export const southAfricaRule = createSingleRateRule({
  country: 'ZA', name: 'South Africa VAT', code: 'ZA_VAT', label: 'VAT (15%)', basisPoints: 1500,
})
export const singaporeRule = createSingleRateRule({
  country: 'SG', name: 'Singapore GST', code: 'SG_GST', label: 'GST (9%)', basisPoints: 900,
})
export const uaeRule = createSingleRateRule({
  country: 'AE', name: 'UAE VAT', code: 'AE_VAT', label: 'VAT (5%)', basisPoints: 500,
})
export const switzerlandRule = createSingleRateRule({
  country: 'CH', name: 'Switzerland VAT', code: 'CH_VAT', label: 'VAT (8.1%)', basisPoints: 810,
})
export const japanRule = createSingleRateRule({
  country: 'JP', name: 'Japan Consumption Tax', code: 'JP_CT', label: 'Consumption Tax (10%)', basisPoints: 1000,
})
export const brazilRule = createSingleRateRule({
  country: 'BR', name: 'Brazil ISS', code: 'BR_ISS', label: 'ISS (5%)', basisPoints: 500,
})

/* ------------------------------------------------------------------------- */
/* China                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * China. VAT Law of the People's Republic of China, effective 1 January 2026.
 *
 * The law codified the existing three-tier structure rather than changing it:
 *   13%  most goods, processing, repair, leasing of movable property
 *    9%  transport, postal, basic telecoms, immovable property, books,
 *        agricultural products
 *    6%  other services, including modern and professional services
 *
 * TaxPedestal maps supply type to the tier: goods -> 13%, services and digital
 * services -> 6%. The 9% tier covers specific sectors that a general invoicing
 * tool cannot infer from a line description, so a business in transport or
 * construction should set a custom profile at 9%. That limitation is stated
 * here rather than silently mis-charging.
 *
 * Small-scale taxpayers (turnover under CNY 5m) pay a levy of 3%, temporarily
 * reduced to 1% through 31 December 2027, also a custom-profile case, since we
 * cannot know a taxpayer's classification.
 *
 * Source: EY and Baker McKenzie summaries of the 2026 VAT Law; PwC Worldwide
 * Tax Summaries. China.
 */
export const chinaRule: JurisdictionRule = {
  country: 'CN',
  name: 'China VAT',
  placeOfSupply() {
    return 'CN'
  },
  assess(ctx) {
    const pre = preamble(ctx, 'CN')
    if (pre) return pre

    if (ctx.customer.country !== 'CN') {
      return emptyAssessment(TaxTreatment.ZERO_RATED, 'CN', [
        'Zero-rated or exempt export. Confirm the applicable export refund rate.',
      ])
    }

    const isGoods = ctx.supplyType === 'goods'
    return build(
      'CN',
      isGoods
        ? [{ code: 'CN_VAT', label: 'VAT (13%)', basisPoints: 1300 }]
        : [{ code: 'CN_VAT', label: 'VAT (6%)', basisPoints: 600 }],
      ctx,
      isGoods
        ? []
        : ['General taxpayer rate for services. Transport and telecoms are 9%, set a custom rate if that applies to you.'],
    )
  },
}

/* ------------------------------------------------------------------------- */
/* Israel                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Israel. VAT (Ma'am) at 18%, raised from 17% on 1 January 2025. A further
 * rise to 19% was proposed for 2026 and not adopted.
 *
 * Israel has no reduced positive rates: a supply is standard-rated, zero-rated
 * or exempt. Exports of goods and services to non-residents are zero-rated.
 * Eilat operates as a VAT-free zone, which a business trading there should
 * handle with a custom profile.
 *
 * Source: PwC Worldwide Tax Summaries. Israel; Israeli Tax Authority.
 */
const IL_RATE_CHANGE_2025 = new Date('2025-01-01T00:00:00Z')

export const israelRule: JurisdictionRule = {
  country: 'IL',
  name: 'Israel VAT',
  placeOfSupply() {
    return 'IL'
  },
  assess(ctx) {
    const pre = preamble(ctx, 'IL')
    if (pre) return pre

    if (ctx.customer.country !== 'IL') {
      return emptyAssessment(TaxTreatment.ZERO_RATED, 'IL', [
        'Zero-rated supply to a non-resident.',
      ])
    }

    // Back-dated invoices must use the rate that applied on the supply date.
    const rate = ctx.date >= IL_RATE_CHANGE_2025 ? 1800 : 1700
    return build(
      'IL',
      [{ code: 'IL_VAT', label: `VAT (${rate / 100}%)`, basisPoints: rate }],
      ctx,
    )
  },
}

/* ------------------------------------------------------------------------- */
/* Further single-rate jurisdictions                                          */
/* ------------------------------------------------------------------------- */

export const saudiArabiaRule = createSingleRateRule({
  country: 'SA', name: 'Saudi Arabia VAT', code: 'SA_VAT', label: 'VAT (15%)', basisPoints: 1500,
})
export const turkeyRule = createSingleRateRule({
  country: 'TR', name: 'Türkiye VAT', code: 'TR_KDV', label: 'KDV (20%)', basisPoints: 2000,
})
export const mexicoRule = createSingleRateRule({
  country: 'MX', name: 'Mexico IVA', code: 'MX_IVA', label: 'IVA (16%)', basisPoints: 1600,
})
export const norwayRule = createSingleRateRule({
  country: 'NO', name: 'Norway VAT', code: 'NO_MVA', label: 'MVA (25%)', basisPoints: 2500,
})
export const newZealandRule = createSingleRateRule({
  country: 'NZ', name: 'New Zealand GST', code: 'NZ_GST', label: 'GST (15%)', basisPoints: 1500,
})
export const southKoreaRule = createSingleRateRule({
  country: 'KR', name: 'South Korea VAT', code: 'KR_VAT', label: 'VAT (10%)', basisPoints: 1000,
})
export const thailandRule = createSingleRateRule({
  country: 'TH', name: 'Thailand VAT', code: 'TH_VAT', label: 'VAT (7%)', basisPoints: 700,
})
export const egyptRule = createSingleRateRule({
  country: 'EG', name: 'Egypt VAT', code: 'EG_VAT', label: 'VAT (14%)', basisPoints: 1400,
})
export const moroccoRule = createSingleRateRule({
  country: 'MA', name: 'Morocco VAT', code: 'MA_TVA', label: 'TVA (20%)', basisPoints: 2000,
})
export const philippinesRule = createSingleRateRule({
  country: 'PH', name: 'Philippines VAT', code: 'PH_VAT', label: 'VAT (12%)', basisPoints: 1200,
})
