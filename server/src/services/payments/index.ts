import { PaymentProviderName } from '../../models/Payment'
import { manualProvider } from './providers/manual'
import { paystackProvider, MOBILE_MONEY_COUNTRIES } from './providers/paystack'
import { stripeProvider } from './providers/stripe'
import {
  PAYSTACK_MERCHANT_COUNTRIES,
  RESTRICTED_PAYMENT_JURISDICTIONS,
  STRIPE_MERCHANT_COUNTRIES,
} from './coverage'
import { NoProviderAvailableError, type PaymentProvider, type ProviderId } from './types'

/**
 * Provider registry and rail selection.
 *
 * Selection is deliberate rather than "first configured wins": for a Ghanaian
 * customer paying in cedis, mobile money is the dominant rail and offering only
 * a card form loses the sale. The ordering encodes that.
 */
const providers: Record<ProviderId, PaymentProvider> = {
  STRIPE: stripeProvider,
  PAYSTACK: paystackProvider,
  MANUAL: manualProvider,
}

export function getProvider(id: ProviderId | PaymentProviderName): PaymentProvider {
  const provider = providers[id as ProviderId]
  if (!provider) throw new Error(`Unknown payment provider: ${id}`)
  return provider
}

export interface AvailableRail {
  providerId: ProviderId
  displayName: string
  methods: string[]
  /** True when this rail should be presented first. */
  recommended: boolean
}

/**
 * Which rails can settle this invoice, best first.
 *
 * MANUAL is excluded: it is an internal action for the invoice owner, never an
 * option shown to a paying customer.
 */
export function availableRails(
  currency: string,
  customerCountry: string,
  /**
   * The MERCHANT's country. A gateway can only settle if it onboards
   * businesses there, the customer's location alone is not sufficient, which
   * is the distinction the first version of this function missed.
   */
  merchantCountry?: string,
): AvailableRail[] {
  const rails: AvailableRail[] = []
  const country = customerCountry.toUpperCase()
  const preferMobileMoney = MOBILE_MONEY_COUNTRIES.has(country)

  const merchant = merchantCountry?.toUpperCase()
  const stripeEligible = !merchant || STRIPE_MERCHANT_COUNTRIES.has(merchant)
  const paystackEligible = !merchant || PAYSTACK_MERCHANT_COUNTRIES.has(merchant)
  const restricted = merchant ? RESTRICTED_PAYMENT_JURISDICTIONS.has(merchant) : false

  if (restricted) return []

  if (paystackEligible && paystackProvider.supports(currency, country)) {
    rails.push({
      providerId: 'PAYSTACK',
      displayName: paystackProvider.displayName,
      methods: paystackProvider.methodsFor(currency),
      recommended: preferMobileMoney,
    })
  }

  if (stripeEligible && stripeProvider.supports(currency, country)) {
    rails.push({
      providerId: 'STRIPE',
      displayName: stripeProvider.displayName,
      methods: stripeProvider.methodsFor(currency),
      // Recommended only when mobile money is not the local default.
      recommended: !preferMobileMoney,
    })
  }

  return rails.sort((a, b) => Number(b.recommended) - Number(a.recommended))
}

/** Picks the best rail, or throws so the caller can offer manual recording. */
export function selectProvider(
  currency: string,
  customerCountry: string,
  merchantCountry?: string,
): PaymentProvider {
  const rails = availableRails(currency, customerCountry, merchantCountry)
  const first = rails[0]
  if (!first) throw new NoProviderAvailableError(currency, customerCountry)
  return getProvider(first.providerId)
}

export * from './types'
export {
  paymentCapabilityFor,
  countriesWithAutomaticRails,
  STRIPE_MERCHANT_COUNTRIES,
  PAYSTACK_MERCHANT_COUNTRIES,
  RESTRICTED_PAYMENT_JURISDICTIONS,
  type CountryPaymentCapability,
  type RailCapability,
  type RailId,
} from './coverage'
export { manualProvider } from './providers/manual'
export { paystackProvider, PAYSTACK_WEBHOOK_IPS } from './providers/paystack'
export { stripeProvider } from './providers/stripe'
