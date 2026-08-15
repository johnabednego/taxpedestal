import { Schema, model, Document, Types } from 'mongoose'
import { SUPPORTED_CURRENCY_CODES } from '../core/money'

export enum PaymentProviderName {
  STRIPE = 'STRIPE',
  PAYSTACK = 'PAYSTACK',
  MANUAL = 'MANUAL',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  /** Mobile money: customer must authorise on their handset. */
  AWAITING_CUSTOMER = 'AWAITING_CUSTOMER',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
  ABANDONED = 'ABANDONED',
}

export enum PaymentMethod {
  CARD = 'CARD',
  MOBILE_MONEY = 'MOBILE_MONEY',
  BANK_TRANSFER = 'BANK_TRANSFER',
  CASH = 'CASH',
  CHEQUE = 'CHEQUE',
  OTHER = 'OTHER',
}

export interface IPayment extends Document {
  _id: Types.ObjectId
  org: Types.ObjectId
  invoice: Types.ObjectId
  provider: PaymentProviderName
  status: PaymentStatus
  method: PaymentMethod
  amountMinor: number
  currency: string
  /**
   * Our idempotency key, sent to the provider and unique per attempt.
   * Prevents a double-clicked Pay button becoming two charges.
   */
  idempotencyKey: string
  /** Provider's own identifier, e.g. Stripe PaymentIntent id, Paystack reference. */
  providerReference: string | null
  /** Fee retained by the provider, where reported. Needed for true net revenue. */
  providerFeeMinor: number
  failureCode: string | null
  failureMessage: string | null
  /** MoMo network or card brand, for display only. */
  channelDetail: string | null
  paidAt: Date | null
  refundedAt: Date | null
  refundedAmountMinor: number
  /** Only for MANUAL payments recorded by a team member. */
  recordedBy: Types.ObjectId | null
  note: string | null
  createdAt: Date
  updatedAt: Date
}

const paymentSchema = new Schema<IPayment>(
  {
    org: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    invoice: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true, index: true },
    provider: { type: String, enum: Object.values(PaymentProviderName), required: true },
    status: {
      type: String,
      enum: Object.values(PaymentStatus),
      default: PaymentStatus.PENDING,
      index: true,
    },
    method: { type: String, enum: Object.values(PaymentMethod), required: true },
    amountMinor: { type: Number, required: true },
    currency: { type: String, required: true, uppercase: true, enum: SUPPORTED_CURRENCY_CODES },
    idempotencyKey: { type: String, required: true, unique: true, index: true },
    providerReference: { type: String, default: null, index: true, sparse: true },
    providerFeeMinor: { type: Number, default: 0 },
    failureCode: { type: String, default: null },
    failureMessage: { type: String, default: null },
    channelDetail: { type: String, default: null },
    paidAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    refundedAmountMinor: { type: Number, default: 0 },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: null, maxlength: 1000 },
  },
  { timestamps: true },
)

paymentSchema.index({ org: 1, status: 1, createdAt: -1 })
paymentSchema.index({ invoice: 1, status: 1 })

export const Payment = model<IPayment>('Payment', paymentSchema)
