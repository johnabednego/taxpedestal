import {
  addCoverageOverride,
  clearCoverageOverrides,
  countriesWithAutomaticRails,
  coverageAgeDays,
  COVERAGE_REVIEWED_AT,
  isCoverageStale,
  paymentCapabilityFor,
  PAYSTACK_MERCHANT_COUNTRIES,
  RESTRICTED_PAYMENT_JURISDICTIONS,
  STRIPE_MERCHANT_COUNTRIES,
} from '../../src/services/payments/coverage'
import { COUNTRY_CODES } from '../../src/core/countries'
import { availableRails, paystackProvider, stripeProvider } from '../../src/services/payments'

const ALL_CONFIGURED = { stripe: true, paystack: true }
const NONE_CONFIGURED = { stripe: false, paystack: false }

describe('the universal guarantee', () => {
  it('lets a business in EVERY country on earth collect payment', () => {
    // The single most important assertion in this file. There must be no
    // country in which TaxPedestal cannot help a business get paid.
    for (const country of COUNTRY_CODES) {
      const capability = paymentCapabilityFor(country, ALL_CONFIGURED)
      expect(capability.canCollect).toBe(true)
    }
  })

  it('offers bank transfer everywhere, including sanctioned jurisdictions', () => {
    for (const country of [...COUNTRY_CODES]) {
      const capability = paymentCapabilityFor(country, NONE_CONFIGURED)
      const bank = capability.rails.find((r) => r.id === 'BANK_TRANSFER')
      expect(bank?.available).toBe(true)
    }
  })

  it('offers manual recording everywhere, even with no provider configured', () => {
    for (const country of ['IQ', 'CU', 'KP', 'AF', 'VE', 'BO', 'NP', 'MM']) {
      const capability = paymentCapabilityFor(country, NONE_CONFIGURED)
      expect(capability.rails.find((r) => r.id === 'MANUAL')?.available).toBe(true)
    }
  })

  it('always explains itself rather than leaving a blank', () => {
    for (const country of COUNTRY_CODES) {
      const capability = paymentCapabilityFor(country, ALL_CONFIGURED)
      expect(capability.summary.length).toBeGreaterThan(20)
      for (const rail of capability.rails) {
        // Anything unavailable must say why.
        if (!rail.available) expect(rail.reason).toBeTruthy()
      }
    }
  })
})

describe('automatic rails follow real provider coverage', () => {
  it('gives a UK business card processing', () => {
    const capability = paymentCapabilityFor('GB', ALL_CONFIGURED)
    expect(capability.hasAutomaticRail).toBe(true)
    expect(capability.rails.find((r) => r.id === 'STRIPE')?.available).toBe(true)
  })

  it('gives a Ghanaian business mobile money but NOT Stripe', () => {
    // Stripe does not onboard Ghanaian merchants; Paystack does.
    const capability = paymentCapabilityFor('GH', ALL_CONFIGURED)
    expect(capability.hasAutomaticRail).toBe(true)
    expect(capability.rails.find((r) => r.id === 'PAYSTACK')?.available).toBe(true)
    expect(capability.rails.find((r) => r.id === 'STRIPE')?.available).toBe(false)
  })

  it('gives an Iraqi business no automatic rail, and says so plainly', () => {
    const capability = paymentCapabilityFor('IQ', ALL_CONFIGURED)
    expect(capability.hasAutomaticRail).toBe(false)
    expect(capability.canCollect).toBe(true)
    expect(capability.summary).toMatch(/bank transfer/i)
    expect(capability.rails.find((r) => r.id === 'STRIPE')?.reason).toMatch(
      /does not onboard/i,
    )
  })

  it('distinguishes "not offered here" from "not connected yet"', () => {
    // A German business CAN use Stripe but has not connected it — a completely
    // different message from one that can never use it.
    const notConnected = paymentCapabilityFor('DE', NONE_CONFIGURED)
    expect(notConnected.rails.find((r) => r.id === 'STRIPE')?.reason).toMatch(
      /not yet connected/i,
    )
    expect(notConnected.summary).toMatch(/connect a provider/i)

    const neverAvailable = paymentCapabilityFor('IQ', NONE_CONFIGURED)
    expect(neverAvailable.rails.find((r) => r.id === 'STRIPE')?.reason).toMatch(
      /does not onboard/i,
    )
  })

  it('marks sanctioned jurisdictions without breaking the product', () => {
    for (const country of RESTRICTED_PAYMENT_JURISDICTIONS) {
      const capability = paymentCapabilityFor(country, ALL_CONFIGURED)
      expect(capability.restricted).toBe(true)
      expect(capability.hasAutomaticRail).toBe(false)
      // Invoicing and bookkeeping still work.
      expect(capability.canCollect).toBe(true)
      expect(capability.summary).toMatch(/Invoicing and bookkeeping work normally/i)
    }
  })

  it('reports the real size of automatic coverage', () => {
    const automatic = countriesWithAutomaticRails()
    expect(automatic.length).toBe(
      new Set([...STRIPE_MERCHANT_COUNTRIES, ...PAYSTACK_MERCHANT_COUNTRIES]).size,
    )
    // Roughly a fifth of the world — which is exactly why the universal rail
    // has to exist.
    expect(automatic.length).toBeLessThan(60)
    expect(automatic.length).toBeGreaterThan(45)
  })
})

describe('rail selection respects MERCHANT eligibility, not just the customer', () => {
  // These tests are about ELIGIBILITY, not configuration. The test environment
  // holds no live API keys, so `isConfigured` is stubbed true to isolate the
  // logic under test — otherwise every rail would be absent for the trivial
  // reason that no credentials are set, and the assertions would prove nothing.
  beforeEach(() => {
    jest.spyOn(stripeProvider, 'isConfigured').mockReturnValue(true)
    jest.spyOn(paystackProvider, 'isConfigured').mockReturnValue(true)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('offers no gateway to an Iraqi merchant even for a UK customer paying in GBP', () => {
    // The customer's country and currency are both perfectly supported. The
    // merchant's are not, and that is what decides it.
    const rails = availableRails('GBP', 'GB', 'IQ')
    expect(rails).toHaveLength(0)
  })

  it('offers Stripe to a UK merchant with a UK customer', () => {
    const rails = availableRails('GBP', 'GB', 'GB')
    expect(rails.some((r) => r.providerId === 'STRIPE')).toBe(true)
  })

  it('recommends mobile money for a Ghanaian customer of a Ghanaian merchant', () => {
    const rails = availableRails('GHS', 'GH', 'GH')
    expect(rails[0]?.providerId).toBe('PAYSTACK')
    expect(rails[0]?.recommended).toBe(true)
  })

  it('offers nothing from a sanctioned merchant jurisdiction', () => {
    expect(availableRails('USD', 'US', 'IR')).toHaveLength(0)
  })

  it('falls back to permissive behaviour when the merchant country is unknown', () => {
    // Older callers that pass no merchant country must not silently lose rails.
    expect(availableRails('GBP', 'GB').length).toBeGreaterThan(0)
  })
})

describe('reference data must never be the final word', () => {
  afterEach(() => {
    clearCoverageOverrides()
  })

  it('lets a LIVE provider answer override a stale reference table', () => {
    // The scenario this whole mechanism exists for: Stripe has started
    // onboarding merchants in a country our snapshot predates. The live probe
    // says charges are enabled, so the user gets card payments — no redeploy.
    const capability = paymentCapabilityFor('BO', ALL_CONFIGURED, {
      stripe: { reachable: true, chargesEnabled: true, accountCountry: 'BO' },
    })

    const stripe = capability.rails.find((r) => r.id === 'STRIPE')
    expect(stripe?.available).toBe(true)
    expect(stripe?.source).toBe('live')
    expect(capability.hasAutomaticRail).toBe(true)
    expect(capability.provenance.liveProbeUsed).toBe(true)
  })

  it('trusts a live NEGATIVE answer over an optimistic reference table', () => {
    // Reference says the UK is supported, but this particular account has not
    // finished onboarding. The account is what matters.
    const capability = paymentCapabilityFor('GB', ALL_CONFIGURED, {
      stripe: { reachable: true, chargesEnabled: false, accountCountry: 'GB' },
    })

    const stripe = capability.rails.find((r) => r.id === 'STRIPE')
    expect(stripe?.available).toBe(false)
    expect(stripe?.reason).toMatch(/finish onboarding/i)
  })

  it('always lets the user TRY, even when reference data says no', () => {
    // Being wrong towards "let them try" costs an error message. Being wrong
    // the other way costs a customer.
    const capability = paymentCapabilityFor('NP', ALL_CONFIGURED)
    const stripe = capability.rails.find((r) => r.id === 'STRIPE')
    expect(stripe?.available).toBe(false)
    expect(stripe?.allowAttempt).toBe(true)
    expect(stripe?.reason).toMatch(/Coverage changes/i)
  })

  it('does NOT invite an attempt in a sanctioned jurisdiction', () => {
    // The one case where "no" is genuinely final.
    for (const country of RESTRICTED_PAYMENT_JURISDICTIONS) {
      const capability = paymentCapabilityFor(country, ALL_CONFIGURED)
      for (const rail of capability.rails.filter((r) => r.automatic)) {
        expect(rail.allowAttempt).toBe(false)
      }
    }
  })

  it('applies a runtime override without a redeploy', () => {
    const before = paymentCapabilityFor('NP', ALL_CONFIGURED)
    expect(before.rails.find((r) => r.id === 'STRIPE')?.available).toBe(false)

    addCoverageOverride('STRIPE', 'NP')

    const after = paymentCapabilityFor('NP', ALL_CONFIGURED)
    expect(after.rails.find((r) => r.id === 'STRIPE')?.available).toBe(true)
  })

  it('reports its own age and staleness honestly', () => {
    const capability = paymentCapabilityFor('GB', ALL_CONFIGURED)
    expect(capability.provenance.referenceReviewedAt).toBe(COVERAGE_REVIEWED_AT)
    expect(capability.provenance.referenceAgeDays).toBeGreaterThanOrEqual(0)
    expect(typeof capability.provenance.referenceStale).toBe('boolean')
  })

  it('flags the snapshot as stale once it passes the review window', () => {
    // Simulates the future. Data that is a year old must say so rather than
    // presenting itself with unchanged confidence.
    const farFuture = new Date(
      new Date(`${COVERAGE_REVIEWED_AT}T00:00:00Z`).getTime() + 400 * 86_400_000,
    )
    expect(isCoverageStale(farFuture)).toBe(true)
    expect(coverageAgeDays(farFuture)).toBe(400)

    // And is not stale on the day it was reviewed.
    const sameDay = new Date(`${COVERAGE_REVIEWED_AT}T12:00:00Z`)
    expect(isCoverageStale(sameDay)).toBe(false)
  })

  it('marks the source as reference when no probe was possible', () => {
    const capability = paymentCapabilityFor('GB', ALL_CONFIGURED)
    expect(capability.rails.find((r) => r.id === 'STRIPE')?.source).toBe('reference')
    expect(capability.provenance.liveProbeUsed).toBe(false)
  })

  it('keeps the offline rails independent of any provider', () => {
    // Bank transfer has no third party to probe, so it is 'always' available.
    const capability = paymentCapabilityFor('IQ', NONE_CONFIGURED)
    const bank = capability.rails.find((r) => r.id === 'BANK_TRANSFER')
    expect(bank?.source).toBe('always')
    expect(bank?.available).toBe(true)
  })
})
