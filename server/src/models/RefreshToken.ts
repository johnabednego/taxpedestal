import { Schema, model, Document, Types } from 'mongoose'

/**
 * Refresh token records supporting rotation with reuse detection.
 *
 * Only a SHA-256 hash of the token is stored. A stolen database dump therefore
 * yields no usable sessions.
 *
 * `replacedBy` forms a chain. If a token that has already been rotated is
 * presented again, that means two parties hold the same token, the family is
 * compromised, so every descendant is revoked and the user's tokenVersion is
 * bumped. This is the standard defence against refresh token replay.
 */
export interface IRefreshToken extends Document {
  _id: Types.ObjectId
  user: Types.ObjectId
  tokenHash: string
  family: string
  replacedBy: Types.ObjectId | null
  revokedAt: Date | null
  revokedReason: string | null
  expiresAt: Date
  userAgent: string | null
  ip: string | null
  createdAt: Date
}

const refreshTokenSchema = new Schema<IRefreshToken>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    family: { type: String, required: true, index: true },
    replacedBy: { type: Schema.Types.ObjectId, ref: 'RefreshToken', default: null },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

// Mongo evicts expired documents automatically, so revoked sessions do not
// accumulate forever and no cleanup job is needed.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const RefreshToken = model<IRefreshToken>('RefreshToken', refreshTokenSchema)
