import { Schema, model, Document, Types } from 'mongoose'

/**
 * Idempotency keys for OUR OWN API.
 *
 * Stripe gives its callers idempotency keys. Almost no application built on top
 * of Stripe passes that guarantee on to its own clients, so a mobile client
 * that retries a POST after a timeout creates two invoices, and the user is left
 * deleting duplicates. We close that gap.
 *
 * Semantics follow Stripe's, because they are well understood:
 *   - Same key, same request body  -> the ORIGINAL response is replayed.
 *   - Same key, different body     -> 409. The key is being misused.
 *   - Key still in flight          -> 409, so concurrent duplicates cannot both
 *                                     execute.
 *   - Keys expire after 24 hours.
 */
export interface IIdempotencyKey extends Document {
  _id: Types.ObjectId
  key: string
  /** Scoped per user so one caller cannot replay another caller's response. */
  user: Types.ObjectId | null
  org: Types.ObjectId | null
  method: string
  path: string
  /** SHA-256 of the request body, to detect key reuse with different content. */
  requestHash: string
  status: 'IN_FLIGHT' | 'COMPLETED'
  responseStatus: number | null
  responseBody: unknown
  expiresAt: Date
  createdAt: Date
}

const idempotencyKeySchema = new Schema<IIdempotencyKey>(
  {
    key: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    org: { type: Schema.Types.ObjectId, ref: 'Organisation', default: null },
    method: { type: String, required: true },
    path: { type: String, required: true },
    requestHash: { type: String, required: true },
    status: { type: String, enum: ['IN_FLIGHT', 'COMPLETED'], default: 'IN_FLIGHT' },
    responseStatus: { type: Number, default: null },
    responseBody: { type: Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

// One record per (key, user). The unique index is what makes concurrent
// duplicate requests safe without locking.
idempotencyKeySchema.index({ key: 1, user: 1 }, { unique: true })
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const IdempotencyKey = model<IIdempotencyKey>('IdempotencyKey', idempotencyKeySchema)
