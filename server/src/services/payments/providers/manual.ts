import { PaymentMethod } from '../../../models/Payment'
import type { CheckoutRequest, CheckoutResult, PaymentProvider, TransactionSnapshot } from '../types'

/**
 * Manual / offline payments.
 *
 * Not a gateway. Represents cash, cheque or a bank transfer the user reconciled
 * themselves, recorded by a team member. Implemented as a provider so the
 * invoice service has exactly one code path for "money arrived" rather than a
 * special case that skips the audit trail.
 *
 * Always available — a business must be able to record a payment even with no
 * gateway configured, and on the free plan that is the only option.
 */
export const manualProvider: PaymentProvider = {
  id: 'MANUAL',
  displayName: 'Recorded manually',

  isConfigured() {
    return true
  },

  supports() {
    return true
  },

  methodsFor() {
    return [
      PaymentMethod.BANK_TRANSFER,
      PaymentMethod.CASH,
      PaymentMethod.CHEQUE,
      PaymentMethod.MOBILE_MONEY,
      PaymentMethod.OTHER,
    ]
  },

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    // Nothing to initiate: the money already moved outside the system.
    return {
      providerId: 'MANUAL',
      providerReference: request.reference,
      action: 'settled',
      method: PaymentMethod.OTHER,
    }
  },

  verifyWebhook() {
    // No inbound webhooks exist for offline payments. Returning invalid rather
    // than throwing keeps the webhook router uniform.
    return {
      valid: false,
      eventId: null,
      eventType: null,
      payload: null,
      reason: 'Manual payments do not receive webhooks',
    }
  },

  extractReference() {
    return null
  },

  async fetchTransaction(providerReference): Promise<TransactionSnapshot> {
    // A manual payment is authoritative at the point it was recorded; there is
    // no external system to re-query.
    return {
      providerReference,
      status: 'succeeded',
      amountMinor: 0,
      currency: 'USD',
      feeMinor: 0,
      channelDetail: null,
    }
  },
}
