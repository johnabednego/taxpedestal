import { Schema, model, Document, Types } from 'mongoose'

export enum PlatformRole {
  USER = 'USER',
  SUPERADMIN = 'SUPERADMIN',
}

export interface IUser extends Document {
  _id: Types.ObjectId
  email: string
  passwordHash: string
  fullName: string
  avatarColor: string
  /**
   * Interface language, as a BCP 47 tag.
   *
   * Stored on the account rather than only in the browser so the choice
   * follows the user to a new device, someone who set the interface to Arabic
   * should not have to find the switcher again on their phone.
   *
   * Null means "never chosen", which is different from "chose English": the
   * first is a signal to keep following the browser, the second is a decision
   * to respect even on a device whose browser says otherwise.
   */
  preferredLocale: string | null
  platformRole: PlatformRole
  emailVerifiedAt: Date | null
  /** Stored hashed so a database read alone cannot mint a session. */
  verificationTokenHash: string | null
  passwordResetTokenHash: string | null
  passwordResetExpiresAt: Date | null
  /** Bumping this invalidates every refresh token ever issued to the user. */
  tokenVersion: number
  lastLoginAt: Date | null
  failedLoginAttempts: number
  lockedUntil: Date | null
  suspendedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const userSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    // select:false so an accidental User.find() in a controller cannot
    // serialise credential material into an HTTP response.
    passwordHash: { type: String, required: true, select: false },
    fullName: { type: String, required: true, trim: true, maxlength: 120 },
    avatarColor: { type: String, default: '#2B59FF' },
    preferredLocale: { type: String, default: null, maxlength: 10 },
    platformRole: {
      type: String,
      enum: Object.values(PlatformRole),
      default: PlatformRole.USER,
      index: true,
    },
    emailVerifiedAt: { type: Date, default: null },
    verificationTokenHash: { type: String, default: null, select: false },
    passwordResetTokenHash: { type: String, default: null, select: false },
    passwordResetExpiresAt: { type: Date, default: null, select: false },
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date, default: null },
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

// Defence in depth: even if a query forgets to exclude these, they never
// reach a JSON response body.
userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    const out = ret as unknown as Record<string, unknown>
    delete out.passwordHash
    delete out.verificationTokenHash
    delete out.passwordResetTokenHash
    delete out.passwordResetExpiresAt
    delete out.__v
    return out
  },
})

export const User = model<IUser>('User', userSchema)
