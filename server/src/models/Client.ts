import { Schema, model, Document, Types } from 'mongoose'
import { isValidCountry } from '../core/countries'
import { SUPPORTED_CURRENCY_CODES } from '../core/money'

/**
 * A customer of the organisation, the party an invoice is addressed to.
 *
 * `isBusiness` and `taxId` together decide whether a cross-border EU supply is
 * reverse-charged, so they are not cosmetic contact fields: they change the
 * amount owed. The UI labels them accordingly.
 */
export interface IClient extends Document {
  _id: Types.ObjectId
  org: Types.ObjectId
  name: string
  /** Primary billing contact, where invoices are sent. */
  email: string | null
  phone: string | null
  contactName: string | null
  country: string
  region: string | null
  city: string | null
  addressLine1: string | null
  addressLine2: string | null
  postalCode: string | null
  /** True => B2B. With a taxId this can shift tax liability to the customer. */
  isBusiness: boolean
  taxId: string | null
  taxRegistered: boolean
  defaultCurrency: string
  paymentTermsDays: number | null
  notes: string | null
  tags: string[]
  archivedAt: Date | null
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const clientSchema = new Schema<IClient>(
  {
    org: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 180 },
    email: { type: String, default: null, lowercase: true, trim: true },
    phone: { type: String, default: null, trim: true },
    contactName: { type: String, default: null, trim: true },
    country: {
      type: String,
      required: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
      validate: { validator: isValidCountry, message: 'Unknown country code' },
    },
    region: { type: String, default: null, uppercase: true },
    city: { type: String, default: null },
    addressLine1: { type: String, default: null },
    addressLine2: { type: String, default: null },
    postalCode: { type: String, default: null },
    isBusiness: { type: Boolean, default: true },
    taxId: { type: String, default: null, trim: true },
    taxRegistered: { type: Boolean, default: false },
    defaultCurrency: { type: String, uppercase: true, enum: SUPPORTED_CURRENCY_CODES, default: 'USD' },
    paymentTermsDays: { type: Number, default: null, min: 0, max: 365 },
    notes: { type: String, default: null, maxlength: 2000 },
    tags: { type: [String], default: [] },
    archivedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

// Compound index leading with `org`: every query is tenant-scoped, so org must
// be the prefix for the index to be usable.
clientSchema.index({ org: 1, archivedAt: 1, name: 1 })
clientSchema.index({ org: 1, name: 'text', email: 'text' })

export const Client = model<IClient>('Client', clientSchema)
