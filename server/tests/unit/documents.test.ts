import { Types } from 'mongoose'
import {
  checkInvoiceCompliance,
  documentProfileFor,
  RULES_REVIEWED_AT,
  rulesAgeDays,
  rulesAreStale,
  supportedDocumentCountries,
} from '../../src/services/documents/requirements'
import {
  defaultDocumentLocale,
  labelsFor,
  supportedDocumentLocales,
} from '../../src/services/documents/templates'

function fixture(orgOverrides = {}, clientOverrides = {}, treatments: string[] = ['STANDARD']) {
  const organisation = {
    name: 'Studio', country: 'GB', city: 'London', addressLine1: '1 High St',
    taxRegistered: true, taxId: 'GB123456789', region: null,
  } as never
  const client = {
    name: 'Acme', country: 'GB', city: 'Leeds', addressLine1: '2 Mill Rd',
    taxId: null, isBusiness: true, region: null,
  } as never
  const invoice = {
    _id: new Types.ObjectId(), number: 'INV-0001', currency: 'GBP',
    lines: [{ description: 'Work', quantityMilli: 1000, unitAmountMinor: 1000 }],
    taxSnapshot: { components: [], notes: [], treatments },
  } as never

  return {
    organisation: { ...(organisation as object), ...orgOverrides } as never,
    client: { ...(client as object), ...clientOverrides } as never,
    invoice,
  }
}

describe('document requirements registry', () => {
  it('registers a profile for every EU state plus named jurisdictions', () => {
    const countries = supportedDocumentCountries()
    expect(countries).toContain('GH')
    expect(countries).toContain('IN')
    expect(countries).toContain('FR')
    expect(countries).toContain('BR')
  })

  it('falls back to a generic profile rather than throwing', () => {
    // A user in a country with no specific profile must still get an invoice.
    const profile = documentProfileFor('NP')
    expect(profile.country).toBe('*')
  })

  it('uses the jurisdiction document title where one is mandated', () => {
    expect(documentProfileFor('IN').documentTitle).toBe('TAX INVOICE')
    expect(documentProfileFor('GH').documentTitle).toBe('VAT INVOICE')
    // No mandated wording, so the localised default is used instead.
    expect(documentProfileFor('FR').documentTitle).toBeUndefined()
  })
})

describe('EU reverse charge requirements', () => {
  it('prints the mandatory Article 196 declaration', () => {
    const f = fixture(
      { country: 'DE', taxId: 'DE811234567' },
      { country: 'FR', taxId: 'FR12345678901' },
      ['REVERSE_CHARGE'],
    )
    const report = checkInvoiceCompliance(f.invoice, f.organisation, f.client)
    expect(report.statements.join(' ')).toMatch(/Reverse charge/i)
    expect(report.statements.join(' ')).toMatch(/Article 196/)
  })

  it('requires the customer VAT number when reverse charge applies', () => {
    const f = fixture(
      { country: 'DE', taxId: 'DE811234567' },
      { country: 'FR', taxId: null },
      ['REVERSE_CHARGE'],
    )
    const report = checkInvoiceCompliance(f.invoice, f.organisation, f.client)
    expect(report.hasRequiredIssues).toBe(true)
    expect(report.issues.some((i) => i.field === 'client.taxId')).toBe(true)
    // The message must cite why, not just say "missing".
    expect(report.issues.find((i) => i.field === 'client.taxId')?.reason).toMatch(/226/)
  })

  it('does NOT require the customer VAT number on a domestic supply', () => {
    const f = fixture({ country: 'DE', taxId: 'DE811234567' }, { country: 'DE', taxId: null })
    const report = checkInvoiceCompliance(f.invoice, f.organisation, f.client)
    expect(report.issues.some((i) => i.field === 'client.taxId')).toBe(false)
  })
})

describe('India requirements', () => {
  it('flags GSTIN and place of supply when missing', () => {
    const f = fixture({ country: 'IN', taxId: null, region: null }, { country: 'IN', region: null })
    const report = checkInvoiceCompliance(f.invoice, f.organisation, f.client)
    const fields = report.issues.map((i) => i.field)
    expect(fields).toContain('organisation.taxId')
    expect(fields).toContain('placeOfSupply')
    expect(report.documentTitle).toBe('TAX INVOICE')
  })

  it('warns that a PDF is not sufficient under the e-invoicing regime', () => {
    const f = fixture({ country: 'IN', taxId: 'GSTIN1', region: 'MH' }, { country: 'IN', region: 'KA' })
    const report = checkInvoiceCompliance(f.invoice, f.organisation, f.client)
    expect(report.eInvoicingRegime?.name).toMatch(/IRN/)
  })
})

describe('countries where a PDF has no legal standing', () => {
  it.each([
    ['BR', /NF-e/],
    ['MX', /CFDI/],
    ['IT', /FatturaPA|SDI/],
  ])('says so plainly for %s', (country, pattern) => {
    // Silently producing a pretty PDF here would imply legal validity it does
    // not have, a worse failure than saying we cannot do it.
    const f = fixture({ country }, { country })
    const report = checkInvoiceCompliance(f.invoice, f.organisation, f.client)
    expect(report.eInvoicingRegime).toBeDefined()
    expect(report.eInvoicingRegime!.name).toMatch(pattern)
  })
})

describe('compliance is advisory, never blocking', () => {
  it('reports issues without preventing the invoice existing', () => {
    const f = fixture({ country: 'IN', taxId: null, region: null })
    const report = checkInvoiceCompliance(f.invoice, f.organisation, f.client)
    expect(report.hasRequiredIssues).toBe(true)
    // No throw, and a usable report. The user decides.
    expect(report.documentTitle).toBeTruthy()
    expect(Array.isArray(report.issues)).toBe(true)
  })
})

describe('document language', () => {
  it('falls back to English for an unknown locale rather than showing keys', () => {
    const labels = labelsFor('xx-YY')
    expect(labels.invoice).toBe('INVOICE')
    expect(labels.total).toBe('Total')
  })

  it('translates structural labels', () => {
    expect(labelsFor('fr').invoice).toBe('FACTURE')
    expect(labelsFor('de').invoice).toBe('RECHNUNG')
    expect(labelsFor('es').invoice).toBe('FACTURA')
    expect(labelsFor('pt-BR').invoice).toBe('FATURA')
  })

  it('fills gaps per key, so a partial translation still renders fully', () => {
    const labels = labelsFor('nl')
    for (const value of Object.values(labels)) {
      expect(value).toBeTruthy()
    }
  })

  it('picks a document language from the customer country', () => {
    expect(defaultDocumentLocale('FR')).toBe('fr')
    expect(defaultDocumentLocale('BR')).toBe('pt')
    expect(defaultDocumentLocale('MX')).toBe('es')
    // Multilingual or unknown countries default to English rather than guessing
    // wrong on a legal document.
    expect(defaultDocumentLocale('CH')).toBe('en')
    expect(defaultDocumentLocale('NG')).toBe('en')
  })

  it('lists the locales it can render', () => {
    const locales = supportedDocumentLocales()
    expect(locales.map((l) => l.code)).toContain('fr')
    expect(locales.length).toBeGreaterThanOrEqual(7)
  })
})

describe('rule provenance, never present stale rules as current', () => {
  it('reports when the rules were last reviewed', () => {
    const f = fixture()
    const report = checkInvoiceCompliance(f.invoice, f.organisation, f.client)
    expect(report.rulesReviewedAt).toBe(RULES_REVIEWED_AT)
    expect(report.rulesAgeDays).toBeGreaterThanOrEqual(0)
    expect(report.rulesStale).toBe(false)
  })

  it('flags itself stale once past the review window', () => {
    // Simulates the product a year from now. It must say the rules are old
    // rather than quietly presenting them with the same confidence.
    const future = new Date(
      new Date(`${RULES_REVIEWED_AT}T00:00:00Z`).getTime() + 200 * 86_400_000,
    )
    expect(rulesAreStale(future)).toBe(true)
    expect(rulesAgeDays(future)).toBe(200)
  })

  it('is not stale on the day it was reviewed', () => {
    expect(rulesAreStale(new Date(`${RULES_REVIEWED_AT}T12:00:00Z`))).toBe(false)
  })
})
