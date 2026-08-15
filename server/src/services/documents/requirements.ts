/**
 * Invoice document requirements by jurisdiction.
 *
 * ============================================================================
 * WHY THIS IS NOT A TEMPLATE DESIGNER
 * ============================================================================
 * The obvious answer to "invoices look different everywhere" is to let users
 * design their own. That solves the wrong half of the problem.
 *
 * Invoice variation is two separate things:
 *
 *   PRESENTATION, logo, colour, layout, language, date format.
 *                  Genuinely a user preference. Handled by templates.ts.
 *
 *   LEGAL CONTENT, which particulars must appear for the document to be a
 *                   valid tax invoice. NOT a preference. The EU VAT Directive
 *                   Article 226 lists them; India requires HSN/SAC codes and
 *                   place of supply; Ghana requires each levy itemised.
 *
 * Handing legal content to a drag-and-drop canvas moves compliance onto the
 * least-equipped party. A user who deletes the reverse-charge declaration
 * because it looked untidy has an invoice their customer's tax authority can
 * reject, and they will blame the tool that let them.
 *
 * So this file encodes the second category as RULES, using the same registry
 * pattern as the tax engine. Adding a country is one entry. The template system
 * can then rearrange, restyle and translate freely, but cannot remove anything
 * this file marks required.
 *
 * IMPORTANT SCOPE NOTE: several countries mandate structured e-invoicing where
 * a PDF has no legal standing at all. Brazil (NF-e), Mexico (CFDI), Italy
 * (FatturaPA via SDI), India (IRN/e-invoice above a turnover threshold). Those
 * need certified integrations, not a nicer PDF. `eInvoicingRegime` flags them
 * so the product says so plainly instead of implying a PDF is sufficient.
 */

import type { IClient, IInvoice, IOrganisation } from '../../models'

/**
 * When the rules in this file were last checked against primary sources.
 *
 * Surfaced to the user with the compliance report. Tax and invoicing law moves,
 * and a product that presents year-old rules with unchanging confidence is
 * misleading in a way that a dated one is not. Update this when reviewing.
 */
export const RULES_REVIEWED_AT = '2026-08-14'

/** Past this, the UI tells the user the rules may be out of date. */
const RULES_STALE_AFTER_DAYS = 120

export function rulesAgeDays(now: Date = new Date()): number {
  return Math.floor(
    (now.getTime() - new Date(`${RULES_REVIEWED_AT}T00:00:00Z`).getTime()) / 86_400_000,
  )
}

export function rulesAreStale(now: Date = new Date()): boolean {
  return rulesAgeDays(now) > RULES_STALE_AFTER_DAYS
}

export interface DocumentContext {
  invoice: IInvoice
  organisation: IOrganisation
  client: IClient
  /** True when the tax snapshot indicates a liability shift. */
  isReverseCharge: boolean
  /** Supplier and customer are in different countries. */
  isCrossBorder: boolean
}

export type Severity = 'required' | 'recommended'

export interface RequirementIssue {
  field: string
  label: string
  severity: Severity
  /** Why it is needed, with the source. Shown to the user verbatim. */
  reason: string
}

export interface DocumentProfile {
  country: string
  /** Some jurisdictions mandate specific wording, e.g. India's "TAX INVOICE". */
  documentTitle?: string
  /** Fields that must be present. Evaluated against a live invoice. */
  check(ctx: DocumentContext): RequirementIssue[]
  /** Statements that must be printed on the document face. */
  statements(ctx: DocumentContext): string[]
  /** Extra columns the line table must carry, e.g. HSN codes. */
  lineColumns?: Array<{ key: string; label: string }>
  eInvoicingRegime?: { name: string; note: string }
}

/* -------------------------------------------------------------------------- */
/* Shared checks                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Particulars required almost universally. Kept separate so each jurisdiction
 * profile only states what is unusual about it.
 */
function baseChecks(ctx: DocumentContext): RequirementIssue[] {
  const issues: RequirementIssue[] = []
  const { organisation: org, client, invoice } = ctx

  if (!org.addressLine1 && !org.city) {
    issues.push({
      field: 'organisation.address',
      label: 'Your business address',
      severity: 'required',
      reason: 'A tax invoice must identify the supplier’s address.',
    })
  }

  if (org.taxRegistered && !org.taxId) {
    issues.push({
      field: 'organisation.taxId',
      label: 'Your tax registration number',
      severity: 'required',
      reason:
        'You are marked as tax registered, so your registration number must appear on invoices.',
    })
  }

  if (!client.addressLine1 && !client.city) {
    issues.push({
      field: 'client.address',
      label: 'Customer address',
      severity: 'recommended',
      reason: 'Most tax authorities expect the customer’s address on the invoice.',
    })
  }

  if (!invoice.number) {
    issues.push({
      field: 'invoice.number',
      label: 'Invoice number',
      severity: 'required',
      reason: 'Invoices must carry a unique sequential number.',
    })
  }

  return issues
}

function customerTaxIdRequired(ctx: DocumentContext, reason: string): RequirementIssue[] {
  if (ctx.client.taxId) return []
  return [
    {
      field: 'client.taxId',
      label: 'Customer tax registration number',
      severity: 'required',
      reason,
    },
  ]
}

/* -------------------------------------------------------------------------- */
/* European Union                                                              */
/* -------------------------------------------------------------------------- */

const EU_STATES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR',
  'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO',
  'SE', 'SI', 'SK',
])

/**
 * EU. Council Directive 2006/112/EC, Article 226.
 *
 * Article 226 enumerates the particulars a VAT invoice must contain. The ones
 * a general invoicing tool can actually verify are checked here; those that
 * depend on the supply itself (date of supply where it differs from the invoice
 * date, unit price exclusive of VAT) are structurally guaranteed by the data
 * model.
 */
function createEuProfile(country: string): DocumentProfile {
  return {
    country,
    check(ctx) {
      const issues = baseChecks(ctx)

      // Art. 226(4): the customer's VAT identification number is required
      // where the customer is liable for the tax, i.e. reverse charge.
      if (ctx.isReverseCharge) {
        issues.push(
          ...customerTaxIdRequired(
            ctx,
            'Reverse charge applies, so the customer’s VAT identification number must appear on the invoice (Article 226(4), Directive 2006/112/EC).',
          ),
        )
      }

      if (!ctx.organisation.taxId) {
        issues.push({
          field: 'organisation.taxId',
          label: 'Your VAT identification number',
          severity: 'required',
          reason: 'Article 226(3) requires the supplier’s VAT identification number.',
        })
      }

      return issues
    },
    statements(ctx) {
      const statements: string[] = []
      // Art. 226(11a): the mention "Reverse charge" is mandatory.
      if (ctx.isReverseCharge) {
        statements.push(
          'Reverse charge. VAT to be accounted for by the recipient (Article 196, Council Directive 2006/112/EC).',
        )
      }
      return statements
    },
    ...(country === 'IT'
      ? {
          eInvoicingRegime: {
            name: 'FatturaPA / SDI',
            note: 'Italy requires invoices to be transmitted as structured XML through the Sistema di Interscambio. A PDF is not a legally valid invoice for domestic supplies.',
          },
        }
      : {}),
  }
}

/* -------------------------------------------------------------------------- */
/* Named jurisdictions                                                         */
/* -------------------------------------------------------------------------- */

export const ghanaProfile: DocumentProfile = {
  country: 'GH',
  documentTitle: 'VAT INVOICE',
  check(ctx) {
    const issues = baseChecks(ctx)
    if (ctx.organisation.taxRegistered && !ctx.organisation.taxId) {
      issues.push({
        field: 'organisation.taxId',
        label: 'GRA TIN',
        severity: 'required',
        reason: 'A VAT invoice must show the supplier’s Taxpayer Identification Number.',
      })
    }
    return issues
  },
  statements() {
    // The levies must appear as distinct lines rather than a combined rate;
    // that is enforced by the tax engine itemising them, not by a statement.
    return []
  },
}

export const indiaProfile: DocumentProfile = {
  country: 'IN',
  documentTitle: 'TAX INVOICE',
  lineColumns: [{ key: 'hsnSac', label: 'HSN/SAC' }],
  check(ctx) {
    const issues = baseChecks(ctx)

    if (!ctx.organisation.taxId) {
      issues.push({
        field: 'organisation.taxId',
        label: 'Your GSTIN',
        severity: 'required',
        reason: 'A tax invoice must show the supplier’s GSTIN.',
      })
    }
    if (ctx.client.country === 'IN' && ctx.client.isBusiness) {
      issues.push(
        ...customerTaxIdRequired(
          ctx,
          'Supplies to a registered business must show the recipient’s GSTIN.',
        ),
      )
    }
    if (!ctx.organisation.region || !ctx.client.region) {
      issues.push({
        field: 'placeOfSupply',
        label: 'Place of supply',
        severity: 'required',
        reason:
          'The state of both parties determines whether CGST + SGST or IGST applies, and must be shown.',
      })
    }
    // HSN/SAC codes live on the line item; flagged as recommended because the
    // threshold depends on turnover, which we do not know.
    const missingCodes = ctx.invoice.lines.some(
      (line) => !(line as unknown as { hsnSac?: string }).hsnSac,
    )
    if (missingCodes) {
      issues.push({
        field: 'lines.hsnSac',
        label: 'HSN / SAC codes',
        severity: 'recommended',
        reason:
          'HSN or SAC codes are required on tax invoices above prescribed turnover thresholds.',
      })
    }
    return issues
  },
  statements() {
    return []
  },
  eInvoicingRegime: {
    name: 'e-Invoice (IRN)',
    note: 'Businesses above the turnover threshold must register invoices with the Invoice Registration Portal to obtain an IRN and signed QR code.',
  },
}

export const unitedKingdomProfile: DocumentProfile = {
  country: 'GB',
  documentTitle: 'VAT INVOICE',
  check(ctx) {
    const issues = baseChecks(ctx)
    if (ctx.organisation.taxRegistered && !ctx.organisation.taxId) {
      issues.push({
        field: 'organisation.taxId',
        label: 'Your VAT registration number',
        severity: 'required',
        reason: 'A VAT invoice must show the supplier’s VAT registration number.',
      })
    }
    return issues
  },
  statements(ctx) {
    return ctx.isReverseCharge
      ? ['Reverse charge: the customer is liable to account for VAT to the relevant tax authority.']
      : []
  },
}

export const brazilProfile: DocumentProfile = {
  country: 'BR',
  check: baseChecks,
  statements() {
    return []
  },
  eInvoicingRegime: {
    name: 'NF-e / NFS-e',
    note: 'Brazil requires electronic invoices authorised by the state tax authority (SEFAZ) before a supply. A PDF produced here is a courtesy copy, not a fiscal document.',
  },
}

export const mexicoProfile: DocumentProfile = {
  country: 'MX',
  check: baseChecks,
  statements() {
    return []
  },
  eInvoicingRegime: {
    name: 'CFDI',
    note: 'Mexico requires invoices as XML digitally stamped by an authorised certification provider (PAC). A PDF is a representation, not the invoice itself.',
  },
}

/** Sensible default for jurisdictions without a specific profile. */
export const genericProfile: DocumentProfile = {
  country: '*',
  check: baseChecks,
  statements() {
    return []
  },
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

const profiles = new Map<string, DocumentProfile>()

function register(profile: DocumentProfile): void {
  profiles.set(profile.country, profile)
}

register(ghanaProfile)
register(indiaProfile)
register(unitedKingdomProfile)
register(brazilProfile)
register(mexicoProfile)
for (const state of EU_STATES) register(createEuProfile(state))

export function documentProfileFor(country: string): DocumentProfile {
  return profiles.get(country.toUpperCase()) ?? genericProfile
}

export function supportedDocumentCountries(): string[] {
  return [...profiles.keys()].sort()
}

export interface ComplianceReport {
  jurisdiction: string
  documentTitle: string
  issues: RequirementIssue[]
  statements: string[]
  /** Blocking problems. Recommended items do not block. */
  hasRequiredIssues: boolean
  eInvoicingRegime?: { name: string; note: string }
  /** Provenance, so the user can judge how much to trust this. */
  rulesReviewedAt: string
  rulesAgeDays: number
  rulesStale: boolean
}

/**
 * Check an invoice against its jurisdiction's document requirements.
 *
 * Advisory, never blocking. The user may have a reason we do not know, and
 * refusing to send an invoice because a field we think is required is missing
 * would be worse than telling them clearly and letting them decide.
 */
export function checkInvoiceCompliance(
  invoice: IInvoice,
  organisation: IOrganisation,
  client: IClient,
): ComplianceReport {
  const profile = documentProfileFor(organisation.country)

  const treatments = (invoice.taxSnapshot?.treatments ?? []) as string[]
  const ctx: DocumentContext = {
    invoice,
    organisation,
    client,
    isReverseCharge: treatments.includes('REVERSE_CHARGE'),
    isCrossBorder: organisation.country !== client.country,
  }

  const issues = profile.check(ctx)

  return {
    jurisdiction: profile.country === '*' ? organisation.country : profile.country,
    documentTitle: profile.documentTitle ?? 'INVOICE',
    issues,
    statements: profile.statements(ctx),
    hasRequiredIssues: issues.some((issue) => issue.severity === 'required'),
    eInvoicingRegime: profile.eInvoicingRegime,
    rulesReviewedAt: RULES_REVIEWED_AT,
    rulesAgeDays: rulesAgeDays(),
    rulesStale: rulesAreStale(),
  }
}
