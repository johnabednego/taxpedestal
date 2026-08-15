import { Schema, model, Document, Types } from 'mongoose'

/** Ordered so "at least this role" checks are a numeric comparison. */
export enum OrgRole {
  VIEWER = 'VIEWER',
  MEMBER = 'MEMBER',
  ADMIN = 'ADMIN',
  OWNER = 'OWNER',
}

export const ROLE_RANK: Record<OrgRole, number> = {
  [OrgRole.VIEWER]: 0,
  [OrgRole.MEMBER]: 1,
  [OrgRole.ADMIN]: 2,
  [OrgRole.OWNER]: 3,
}

export enum MembershipStatus {
  INVITED = 'INVITED',
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
}

export interface IMembership extends Document {
  _id: Types.ObjectId
  org: Types.ObjectId
  user: Types.ObjectId | null
  /** Set for pending invitations where no user account exists yet. */
  invitedEmail: string | null
  role: OrgRole
  status: MembershipStatus
  invitationTokenHash: string | null
  invitationExpiresAt: Date | null
  invitedBy: Types.ObjectId | null
  acceptedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const membershipSchema = new Schema<IMembership>(
  {
    org: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    invitedEmail: { type: String, default: null, lowercase: true, trim: true },
    role: { type: String, enum: Object.values(OrgRole), required: true },
    status: {
      type: String,
      enum: Object.values(MembershipStatus),
      default: MembershipStatus.ACTIVE,
      index: true,
    },
    invitationTokenHash: { type: String, default: null, select: false },
    invitationExpiresAt: { type: Date, default: null },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    acceptedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

// A user holds at most one membership per organisation. Enforced by the
// database rather than a read-then-write check, which races under concurrent
// invitation acceptance.
membershipSchema.index(
  { org: 1, user: 1 },
  { unique: true, partialFilterExpression: { user: { $type: 'objectId' } } },
)
membershipSchema.index(
  { org: 1, invitedEmail: 1 },
  { unique: true, partialFilterExpression: { invitedEmail: { $type: 'string' } } },
)

export const Membership = model<IMembership>('Membership', membershipSchema)
