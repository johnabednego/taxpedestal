import { Schema, model, Document, Types } from 'mongoose'

/**
 * Append-only audit trail.
 *
 * Required for a financial product: "who voided that invoice, and when" must be
 * answerable months later. Writes are fire-and-forget from the caller's point of
 * view, an audit failure must never fail the user's action, but the record is
 * never updated or deleted through the application.
 */
export interface IAuditLog extends Document {
  _id: Types.ObjectId
  org: Types.ObjectId | null
  actor: Types.ObjectId | null
  /** Present when the action came from an unauthenticated public page. */
  actorLabel: string | null
  action: string
  entityType: string
  entityId: string | null
  /** Field-level before/after for mutations. Never contains credentials. */
  changes: unknown
  ip: string | null
  userAgent: string | null
  requestId: string | null
  createdAt: Date
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    org: { type: Schema.Types.ObjectId, ref: 'Organisation', default: null, index: true },
    actor: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    actorLabel: { type: String, default: null },
    action: { type: String, required: true, index: true },
    entityType: { type: String, required: true },
    entityId: { type: String, default: null, index: true },
    changes: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    requestId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

auditLogSchema.index({ org: 1, createdAt: -1 })
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 })

export const AuditLog = model<IAuditLog>('AuditLog', auditLogSchema)
