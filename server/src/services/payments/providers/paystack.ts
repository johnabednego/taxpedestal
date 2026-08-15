import crypto from 'node:crypto'
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
 * Paystack adapter. African mobile money (MTN, Telecel, AirtelTigo, M-Pesa)
 * and cards.
 *
 * Paystack has no official Node SDK, so the HTTP calls and HMAC are written
 * here. Two differences from Stripe drive the design and both are security
 * relevant:
 *
 * 1. ALGORITHM IS SHA-512, NOT SHA-256. This is the detail most integrations
 *    get wrong, and getting it wrong means every signature check fails (safe)
 *    or, worse, that someone "fixes" it by skipping verification (catastrophic).
 *
 * 2. THE SIGNATURE CONTAINS NO TIMESTAMP. Stripe signs `timestamp.body` and so
 *    supports a recency window; Paystack signs the body alone. A captured
 *    delivery is therefore replayable forever. The only defences are
 *    deduplication on event id and re-fetching the authoritative amount before
 *    crediting anything, both implemented here and in webhook.service.ts.
 *
 * Note also that Paystack's own documentation sample hashes
 * `JSON.stringify(req.body)`. That is fragile: any difference in key order or
 * whitespace between their serialisation and Node's breaks the digest. We hash
 * the raw bytes.
 */

const PAYSTACK_BASE = 'https://api.paystack.co'

/** Currencies Paystack settles. */
const PAYSTACK_CURRENCIES = new Set(['GHS', 'NGN', 'ZAR', 'KES', 'USD'])

/** Countries whose customers can pay by mobile money through Paystack. */
const MOBILE_MONEY_COUNTRIES = new Set(['GH', 'KE', 'CI'])

/**
 * Paystack's webhook source IPs, published in their documentation.
 *
 * Provided as defence in depth. NOT relied upon as the primary control: behind
 * Render's proxy the observed remote address may be the proxy's, and an
 * allow-list that silently fails open is worse than none. Signature
 * verification is the real gate; this is logged when it does not match.
 */
export const PAYSTACK_WEBHOOK_IPS = ['52.31.139.75', '52.49.173.169', '52.214.14.220']

interface PaystackEnvelope<T> {
  status: boolean
  message: string
  data: T
}

async function paystackFetch<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string },
): Promise<T> {
  if (!env.PAYSTACK_SECRET_KEY) {
    throw new UpstreamError('paystack', 'Paystack is not configured')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)

  try {
    const response = await fetch(`${PAYSTACK_BASE}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
        ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    })

    const text = await response.text()
    let json: PaystackEnvelope<T> | null = null
    try {
      json = JSON.parse(text) as PaystackEnvelope<T>
    } catch {
      throw new UpstreamError('paystack', 'Paystack returned a non-JSON response', {
        status: response.status,
        body: text.slice(0, 300),
      })
    }

    if (!response.ok || !json.status) {
      throw new UpstreamError('paystack', json.message || 'Paystack request failed', {
        status: response.status,
      })
    }

    return json.data
  } catch (error) {
    if (error instanceof UpstreamError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new UpstreamError('paystack', 'Paystack did not respond in time')
    }
    throw new UpstreamError('paystack', 'Could not reach Paystack', {
      detail: error instanceof Error ? error.message : String(error),
    })
  } finally {
    clearTimeout(timeout)
  }
}

function mapStatus(status: string): TransactionSnapshot['status'] {
  switch (status) {
    case 'success':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'reversed':
      return 'refunded'
    case 'abandoned':
      return 'abandoned'
    case 'pending':
    case 'ongoing':
    case 'processing':
    case 'send_otp':
    case 'pay_offline':
      return 'pending'
    default:
      return 'pending'
  }
}

interface PaystackTransaction {
  id: number
  status: string
  reference: string
  amount: number
  currency: string
  fees: number | null
  paid_at: string | null
  gateway_response: string | null
  authorization?: {
    channel?: string | null
    brand?: string | null
    last4?: string | null
    mobile_money_number?: string | null
  }
  channel?: string | null
}

export const paystackProvider: PaymentProvider = {
  id: 'PAYSTACK',
  displayName: 'Mobile money & card',

  isConfigured() {
    return Boolean(env.PAYSTACK_SECRET_KEY)
  },

  supports(currency) {
    return this.isConfigured() && PAYSTACK_CURRENCIES.has(currency.toUpperCase())
  },

  methodsFor(currency) {
    const methods = [PaymentMethod.CARD, PaymentMethod.BANK_TRANSFER]
    if (currency.toUpperCase() === 'GHS' || currency.toUpperCase() === 'KES') {
      methods.unshift(PaymentMethod.MOBILE_MONEY)
    }
    return methods
  },

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    // Mobile money uses the charge endpoint: the customer authorises on their
    // handset and the final status arrives by webhook, not in this response.
    if (request.mobileMoney) {
      const data = await paystackFetch<PaystackTransaction & { display_text?: string }>(
        '/charge',
        {
          method: 'POST',
          idempotencyKey: request.idempotencyKey,
          body: {
            email: request.customerEmail,
            amount: request.amountMinor,
            currency: request.currency.toUpperCase(),
            reference: request.reference,
            mobile_money: {
              phone: request.mobileMoney.phone,
              provider: request.mobileMoney.provider,
            },
            metadata: request.metadata,
          },
        },
      )

      return {
        providerId: 'PAYSTACK',
        providerReference: data.reference ?? request.reference,
        action: 'otp',
        instruction:
          data.display_text ??
          'Check your phone and approve the payment prompt to complete this payment.',
        method: PaymentMethod.MOBILE_MONEY,
      }
    }

    // Card / bank: hosted checkout.
    const data = await paystackFetch<{ authorization_url: string; reference: string }>(
      '/transaction/initialize',
      {
        method: 'POST',
        idempotencyKey: request.idempotencyKey,
        body: {
          email: request.customerEmail,
          amount: request.amountMinor,
          currency: request.currency.toUpperCase(),
          reference: request.reference,
          callback_url: `${request.returnUrl}?ref=${request.reference}`,
          metadata: { ...request.metadata, description: request.description },
        },
      },
    )

    return {
      providerId: 'PAYSTACK',
      providerReference: data.reference,
      action: 'redirect',
      redirectUrl: data.authorization_url,
      method: PaymentMethod.CARD,
    }
  },

  verifyWebhook(rawBody, headers): WebhookVerification {
    const provided = headers['x-paystack-signature']
    if (!provided) {
      return {
        valid: false,
        eventId: null,
        eventType: null,
        payload: null,
        reason: 'Missing x-paystack-signature header',
      }
    }
    if (!env.PAYSTACK_SECRET_KEY) {
      return {
        valid: false,
        eventId: null,
        eventType: null,
        payload: null,
        reason: 'PAYSTACK_SECRET_KEY is not configured',
      }
    }

    // SHA-512, keyed with the SECRET key, over the RAW bytes.
    const expected = crypto
      .createHmac('sha512', env.PAYSTACK_SECRET_KEY)
      .update(rawBody)
      .digest('hex')

    const expectedBuffer = Buffer.from(expected, 'utf8')
    const providedBuffer = Buffer.from(provided, 'utf8')

    // timingSafeEqual throws on length mismatch, so compare lengths first, // and note that a length check is not a timing leak here because the digest
    // length is fixed and public.
    const valid =
      expectedBuffer.length === providedBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, providedBuffer)

    if (!valid) {
      logger.warn('Paystack webhook signature verification failed')
      return { valid: false, eventId: null, eventType: null, payload: null, reason: 'Signature mismatch' }
    }

    let payload: { event?: string; data?: { id?: number; reference?: string } }
    try {
      payload = JSON.parse(rawBody.toString('utf8'))
    } catch {
      return { valid: false, eventId: null, eventType: null, payload: null, reason: 'Body is not valid JSON' }
    }

    // Paystack sends no event id. Synthesise a stable one from the event type
    // and transaction id so retries deduplicate, without this, the 72-hour
    // retry schedule would credit an invoice repeatedly.
    const transactionId = payload.data?.id ?? payload.data?.reference ?? 'unknown'
    const eventId = `${payload.event ?? 'unknown'}:${transactionId}`

    return { valid: true, eventId, eventType: payload.event ?? null, payload }
  },

  extractReference(payload): string | null {
    const event = payload as { event?: string; data?: { reference?: string } } | null
    if (!event?.event) return null

    const handled = [
      'charge.success',
      'charge.failed',
      'transaction.success',
      'refund.processed',
      'refund.failed',
    ]
    if (!handled.includes(event.event)) return null

    return event.data?.reference ?? null
  },

  async fetchTransaction(providerReference): Promise<TransactionSnapshot> {
    // The verify endpoint is the authoritative source. Paystack explicitly
    // recommends calling it before granting value, and because their signature
    // has no replay window this is not optional here.
    const data = await paystackFetch<PaystackTransaction>(
      `/transaction/verify/${encodeURIComponent(providerReference)}`,
      { method: 'GET' },
    )

    const auth = data.authorization
    let channelDetail: string | null = null
    if (auth?.mobile_money_number) {
      channelDetail = `${(data.channel ?? 'mobile money').toUpperCase()} ${auth.mobile_money_number}`
    } else if (auth?.brand && auth.last4) {
      channelDetail = `${auth.brand} ••••${auth.last4}`
    } else if (data.channel) {
      channelDetail = data.channel
    }

    return {
      providerReference: data.reference,
      status: mapStatus(data.status),
      amountMinor: data.amount,
      currency: data.currency.toUpperCase(),
      feeMinor: data.fees ?? 0,
      channelDetail,
      failureCode: data.status === 'failed' ? 'paystack_failed' : null,
      failureMessage: data.status === 'failed' ? data.gateway_response : null,
      paidAt: data.paid_at ? new Date(data.paid_at) : null,
    }
  },
}

export { MOBILE_MONEY_COUNTRIES }
