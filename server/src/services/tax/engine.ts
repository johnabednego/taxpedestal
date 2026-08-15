/**
 * Tax engine + jurisdiction registry.
 *
 * Resolution order:
 *   1. Look up the supplier's jurisdiction rule.
 *   2. Ask that rule where the supply is taxed (place of supply).
 *   3. If it points elsewhere, hand off to that jurisdiction's rule.
 *   4. Assess.
 *
 * The single redirect hop is deliberate and bounded. Allowing rules to bounce
 * a supply between jurisdictions indefinitely would be a denial-of-service in
 * a pure function, so the engine takes exactly one hop and then commits.
 */

import { applyBasisPoints, assertInteger } from '../../core/money'
import {
  australiaRule,
  brazilRule,
  canadaRule,
  chinaRule,
  createEuRule,
  egyptRule,
  EU_MEMBER_STATES,
  ghanaRule,
  indiaRule,
  israelRule,
  japanRule,
  kenyaRule,
  mexicoRule,
  moroccoRule,
  newZealandRule,
  nigeriaRule,
  norwayRule,
  philippinesRule,
  saudiArabiaRule,
  singaporeRule,
  southAfricaRule,
  southKoreaRule,
  switzerlandRule,
  thailandRule,
  turkeyRule,
  uaeRule,
  unitedKingdomRule,
  unitedStatesRule,
} from './jurisdictions'
import {
  CustomTaxProfile,
  JurisdictionRule,
  TaxAssessment,
  TaxContext,
  TaxTreatment,
} from './types'

class JurisdictionRegistry {
  private readonly rules = new Map<string, JurisdictionRule>()

  register(rule: JurisdictionRule): this {
    const key = rule.country.toUpperCase()
    if (this.rules.has(key)) {
      throw new Error(`Duplicate jurisdiction rule for ${key}`)
    }
    this.rules.set(key, rule)
    return this
  }

  get(country: string): JurisdictionRule | undefined {
    return this.rules.get(country.toUpperCase())
  }

  has(country: string): boolean {
    return this.rules.has(country.toUpperCase())
  }

  /** Countries TaxPedestal can compute tax for. Drives the UI country picker. */
  supported(): string[] {
    return [...this.rules.keys()].sort()
  }
}

export const registry = new JurisdictionRegistry()

// Order is irrelevant; duplicates throw at boot, which is the desired failure
// mode, a misconfigured tax table should stop deployment, not ship silently.
registry
  .register(ghanaRule)
  .register(unitedKingdomRule)
  .register(unitedStatesRule)
  .register(canadaRule)
  .register(indiaRule)
  .register(australiaRule)
  .register(nigeriaRule)
  .register(kenyaRule)
  .register(southAfricaRule)
  .register(singaporeRule)
  .register(uaeRule)
  .register(switzerlandRule)
  .register(japanRule)
  .register(brazilRule)
  .register(chinaRule)
  .register(israelRule)
  .register(saudiArabiaRule)
  .register(turkeyRule)
  .register(mexicoRule)
  .register(norwayRule)
  .register(newZealandRule)
  .register(southKoreaRule)
  .register(thailandRule)
  .register(egyptRule)
  .register(moroccoRule)
  .register(philippinesRule)

for (const member of EU_MEMBER_STATES) {
  registry.register(createEuRule(member))
}

/**
 * Assess using an organisation's own tax definition.
 *
 * Deliberately simple, a flat set of components on the taxable value, with
 * exports optionally zero-rated. That covers the overwhelming majority of
 * indirect tax systems worldwide. Anything more exotic (cascading bases,
 * banded rates) needs a real rule, which is a pull request rather than a
 * settings change.
 */
function assessWithCustomProfile(
  ctx: TaxContext,
  profile: CustomTaxProfile,
): TaxAssessment {
  const jurisdiction = ctx.supplier.country.toUpperCase()

  if (!ctx.supplier.taxRegistered) {
    return {
      treatment: TaxTreatment.OUT_OF_SCOPE,
      jurisdiction: null,
      components: [],
      totalTaxMinor: 0,
      effectiveBasisPoints: 0,
      notes: ['Supplier is not registered for indirect tax; no tax charged.'],
    }
  }

  if (ctx.categoryOverride === TaxTreatment.ZERO_RATED) {
    return {
      treatment: TaxTreatment.ZERO_RATED,
      jurisdiction,
      components: [],
      totalTaxMinor: 0,
      effectiveBasisPoints: 0,
      notes: ['Zero-rated supply.'],
    }
  }
  if (ctx.categoryOverride === TaxTreatment.EXEMPT) {
    return {
      treatment: TaxTreatment.EXEMPT,
      jurisdiction,
      components: [],
      totalTaxMinor: 0,
      effectiveBasisPoints: 0,
      notes: ['Exempt supply.'],
    }
  }

  const isExport = ctx.customer.country.toUpperCase() !== jurisdiction
  if (isExport && profile.zeroRateExports) {
    return {
      treatment: TaxTreatment.ZERO_RATED,
      jurisdiction,
      components: [],
      totalTaxMinor: 0,
      effectiveBasisPoints: 0,
      notes: ['Zero-rated export.', ...profile.notes],
    }
  }

  const components = profile.components.map((component) => ({
    code: component.code,
    label: component.label,
    basisPoints: component.basisPoints,
    amountMinor: applyBasisPoints(ctx.baseMinor, component.basisPoints),
  }))

  return {
    treatment: components.length > 0 ? TaxTreatment.STANDARD : TaxTreatment.OUT_OF_SCOPE,
    jurisdiction,
    components,
    totalTaxMinor: components.reduce((acc, c) => acc + c.amountMinor, 0),
    effectiveBasisPoints: profile.components.reduce((acc, c) => acc + c.basisPoints, 0),
    notes: profile.notes,
  }
}

const OUT_OF_SCOPE: TaxAssessment = {
  treatment: TaxTreatment.OUT_OF_SCOPE,
  jurisdiction: null,
  components: [],
  totalTaxMinor: 0,
  effectiveBasisPoints: 0,
  notes: [],
}

/**
 * Assess indirect tax for a single taxable base.
 *
 * Never throws for an unknown country, an unsupported jurisdiction yields an
 * OUT_OF_SCOPE assessment with an explanatory note. A billing product that
 * 500s because someone picked an unusual country is worse than one that says
 * "we can't compute this, enter it manually".
 */
export function assessTax(ctx: TaxContext): TaxAssessment {
  assertInteger(ctx.baseMinor, 'baseMinor')

  if (ctx.baseMinor === 0) {
    return { ...OUT_OF_SCOPE, jurisdiction: ctx.supplier.country.toUpperCase() }
  }

  const supplierCountry = ctx.supplier.country.toUpperCase()
  const originRule = registry.get(supplierCountry)
  const profile = ctx.customProfile

  // The organisation's own definition wins when it is set to override, or when
  // we have no rule of our own. This is what lets a business in a jurisdiction
  // we do not cover still issue a correct invoice.
  if (profile?.enabled && (profile.overrideBuiltIn || !originRule)) {
    return assessWithCustomProfile(ctx, profile)
  }

  if (!originRule) {
    return {
      ...OUT_OF_SCOPE,
      notes: [
        `TaxPedestal has no built-in tax rules for ${supplierCountry}. ` +
          'Define your own tax in Settings, or leave invoices untaxed.',
      ],
    }
  }

  const normalised: TaxContext = {
    ...ctx,
    supplier: { ...ctx.supplier, country: supplierCountry },
    customer: { ...ctx.customer, country: ctx.customer.country.toUpperCase() },
  }

  const placeOfSupply = originRule.placeOfSupply(normalised).toUpperCase()

  if (placeOfSupply !== supplierCountry) {
    const destinationRule = registry.get(placeOfSupply)
    if (destinationRule) {
      // One hop only. The destination rule assesses as if it were domestic,
      // because that is what a destination-based regime means: the supplier
      // registers in (or reports via OSS to) the customer's jurisdiction.
      return destinationRule.assess({
        ...normalised,
        supplier: { ...normalised.supplier, country: placeOfSupply },
      })
    }
    // Destination has no rule, fall through to origin rather than dropping tax.
  }

  return originRule.assess(normalised)
}

/**
 * Assess a whole invoice line-by-line.
 *
 * Tax is computed PER LINE and then aggregated by component code, not computed
 * once on the invoice subtotal. This matters as soon as one invoice mixes rates
 * (a zero-rated line beside a standard-rated line), which is common and which
 * subtotal-level computation silently gets wrong.
 */
export interface LineForTax {
  /** Stable identifier so callers can map results back. */
  id: string
  baseMinor: number
  supplyType: TaxContext['supplyType']
  categoryOverride?: TaxTreatment | null
}

export interface InvoiceTaxResult {
  perLine: Array<{ id: string; assessment: TaxAssessment }>
  /** Component totals merged across lines, ready to print on the invoice. */
  summary: Array<{ code: string; label: string; basisPoints: number; amountMinor: number }>
  totalTaxMinor: number
  notes: string[]
  treatments: TaxTreatment[]
}

export function assessInvoice(
  lines: LineForTax[],
  shared: Omit<TaxContext, 'baseMinor' | 'supplyType' | 'categoryOverride'>,
): InvoiceTaxResult {
  const perLine = lines.map((line) => ({
    id: line.id,
    assessment: assessTax({
      ...shared,
      baseMinor: line.baseMinor,
      supplyType: line.supplyType,
      categoryOverride: line.categoryOverride ?? null,
    }),
  }))

  const merged = new Map<string, { code: string; label: string; basisPoints: number; amountMinor: number }>()
  const notes = new Set<string>()
  const treatments = new Set<TaxTreatment>()

  for (const { assessment } of perLine) {
    treatments.add(assessment.treatment)
    assessment.notes.forEach((n) => notes.add(n))
    for (const component of assessment.components) {
      const existing = merged.get(component.code)
      if (existing) {
        existing.amountMinor += component.amountMinor
      } else {
        merged.set(component.code, { ...component })
      }
    }
  }

  const summary = [...merged.values()].sort((a, b) => b.basisPoints - a.basisPoints)

  return {
    perLine,
    summary,
    totalTaxMinor: summary.reduce((acc, c) => acc + c.amountMinor, 0),
    notes: [...notes],
    treatments: [...treatments],
  }
}

export function supportedTaxCountries(): string[] {
  return registry.supported()
}
