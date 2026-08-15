import { Schema, model, Document, Types } from 'mongoose'
import { isValidCountry } from '../core/countries'
import { SUPPORTED_CURRENCY_CODES } from '../core/money'

export enum PlanTier {
  FREE = 'FREE',
  PRO = 'PRO',
  SCALE = 'SCALE',
}

/**
 * An Organisation is the tenant boundary. Every business record carries an
 * `org` field, and scoping is applied in middleware rather than by convention
 * in controllers — a forgotten filter in one handler is a cross-tenant data
 * leak, which is the failure mode that ends a billing company.
 */
export interface IOrganisation extends Document {
  _id: Types.ObjectId
  name: string
  slug: string
  legalName: string | null
  /** ISO 3166-1 alpha-2. Selects the tax jurisdiction rule that applies. */
  country: string
  region: string | null
  city: string | null
  addressLine1: string | null
  addressLine2: string | null
  postalCode: string | null
  email: string | null
  phone: string | null
  website: string | null
  logoUrl: string | null
  brandColor: string
  baseCurrency: string
  /** If false, no tax is ever charged regardless of jurisdiction. */
  taxRegistered: boolean
  taxId: string | null
  taxLabel: string | null
  /**
   * The organisation's own tax definition, used where TaxPedestal has no built-in
   * rule for their country, or where they choose to override one. This is what
   * makes the product usable from any territory rather than only the ~50 we
   * ship rules for.
   */
  customTaxProfile: {
    enabled: boolean
    overrideBuiltIn: boolean
    components: Array<{ code: string; label: string; basisPoints: number }>
    zeroRateExports: boolean
    notes: string[]
  }
  invoicePrefix: string
  invoiceNumberPadding: number
  defaultPaymentTermsDays: number
  defaultNotes: string | null
  defaultFooter: string | null
  /**
   * Bank transfer instructions, printed on every invoice.
   *
   * THE UNIVERSAL PAYMENT RAIL. A business in a country no gateway will
   * onboard still gets paid, because their customer simply transfers to these
   * details. Deliberately free-form beyond the common fields: account
   * identifiers differ enormously worldwide (IBAN, SWIFT/BIC, routing number,
   * sort code, IFSC, CLABE, mobile money handle), and a rigid schema would
   * exclude exactly the markets this feature exists to serve.
   */
  paymentInstructions: {
    enabled: boolean
    accountName: string | null
    bankName: string | null
    accountNumber: string | null
    /** IBAN, sort code, routing number, IFSC, CLABE — whatever applies. */
    routingCode: string | null
    swiftBic: string | null
    /** Mobile money or wallet handle, where that is how the business is paid. */
    mobileMoneyNumber: string | null
    mobileMoneyProvider: string | null
    /** Anything else the payer needs — intermediary bank, reference format. */
    additionalDetails: string | null
  }
  /**
   * Invoice presentation. Legally required content is NOT configurable here —
   * see services/documents/requirements.ts for why.
   */
  invoiceTemplate: {
    preset: 'classic' | 'modern' | 'compact'
    accentColor: string
    /** null means "follow the customer's country". */
    documentLocale: string | null
    showLogo: boolean
    showPaymentInstructions: boolean
    showTaxSummary: boolean
    customFields: Array<{ label: string; value: string }>
    documentTitleOverride: string | null
  }
  plan: PlanTier
  monthlyInvoiceLimit: number
  onboardingCompletedAt: Date | null
  suspendedAt: Date | null
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const orgSchema = new Schema<IOrganisation>(
  {
    name: { type: String, required: true, trim: true, maxlength: 140 },
    slug: { type: String, required: true, unique: true, lowercase: true, index: true },
    legalName: { type: String, default: null, trim: true },
    // Any ISO 3166 country. Tax automation is a separate capability — see
    // src/core/countries.ts for why these two lists must not be conflated.
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
    email: { type: String, default: null, lowercase: true, trim: true },
    phone: { type: String, default: null },
    website: { type: String, default: null },
    logoUrl: { type: String, default: null },
    brandColor: { type: String, default: '#2B59FF' },
    baseCurrency: {
      type: String,
      required: true,
      uppercase: true,
      enum: SUPPORTED_CURRENCY_CODES,
      default: 'USD',
    },
    taxRegistered: { type: Boolean, default: false },
    taxId: { type: String, default: null, trim: true },
    taxLabel: { type: String, default: null },
    customTaxProfile: {
      enabled: { type: Boolean, default: false },
      overrideBuiltIn: { type: Boolean, default: false },
      components: {
        type: [{ _id: false, code: String, label: String, basisPoints: Number }],
        default: [],
      },
      zeroRateExports: { type: Boolean, default: true },
      notes: { type: [String], default: [] },
    },
    invoicePrefix: { type: String, default: 'INV', uppercase: true, maxlength: 10 },
    invoiceNumberPadding: { type: Number, default: 4, min: 1, max: 10 },
    defaultPaymentTermsDays: { type: Number, default: 14, min: 0, max: 365 },
    defaultNotes: { type: String, default: null },
    defaultFooter: { type: String, default: null },
    paymentInstructions: {
      enabled: { type: Boolean, default: false },
      accountName: { type: String, default: null, maxlength: 140 },
      bankName: { type: String, default: null, maxlength: 140 },
      accountNumber: { type: String, default: null, maxlength: 60 },
      routingCode: { type: String, default: null, maxlength: 60 },
      swiftBic: { type: String, default: null, maxlength: 30 },
      mobileMoneyNumber: { type: String, default: null, maxlength: 40 },
      mobileMoneyProvider: { type: String, default: null, maxlength: 60 },
      additionalDetails: { type: String, default: null, maxlength: 1000 },
    },
    invoiceTemplate: {
      preset: { type: String, enum: ['classic', 'modern', 'compact'], default: 'classic' },
      accentColor: { type: String, default: '#2B59FF' },
      documentLocale: { type: String, default: null },
      showLogo: { type: Boolean, default: true },
      showPaymentInstructions: { type: Boolean, default: true },
      showTaxSummary: { type: Boolean, default: true },
      customFields: {
        type: [{ _id: false, label: String, value: String }],
        default: [],
      },
      documentTitleOverride: { type: String, default: null },
    },
    plan: { type: String, enum: Object.values(PlanTier), default: PlanTier.FREE },
    monthlyInvoiceLimit: { type: Number, default: 25 },
    onboardingCompletedAt: { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

export const Organisation = model<IOrganisation>('Organisation', orgSchema)
