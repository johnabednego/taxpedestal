import { Schema, model, Document, Types } from 'mongoose'

/**
 * Ledger of inbound provider webhooks.
 *
 * DESIGN DECISION: every webhook is recorded before it is acted upon, keyed by
 * the provider's own event id with a unique index.
 *
 * Payment providers guarantee AT-LEAST-ONCE delivery, not exactly-once. Stripe
 * and Paystack both retry on non-2xx, and both can deliver duplicates even on
 * success. Without this table a retried `payment.success` credits the invoice
 * twice, and the customer is told they overpaid. The unique index makes the
 * duplicate a caught insert error rather than a financial one.
 */
export interface IWebhookEvent extends Document {
  _id: Types.ObjectId
  provider: string
  /** Provider's event id. Unique together with provider. */
  eventId: string
  eventType: string
  processedAt: Date | null
  status: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED'
  error: string | null
  attempts: number
  /** Raw payload retained for dispute investigation and replay. */
  payload: unknown
  signatureValid: boolean
  createdAt: Date
}

const webhookEventSchema = new Schema<IWebhookEvent>(
  {
    provider: { type: String, required: true },
    eventId: { type: String, required: true },
    eventType: { type: String, required: true, index: true },
    processedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED'],
      default: 'RECEIVED',
      index: true,
    },
    error: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    payload: { type: Schema.Types.Mixed },
    signatureValid: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

// The idempotency guarantee.
webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true })

export const WebhookEvent = model<IWebhookEvent>('WebhookEvent', webhookEventSchema)
