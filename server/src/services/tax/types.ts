/**
 * Tax engine contracts.
 *
 * The engine answers one question: given a supplier, a customer, what is being
 * supplied, and a taxable base, which tax components apply and at what rate?
 *
 * It is deliberately a pure function of its inputs — no database, no clock, no
 * network. That makes the entire tax surface unit-testable, which matters
 * because tax bugs are silent: an invoice with the wrong VAT still looks
 * perfectly valid to the person sending it.
 */

/** How a supply is treated for indirect tax purposes. */
export enum TaxTreatment {
  /** Normal domestic tax applies. */
  STANDARD = 'STANDARD',
  /** Taxable in principle but at 0% (e.g. exports of goods). Input credit survives. */
  ZERO_RATED = 'ZERO_RATED',
  /** Outside the tax net (e.g. exempt financial services). No input credit. */
  EXEMPT = 'EXEMPT',
  /** Liability shifts to the customer (intra-EU B2B, UK B2B imports of services). */
  REVERSE_CHARGE = 'REVERSE_CHARGE',
  /** No taxing jurisdiction reached — supplier not registered, or no rule. */
  OUT_OF_SCOPE = 'OUT_OF_SCOPE',
}

export type SupplyType = 'goods' | 'services' | 'digital_services'

export interface TaxParty {
  /** ISO 3166-1 alpha-2, uppercase. */
  country: string
  /** Sub-national code where it changes the answer: US state, CA province, IN state. */
  region?: string | null
  /** Is this party registered for the relevant indirect tax? */
  taxRegistered: boolean
  /** VAT / GST / TIN number, unvalidated at this layer. */
  taxId?: string | null
  /** Customers only: business (B2B) vs consumer (B2C). Changes place of supply. */
  isBusiness?: boolean
}

/**
 * An organisation's own tax definition.
 *
 * THE ESCAPE HATCH THAT MAKES THE PRODUCT ACTUALLY GLOBAL.
 *
 * No vendor can ship rules for all ~249 territories, and some do not fit the
 * VAT/GST shape at all — Iraq, for instance, has no general VAT, only a narrow
 * sales tax on particular services. Without a way for the user to state their
 * own rules, those businesses are simply unserved.
 *
 * A profile is used when the supplier's country has no built-in rule, or when
 * the user explicitly overrides one (their accountant knows their situation
 * better than our defaults do — a reduced rate, a regional exemption, an
 * industry scheme).
 */
export interface CustomTaxProfile {
  enabled: boolean
  /** Use this even where a built-in rule exists. */
  overrideBuiltIn: boolean
  /** Named components, e.g. [{ code: 'IQ_ST', label: 'Sales Tax (20%)', basisPoints: 2000 }]. */
  components: Array<{ code: string; label: string; basisPoints: number }>
  /** Most indirect tax systems zero-rate exports; a few do not. */
  zeroRateExports: boolean
  /** Statements to print on the invoice face. */
  notes: string[]
}

export interface TaxContext {
  supplier: TaxParty
  customer: TaxParty
  supplyType: SupplyType
  /** Taxable base in integer minor units, discounts already applied. */
  baseMinor: number
  currency: string
  /** Supply date — rules change over time (Ghana Act 1151 applies from 2026-01-01). */
  date: Date
  /**
   * Per-line override letting a user mark something zero-rated or exempt when
   * they know their own product classification better than we do
   * (e.g. locally manufactured textiles in Ghana, books in the UK).
   */
  categoryOverride?: TaxTreatment | null
  /** The supplier organisation's own tax definition, where they have set one. */
  customProfile?: CustomTaxProfile | null
}

/**
 * One named tax line. Kept separate rather than collapsed into a single rate
 * because compliance requires them shown separately on the invoice face —
 * Ghana's GRA mandates VAT, NHIL and GETFund appear as distinct lines even
 * though they now share one base.
 */
export interface TaxComponent {
  /** Stable machine code, e.g. 'GH_VAT', 'GH_NHIL', 'UK_VAT', 'IN_CGST'. */
  code: string
  /** Human label rendered on the invoice, e.g. 'VAT (15%)'. */
  label: string
  /** Rate in basis points. 1500 = 15.00%. */
  basisPoints: number
  /** Computed amount in minor units. */
  amountMinor: number
}

export interface TaxAssessment {
  treatment: TaxTreatment
  /** Jurisdiction whose rules were applied, or null when out of scope. */
  jurisdiction: string | null
  components: TaxComponent[]
  totalTaxMinor: number
  /** Combined effective rate in basis points, for display and analytics. */
  effectiveBasisPoints: number
  /**
   * Statements that must be printed on the invoice for it to be compliant,
   * e.g. the reverse-charge declaration required by EU Directive 2006/112/EC.
   */
  notes: string[]
}

/**
 * A jurisdiction rule. Adding a new country means adding one of these and
 * registering it — no edits to the engine. That is the Open/Closed Principle
 * doing actual work rather than appearing in a diagram.
 */
export interface JurisdictionRule {
  /** ISO 3166-1 alpha-2 of the taxing country. */
  readonly country: string
  readonly name: string
  /**
   * Determines where the supply is taxed. Returning a country code other than
   * this rule's own country re-routes assessment to that jurisdiction
   * (destination-based digital services), which the engine resolves.
   */
  placeOfSupply(ctx: TaxContext): string
  assess(ctx: TaxContext): TaxAssessment
}
