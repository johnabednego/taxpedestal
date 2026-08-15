import StripeCtor from 'stripe'
import type Stripe from 'stripe'
import { env } from '../../../config/env'
import { logger } from '../../../core/logger'
import { UpstreamError } from '../../../core/errors'
import { PaymentMethod } from '../../../models/Payment'
import type {
  CheckoutRequest,
  CheckoutResult,
  PaymentProvider,
  TransactionSnapshot,
  WebhookVerification,
} from '../types'

/**
 * Stripe adapter, worldwide cards, wallets and bank debits.
 *
 * SIGNATURE VERIFICATION USES THE OFFICIAL SDK, NOT HAND-ROLLED HMAC.
 *
 * Stripe's own guidance is explicit about this, and the reasons are concrete:
 * `constructEvent` performs the constant-time comparison, enforces the 5-minute
 * timestamp tolerance, and parses a header format Stripe reserves the right to
 * extend (it already carries both v0 and v1 schemes). Hand-rolled verification
 * that string-compares the digest is vulnerable to timing analysis and breaks
 * silently when the header format grows.
 */

/**
 * Currencies Stripe settles. Not exhaustive, restricted to the set TaxPedestal
 * invoices in, so an unsupported pair fails fast at selection rather than at
 * checkout.
 */
const STRIPE_CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'SGD', 'AED', 'CHF', 'BRL', 'INR',
  'JPY', 'KRW', 'ZAR', 'NGN', 'KES',
])

let client: Stripe | null = null

/**
 * Construct the SDK client on first use.
 *
 * Cached on the module so repeated calls reuse one HTTP agent rather than
 * opening a fresh connection pool per request.
 */
async function stripeClient(): Promise<Stripe> {
  if (client) return client
  if (!env.STRIPE_SECRET_KEY) {
    throw new UpstreamError('stripe', 'Stripe is not configured')
  }
  client = new StripeCtor(env.STRIPE_SECRET_KEY, {
    // Pinning the API version means a Stripe-side upgrade cannot change our
    // response shapes without a deliberate code change.
    apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion,
    typescript: true,
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: 'TaxPedestal', version: '1.0.0' },
  })
  return client
}

function mapStatus(status: Stripe.PaymentIntent.Status): TransactionSnapshot['status'] {
  switch (status) {
    case 'succeeded':
      return 'succeeded'
    case 'canceled':
      return 'abandoned'
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
    case 'processing':
    case 'requires_capture':
      return 'pending'
    default:
      return 'pending'
  }
}

export const stripeProvider: PaymentProvider = {
  id: 'STRIPE',
  displayName: 'Card & wallet',

  isConfigured() {
    return Boolean(env.STRIPE_SECRET_KEY)
  },

  supports(currency) {
    // Stripe is global on the customer side, so country is not a constraint;
    // the currency is.
    return this.isConfigured() && STRIPE_CURRENCIES.has(currency.toUpperCase())
  },

  methodsFor() {
    return [PaymentMethod.CARD, PaymentMethod.BANK_TRANSFER]
  },

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    const stripe = await stripeClient()

    try {
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          // Stripe expects minor units, which is exactly how we store money, // no conversion boundary, so no rounding bug possible here.
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: request.currency.toLowerCase(),
                unit_amount: request.amountMinor,
                product_data: { name: request.description },
              },
            },
          ],
          customer_email: request.customerEmail,
          client_reference_id: request.reference,
          success_url: `${request.returnUrl}?status=success&ref=${request.reference}`,
          cancel_url: `${request.returnUrl}?status=cancelled&ref=${request.reference}`,
          metadata: request.metadata,
          payment_intent_data: { metadata: request.metadata },
          // Expire abandoned sessions so they stop appearing as pending.
          expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
        },
        // Stripe caches the response against this key for 24 hours. A replay
        // returns the original session instead of creating a second one.
        { idempotencyKey: request.idempotencyKey },
      )

      if (!session.url) {
        throw new UpstreamError('stripe', 'Stripe did not return a checkout URL')
      }

      return {
        providerId: 'STRIPE',
        // The PaymentIntent is the durable object webhooks reference; fall back
        // to the session id when the intent is not yet allocated.
        providerReference:
          typeof session.payment_intent === 'string' ? session.payment_intent : session.id,
        action: 'redirect',
        redirectUrl: session.url,
        method: PaymentMethod.CARD,
      }
    } catch (error) {
      if (error instanceof UpstreamError) throw error
      const message = error instanceof Error ? error.message : String(error)
      logger.error({ err: message, reference: request.reference }, 'Stripe checkout failed')
      throw new UpstreamError('stripe', 'Could not start the card payment', { detail: message })
    }
  },

  verifyWebhook(rawBody, headers): WebhookVerification {
    const signature = headers['stripe-signature']
    if (!signature) {
      return { valid: false, eventId: null, eventType: null, payload: null, reason: 'Missing stripe-signature header' }
    }
    if (!env.STRIPE_WEBHOOK_SECRET) {
      return { valid: false, eventId: null, eventType: null, payload: null, reason: 'STRIPE_WEBHOOK_SECRET is not configured' }
    }

    try {
      // Verification is synchronous by design: it must operate on the raw body
      // in the same tick it was received, before any other middleware can touch
      // the buffer.
      const verifier = new StripeCtor(env.STRIPE_SECRET_KEY ?? 'sk_unset')

      const event = verifier.webhooks.constructEvent(
        rawBody,
        signature,
        env.STRIPE_WEBHOOK_SECRET,
        // Default 300s tolerance. Explicit so the value is reviewable, and
        // never 0, that would disable replay protection entirely.
        300,
      )

      return { valid: true, eventId: event.id, eventType: event.type, payload: event }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Logged at warn, not error: a failing signature check means the defence
      // is working. Sustained failures should alert, which is why the count is
      // recorded on the WebhookEvent ledger.
      logger.warn({ err: message }, 'Stripe webhook signature verification failed')
      return { valid: false, eventId: null, eventType: null, payload: null, reason: message }
    }
  },

  extractReference(payload): string | null {
    const event = payload as Stripe.Event | null
    if (!event?.type) return null

    switch (event.type) {
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled': {
        const intent = event.data.object as Stripe.PaymentIntent
        return intent.id
      }
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        return typeof session.payment_intent === 'string' ? session.payment_intent : session.id
      }
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge
        return typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.id
      }
      default:
        // Unhandled event types are ignored, not errors. Stripe sends many
        // events; subscribing narrowly at the dashboard is best practice but
        // the receiver must tolerate anything.
        return null
    }
  },

  async fetchTransaction(providerReference): Promise<TransactionSnapshot> {
    const stripe = await stripeClient()

    try {
      // Session ids and intent ids are distinguishable by prefix.
      if (providerReference.startsWith('cs_')) {
        const session = await stripe.checkout.sessions.retrieve(providerReference, {
          expand: ['payment_intent'],
        })
        const intent = session.payment_intent as Stripe.PaymentIntent | null
        if (!intent) {
          return {
            providerReference,
            status: session.status === 'expired' ? 'abandoned' : 'pending',
            amountMinor: session.amount_total ?? 0,
            currency: (session.currency ?? 'usd').toUpperCase(),
            feeMinor: 0,
            channelDetail: null,
          }
        }
        return snapshotFromIntent(intent)
      }

      const intent = await stripe.paymentIntents.retrieve(providerReference, {
        expand: ['latest_charge.balance_transaction'],
      })
      return snapshotFromIntent(intent)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new UpstreamError('stripe', 'Could not confirm the payment with Stripe', {
        detail: message,
      })
    }
  },
}

function snapshotFromIntent(intent: Stripe.PaymentIntent): TransactionSnapshot {
  const charge = intent.latest_charge as Stripe.Charge | null
  const balanceTransaction =
    charge && typeof charge.balance_transaction === 'object'
      ? (charge.balance_transaction as Stripe.BalanceTransaction)
      : null

  let channelDetail: string | null = null
  const cardDetails = charge?.payment_method_details?.card
  if (cardDetails) {
    channelDetail = [cardDetails.brand, cardDetails.last4].filter(Boolean).join(' ••••')
  }

  const refunded = (charge?.amount_refunded ?? 0) > 0

  return {
    providerReference: intent.id,
    status: refunded ? 'refunded' : mapStatus(intent.status),
    // amount_received is what actually arrived; `amount` is what was requested.
    amountMinor: intent.amount_received || intent.amount,
    currency: intent.currency.toUpperCase(),
    feeMinor: balanceTransaction?.fee ?? 0,
    channelDetail,
    failureCode: intent.last_payment_error?.code ?? null,
    failureMessage: intent.last_payment_error?.message ?? null,
    paidAt: charge?.created ? new Date(charge.created * 1000) : null,
  }
}
