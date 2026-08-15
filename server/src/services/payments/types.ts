/**
 * Payment provider abstraction.
 *
 * The invoice domain never imports a provider SDK. It asks the registry for a
 * provider that can handle a given currency and country, then talks to it
 * through this interface only.
 *
 * Why this matters commercially: Stripe cannot process Ghanaian mobile money,
 * and Paystack does not serve most of the world. A product that hard-codes one
 * rail excludes the other's entire market. Adding a rail (Flutterwave, M-Pesa
 * Daraja, Adyen) means writing one adapter.
 */

import type { PaymentMethod } from '../../models/Payment'

export type ProviderId = 'STRIPE' | 'PAYSTACK' | 'MANUAL'

export interface CheckoutRequest {
  /** Integer minor units, already validated against the invoice balance. */
  amountMinor: number
  currency: string
  /** Our own reference. Sent to the provider so webhooks can be correlated. */
  reference: string
  /**
   * Idempotency key.
   *
   * Following Stripe's model: the same key replayed returns the ORIGINAL
   * result rather than creating a second charge. This is what makes a
   * double-clicked Pay button safe.
   */
  idempotencyKey: string
  customerEmail: string
  customerName?: string | null
  description: string
  /** Where the provider returns the customer after payment. */
  returnUrl: string
  /** Free-form data echoed back on the webhook. Never trusted for amounts. */
  metadata: Record<string, string>
  /** Mobile money only: subscriber phone and network. */
  mobileMoney?: {
    phone: string
    /** mtn | vod (Telecel) | atl (AirtelTigo) | mpesa | orange | wave */
    provider: string
  } | null
}

export interface CheckoutResult {
  providerId: ProviderId
  /** Provider-side identifier used to reconcile later. */
  providerReference: string
  /**
   * How the client should complete payment:
   *  - `redirect`   : send the browser to `redirectUrl` (hosted checkout)
   *  - `client_side`: use `clientSecret` with the provider's JS SDK
   *  - `otp`        : mobile money — customer authorises on their handset
   *  - `settled`    : already complete (manual/offline record)
   */
  action: 'redirect' | 'client_side' | 'otp' | 'settled'
  redirectUrl?: string
  clientSecret?: string
  /** Message to show the customer, e.g. "Approve the prompt on your phone". */
  instruction?: string
  method: PaymentMethod
}

/**
 * Authoritative transaction state, fetched from the provider's API.
 *
 * ALWAYS re-fetched before value is granted. A webhook payload proves the
 * request came from the provider; it does not prove the amount has not been
 * tampered with in a replay of an older event, and Paystack's signature
 * contains no timestamp. Both Stripe and Paystack recommend confirming amount
 * and status against the API before acting.
 */
export interface TransactionSnapshot {
  providerReference: string
  status: 'pending' | 'succeeded' | 'failed' | 'refunded' | 'abandoned'
  amountMinor: number
  currency: string
  /** Provider fee in minor units where reported. Needed for true net revenue. */
  feeMinor: number
  /** Card brand or mobile money network, for display. */
  channelDetail: string | null
  failureCode?: string | null
  failureMessage?: string | null
  paidAt?: Date | null
}

export interface WebhookVerification {
  valid: boolean
  /** Provider's unique event id — the idempotency key for processing. */
  eventId: string | null
  eventType: string | null
  /** Parsed payload. Only trust this after `valid` is true. */
  payload: unknown
  /** Why verification failed, for the audit trail. */
  reason?: string
}

export interface PaymentProvider {
  readonly id: ProviderId
  readonly displayName: string

  /** Is this provider configured with usable credentials? */
  isConfigured(): boolean

  /**
   * Can this provider settle the given currency for a customer in the given
   * country? Drives automatic rail selection on the public payment page.
   */
  supports(currency: string, customerCountry: string): boolean

  /** Payment methods this provider can offer for the currency. */
  methodsFor(currency: string): PaymentMethod[]

  createCheckout(request: CheckoutRequest): Promise<CheckoutResult>

  /** Verify an inbound webhook against the raw request bytes. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerification

  /**
   * Map a verified webhook event to the reference it concerns, or null if the
   * event type is not one we act on.
   */
  extractReference(payload: unknown): string | null

  /** Re-fetch authoritative state. Called before crediting an invoice. */
  fetchTransaction(providerReference: string): Promise<TransactionSnapshot>
}

/** Thrown when no configured provider can handle a currency/country pair. */
export class NoProviderAvailableError extends Error {
  constructor(currency: string, country: string) {
    super(
      `No payment provider is configured for ${currency} payments from ${country}. ` +
        'Record the payment manually instead.',
    )
    this.name = 'NoProviderAvailableError'
  }
}
