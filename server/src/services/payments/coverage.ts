/**
 * Payment coverage.
 *
 * ============================================================================
 * THE HONEST POSITION, STATED ONCE, IN CODE
 * ============================================================================
 * "Accept payments from anywhere" and "get paid from anywhere" are different
 * claims, and only the first is true of card gateways.
 *
 *   PAYING side:      near-universal. A Stripe merchant can be paid by
 *                     customers in 195+ countries and 135+ currencies.
 *   GETTING PAID side: NOT universal. Stripe onboards merchants in 46
 *                     countries. Paystack covers 5 African markets. A business
 *                     in Iraq, Bolivia or Nepal cannot open either account, and
 *                     no amount of code changes that — it is banking licences,
 *                     KYC and sanctions law.
 *
 * Some vendors paper over this by simply not listing unsupported countries,
 * which leaves the user to discover the problem at the moment they try to get
 * paid. TaxPedestal instead:
 *
 *   1. Lets ANY business in ANY country register, invoice and compute tax.
 *   2. States plainly which automatic rails they can use.
 *   3. Ships a UNIVERSAL rail — bank transfer instructions printed on the
 *      invoice, reconciled through the same ledger — that works in every
 *      country on earth with no processor, no licence and no onboarding.
 *
 * That last point is what makes the product genuinely global. It is not a
 * consolation prize: cross-border B2B invoices are overwhelmingly settled by
 * bank transfer already.
 */

/**
 * ============================================================================
 * REFERENCE DATA, NOT TRUTH
 * ============================================================================
 * What follows is a dated snapshot of published provider coverage. It exists
 * to give a useful answer BEFORE credentials are configured — nothing more.
 *
 * Once a workspace connects a provider, the provider's own API is asked
 * directly (see health.ts) and its answer overrides everything here.
 *
 * This table therefore:
 *   - carries a review date and reports its own staleness,
 *   - is overridable at runtime without a redeploy,
 *   - and NEVER hard-blocks a user. If someone believes their country is now
 *     supported, they may attempt it and let the provider decide.
 *
 * The failure mode being designed against is specific: a provider adds a
 * country, our snapshot does not, and we quietly tell a new user they cannot
 * be paid. That user does not file a bug — they leave.
 */

/** When the sets below were last checked against provider documentation. */
export const COVERAGE_REVIEWED_AT = '2026-08-13'

/** Beyond this, the snapshot is presented as possibly out of date. */
const STALE_AFTER_DAYS = 90

export function coverageAgeDays(now: Date = new Date()): number {
  const reviewed = new Date(`${COVERAGE_REVIEWED_AT}T00:00:00Z`).getTime()
  return Math.floor((now.getTime() - reviewed) / 86_400_000)
}

export function isCoverageStale(now: Date = new Date()): boolean {
  return coverageAgeDays(now) > STALE_AFTER_DAYS
}

/**
 * Runtime overrides, settable by a platform administrator when a provider
 * announces a new market. Avoids a deploy standing between a user and the
 * ability to get paid.
 */
const overrides = new Map<string, Set<string>>()

export function addCoverageOverride(provider: 'STRIPE' | 'PAYSTACK', country: string): void {
  const key = provider
  const set = overrides.get(key) ?? new Set<string>()
  set.add(country.toUpperCase())
  overrides.set(key, set)
}

export function clearCoverageOverrides(): void {
  overrides.clear()
}

function onboardsIn(provider: 'STRIPE' | 'PAYSTACK', country: string): boolean {
  if (overrides.get(provider)?.has(country)) return true
  return provider === 'STRIPE'
    ? STRIPE_MERCHANT_COUNTRIES.has(country)
    : PAYSTACK_MERCHANT_COUNTRIES.has(country)
}

/**
 * Countries where Stripe onboards merchants.
 * Source: stripe.com/global, reviewed on COVERAGE_REVIEWED_AT.
 */
export const STRIPE_MERCHANT_COUNTRIES = new Set([
  'AU', 'AT', 'BE', 'BR', 'BG', 'CA', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI',
  'FR', 'DE', 'GI', 'GR', 'HK', 'HU', 'IN', 'ID', 'IE', 'IT', 'JP', 'LV',
  'LI', 'LT', 'LU', 'MY', 'MT', 'MX', 'NL', 'NZ', 'NO', 'PL', 'PT', 'RO',
  'SG', 'SK', 'SI', 'ES', 'SE', 'CH', 'TH', 'AE', 'GB', 'US',
])

/** Countries where Paystack onboards merchants. */
export const PAYSTACK_MERCHANT_COUNTRIES = new Set(['NG', 'GH', 'ZA', 'KE', 'CI', 'EG'])

/**
 * Jurisdictions under comprehensive sanctions programmes.
 *
 * Listed so the product can WARN rather than silently fail. TaxPedestal does not
 * hard-block these — invoicing and bookkeeping are not restricted activities,
 * and the operator of a deployment is responsible for their own compliance
 * posture. What the product must not do is imply that card processing will
 * work here, because no processor will serve it.
 *
 * This is a factual reflection of what payment providers publish, not a
 * political judgement, and it is exactly the kind of thing a real payments
 * business must encode.
 */
export const RESTRICTED_PAYMENT_JURISDICTIONS = new Set(['CU', 'IR', 'KP', 'SY'])

export type RailId = 'STRIPE' | 'PAYSTACK' | 'BANK_TRANSFER' | 'MANUAL'

/**
 * Why a rail is unavailable, as a stable identifier.
 *
 * The prose in `reason` cannot be translated by the client — it would have to
 * string-match English. The code can, so the interface stays in the user's
 * language while `reason` remains the fallback for any consumer without a
 * catalogue.
 */
export type RailReasonCode =
  | 'restricted'
  | 'chargesDisabled'
  | 'notOnboardedHere'
  | 'notConnected'

export interface RailCapability {
  id: RailId
  name: string
  /** What the customer experiences. */
  description: string
  /** True when a business in this country can actually use it. */
  available: boolean
  /** Why not, when unavailable. */
  reason?: string
  /** Machine-readable form of `reason`, for translation. */
  reasonCode?: RailReasonCode
  automatic: boolean
  /**
   * Whether the user may try anyway.
   *
   * TRUE even when `available` is false for reference-data reasons, because
   * our snapshot may simply be behind. Only a live provider rejection or a
   * sanctions restriction sets this to false.
   */
  allowAttempt: boolean
  /** 'live' when the provider told us; 'reference' when we are guessing. */
  source: 'live' | 'reference' | 'always'
}

export interface CountryPaymentCapability {
  country: string
  /** Can this business collect money through TaxPedestal at all? Always true. */
  canCollect: boolean
  /** Can any gateway settle automatically? */
  hasAutomaticRail: boolean
  /** Under a comprehensive sanctions programme. */
  restricted: boolean
  rails: RailCapability[]
  /** One-line summary for the UI. */
  summary: string
  /** Machine-readable form of `summary`, for translation. */
  summaryCode: 'restricted' | 'hasAutomatic' | 'eligibleNotConnected' | 'bankTransferOnly'
  /** Where each answer came from, so the UI can be honest about confidence. */
  provenance: {
    referenceReviewedAt: string
    referenceAgeDays: number
    referenceStale: boolean
    liveProbeUsed: boolean
  }
}

/**
 * What a business registered in this country can use.
 *
 * `canCollect` is ALWAYS true. Bank transfer and manual recording need no
 * processor, so there is no country in which TaxPedestal cannot help a business
 * get paid and keep correct books.
 */
export function paymentCapabilityFor(
  country: string,
  configured: { stripe: boolean; paystack: boolean },
  /**
   * Live provider health, where available. When a probe reports that charges
   * are enabled, it overrides the reference table entirely — the provider is
   * the authority on its own coverage.
   */
  live?: {
    stripe?: { reachable: boolean; chargesEnabled: boolean | null; accountCountry: string | null }
    paystack?: { reachable: boolean; chargesEnabled: boolean | null }
  },
): CountryPaymentCapability {
  const code = country.toUpperCase()
  const restricted = RESTRICTED_PAYMENT_JURISDICTIONS.has(code)

  const stripeLive = live?.stripe?.reachable === true
  const paystackLive = live?.paystack?.reachable === true

  // Live answers win. A provider that says "charges enabled" has settled the
  // question regardless of what our snapshot believes about its country list.
  const stripeEligible = restricted
    ? false
    : stripeLive
      ? live!.stripe!.chargesEnabled === true
      : onboardsIn('STRIPE', code)

  const paystackEligible = restricted
    ? false
    : paystackLive
      ? live!.paystack!.chargesEnabled === true
      : onboardsIn('PAYSTACK', code)

  const stripeReasonCode: RailReasonCode | undefined = restricted
    ? 'restricted'
    : stripeLive && live!.stripe!.chargesEnabled !== true
      ? 'chargesDisabled'
      : !onboardsIn('STRIPE', code)
        ? 'notOnboardedHere'
        : !configured.stripe
          ? 'notConnected'
          : undefined

  const paystackReasonCode: RailReasonCode | undefined = restricted
    ? 'restricted'
    : paystackLive && live!.paystack!.chargesEnabled !== true
      ? 'chargesDisabled'
      : !onboardsIn('PAYSTACK', code)
        ? 'notOnboardedHere'
        : !configured.paystack
          ? 'notConnected'
          : undefined

  const rails: RailCapability[] = [
    {
      id: 'STRIPE',
      name: 'Cards and wallets',
      description: 'Visa, Mastercard, Amex, Apple Pay, Google Pay, bank debits',
      available: stripeEligible && configured.stripe,
      automatic: true,
      // Never final unless a live check or sanctions says so.
      allowAttempt: !restricted,
      source: stripeLive ? 'live' : 'reference',
      reasonCode: stripeReasonCode,
      reason: restricted
        ? 'Card processors do not operate in this jurisdiction.'
        : stripeLive && live!.stripe!.chargesEnabled !== true
          ? 'Stripe reports this account cannot yet take charges — finish onboarding in your Stripe dashboard.'
          : !onboardsIn('STRIPE', code)
            ? 'Our records say Stripe does not onboard businesses here. Coverage changes — connect a key to check directly.'
            : !configured.stripe
              ? 'Not yet connected by this workspace.'
              : undefined,
    },
    {
      id: 'PAYSTACK',
      name: 'Mobile money and cards',
      description: 'MTN, Telecel, M-Pesa and card payments across Africa',
      available: paystackEligible && configured.paystack,
      automatic: true,
      allowAttempt: !restricted,
      source: paystackLive ? 'live' : 'reference',
      reasonCode: paystackReasonCode,
      reason: restricted
        ? 'Payment processors do not operate in this jurisdiction.'
        : paystackLive && live!.paystack!.chargesEnabled !== true
          ? 'Paystack rejected the configured key.'
          : !onboardsIn('PAYSTACK', code)
            ? 'Our records say Paystack does not onboard businesses here. Coverage changes — connect a key to check directly.'
            : !configured.paystack
              ? 'Not yet connected by this workspace.'
              : undefined,
    },
    {
      id: 'BANK_TRANSFER',
      name: 'Bank transfer',
      // The universal rail. No processor, no licence, no onboarding.
      description: 'Your account details are shown on the invoice; the customer pays their bank',
      available: true,
      automatic: false,
      allowAttempt: true,
      source: 'always',
    },
    {
      id: 'MANUAL',
      name: 'Cash, cheque and offline',
      description: 'Record money you received any other way',
      available: true,
      automatic: false,
      allowAttempt: true,
      source: 'always',
    },
  ]

  const hasAutomaticRail = rails.some((rail) => rail.automatic && rail.available)

  let summary: string
  let summaryCode: CountryPaymentCapability['summaryCode']
  if (restricted) {
    summaryCode = 'restricted'
    summary =
      'Invoicing and bookkeeping work normally. Card and mobile money processors do not operate in this jurisdiction, so collect by bank transfer.'
  } else if (hasAutomaticRail) {
    summaryCode = 'hasAutomatic'
    summary = 'Your customers can pay online, and you can also collect by bank transfer.'
  } else if (stripeEligible || paystackEligible) {
    summaryCode = 'eligibleNotConnected'
    summary =
      'Online payments are available in your country — connect a provider in Settings to switch them on.'
  } else {
    summaryCode = 'bankTransferOnly'
    summary =
      'Online card processing is not offered to businesses registered here. Collect by bank transfer, printed on every invoice.'
  }

  return {
    country: code,
    // Never false. This is the guarantee the product makes.
    canCollect: true,
    hasAutomaticRail,
    restricted,
    rails,
    summary,
    summaryCode,
    provenance: {
      referenceReviewedAt: COVERAGE_REVIEWED_AT,
      referenceAgeDays: coverageAgeDays(),
      referenceStale: isCoverageStale(),
      liveProbeUsed: stripeLive || paystackLive,
    },
  }
}

/** Countries where at least one automatic gateway can onboard a business. */
export function countriesWithAutomaticRails(): string[] {
  return [
    ...new Set([...STRIPE_MERCHANT_COUNTRIES, ...PAYSTACK_MERCHANT_COUNTRIES]),
  ]
    .filter((code) => !RESTRICTED_PAYMENT_JURISDICTIONS.has(code))
    .sort()
}
