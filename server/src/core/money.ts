/**
 * Money primitives.
 *
 * DESIGN DECISION (defend this one): all monetary values are stored and
 * transported as INTEGER MINOR UNITS (pesewas, cents, kobo, yen).
 *
 * Rationale:
 *  - IEEE-754 doubles cannot represent 0.1 exactly. Accumulating floats over
 *    invoice line items produces drift that shows up as "invoice off by 1 cent"
 *    bugs, which in a billing product destroys user trust immediately.
 *  - Payment processors (Stripe, Paystack) already speak minor units, so this
 *    removes a conversion boundary rather than adding one.
 *  - Integers compare and sum exactly, which makes reconciliation provable.
 *
 * Consequence: every currency needs its exponent, because minor units are NOT
 * universally 1/100. JPY and KRW have exponent 0; BHD and KWD have exponent 3.
 * Assuming "divide by 100" is the single most common i18n billing bug.
 */

export type CurrencyCode = string

export interface CurrencyMeta {
  code: CurrencyCode
  /** Number of decimal places. ISO 4217 exponent. */
  exponent: number
  symbol: string
  name: string
}

/**
 * Currencies TaxPedestal can invoice in. Exponents follow ISO 4217.
 * Zero-decimal and three-decimal currencies are included deliberately so the
 * rounding logic is exercised by real data rather than assumed.
 */
export const CURRENCIES: Record<string, CurrencyMeta> = {
  USD: { code: 'USD', exponent: 2, symbol: '$', name: 'US Dollar' },
  EUR: { code: 'EUR', exponent: 2, symbol: '€', name: 'Euro' },
  GBP: { code: 'GBP', exponent: 2, symbol: '£', name: 'Pound Sterling' },
  GHS: { code: 'GHS', exponent: 2, symbol: 'GH₵', name: 'Ghana Cedi' },
  NGN: { code: 'NGN', exponent: 2, symbol: '₦', name: 'Nigerian Naira' },
  KES: { code: 'KES', exponent: 2, symbol: 'KSh', name: 'Kenyan Shilling' },
  ZAR: { code: 'ZAR', exponent: 2, symbol: 'R', name: 'South African Rand' },
  CAD: { code: 'CAD', exponent: 2, symbol: 'CA$', name: 'Canadian Dollar' },
  AUD: { code: 'AUD', exponent: 2, symbol: 'A$', name: 'Australian Dollar' },
  INR: { code: 'INR', exponent: 2, symbol: '₹', name: 'Indian Rupee' },
  SGD: { code: 'SGD', exponent: 2, symbol: 'S$', name: 'Singapore Dollar' },
  AED: { code: 'AED', exponent: 2, symbol: 'AED', name: 'UAE Dirham' },
  CHF: { code: 'CHF', exponent: 2, symbol: 'CHF', name: 'Swiss Franc' },
  BRL: { code: 'BRL', exponent: 2, symbol: 'R$', name: 'Brazilian Real' },
  CNY: { code: 'CNY', exponent: 2, symbol: '¥', name: 'Chinese Yuan' },
  ILS: { code: 'ILS', exponent: 2, symbol: '₪', name: 'Israeli New Shekel' },
  SAR: { code: 'SAR', exponent: 2, symbol: 'SAR', name: 'Saudi Riyal' },
  TRY: { code: 'TRY', exponent: 2, symbol: '₺', name: 'Turkish Lira' },
  MXN: { code: 'MXN', exponent: 2, symbol: 'MX$', name: 'Mexican Peso' },
  EGP: { code: 'EGP', exponent: 2, symbol: 'E£', name: 'Egyptian Pound' },
  PKR: { code: 'PKR', exponent: 2, symbol: '₨', name: 'Pakistani Rupee' },
  BDT: { code: 'BDT', exponent: 2, symbol: '৳', name: 'Bangladeshi Taka' },
  PHP: { code: 'PHP', exponent: 2, symbol: '₱', name: 'Philippine Peso' },
  MYR: { code: 'MYR', exponent: 2, symbol: 'RM', name: 'Malaysian Ringgit' },
  THB: { code: 'THB', exponent: 2, symbol: '฿', name: 'Thai Baht' },
  HKD: { code: 'HKD', exponent: 2, symbol: 'HK$', name: 'Hong Kong Dollar' },
  TWD: { code: 'TWD', exponent: 2, symbol: 'NT$', name: 'New Taiwan Dollar' },
  NZD: { code: 'NZD', exponent: 2, symbol: 'NZ$', name: 'New Zealand Dollar' },
  NOK: { code: 'NOK', exponent: 2, symbol: 'kr', name: 'Norwegian Krone' },
  SEK: { code: 'SEK', exponent: 2, symbol: 'kr', name: 'Swedish Krona' },
  DKK: { code: 'DKK', exponent: 2, symbol: 'kr', name: 'Danish Krone' },
  PLN: { code: 'PLN', exponent: 2, symbol: 'zł', name: 'Polish Zloty' },
  CZK: { code: 'CZK', exponent: 2, symbol: 'Kč', name: 'Czech Koruna' },
  HUF: { code: 'HUF', exponent: 2, symbol: 'Ft', name: 'Hungarian Forint' },
  RON: { code: 'RON', exponent: 2, symbol: 'lei', name: 'Romanian Leu' },
  UAH: { code: 'UAH', exponent: 2, symbol: '₴', name: 'Ukrainian Hryvnia' },
  MAD: { code: 'MAD', exponent: 2, symbol: 'DH', name: 'Moroccan Dirham' },
  TZS: { code: 'TZS', exponent: 2, symbol: 'TSh', name: 'Tanzanian Shilling' },
  UGX: { code: 'UGX', exponent: 0, symbol: 'USh', name: 'Ugandan Shilling' },
  RWF: { code: 'RWF', exponent: 0, symbol: 'FRw', name: 'Rwandan Franc' },
  ZMW: { code: 'ZMW', exponent: 2, symbol: 'ZK', name: 'Zambian Kwacha' },
  ETB: { code: 'ETB', exponent: 2, symbol: 'Br', name: 'Ethiopian Birr' },
  ARS: { code: 'ARS', exponent: 2, symbol: 'AR$', name: 'Argentine Peso' },
  CLP: { code: 'CLP', exponent: 0, symbol: 'CL$', name: 'Chilean Peso' },
  COP: { code: 'COP', exponent: 2, symbol: 'CO$', name: 'Colombian Peso' },
  PEN: { code: 'PEN', exponent: 2, symbol: 'S/', name: 'Peruvian Sol' },
  QAR: { code: 'QAR', exponent: 2, symbol: 'QR', name: 'Qatari Riyal' },
  // West and Central African CFA francs, zero-decimal.
  XOF: { code: 'XOF', exponent: 0, symbol: 'CFA', name: 'West African CFA Franc' },
  XAF: { code: 'XAF', exponent: 0, symbol: 'FCFA', name: 'Central African CFA Franc' },
  // Zero-decimal currencies, the minor unit IS the major unit.
  JPY: { code: 'JPY', exponent: 0, symbol: '¥', name: 'Japanese Yen' },
  KRW: { code: 'KRW', exponent: 0, symbol: '₩', name: 'South Korean Won' },
  VND: { code: 'VND', exponent: 0, symbol: '₫', name: 'Vietnamese Dong' },
  IDR: { code: 'IDR', exponent: 2, symbol: 'Rp', name: 'Indonesian Rupiah' },
  ISK: { code: 'ISK', exponent: 0, symbol: 'kr', name: 'Icelandic Krona' },
  // Three-decimal currencies. Dividing these by 100 is a real, common bug.
  KWD: { code: 'KWD', exponent: 3, symbol: 'KD', name: 'Kuwaiti Dinar' },
  BHD: { code: 'BHD', exponent: 3, symbol: 'BD', name: 'Bahraini Dinar' },
  OMR: { code: 'OMR', exponent: 3, symbol: 'OMR', name: 'Omani Rial' },
  JOD: { code: 'JOD', exponent: 3, symbol: 'JD', name: 'Jordanian Dinar' },
  TND: { code: 'TND', exponent: 3, symbol: 'DT', name: 'Tunisian Dinar' },
  IQD: { code: 'IQD', exponent: 3, symbol: 'ID', name: 'Iraqi Dinar' },
}

export const SUPPORTED_CURRENCY_CODES = Object.keys(CURRENCIES)

export function isSupportedCurrency(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, code.toUpperCase())
}

export function currencyMeta(code: string): CurrencyMeta {
  const meta = CURRENCIES[code.toUpperCase()]
  if (!meta) throw new Error(`Unsupported currency: ${code}`)
  return meta
}

/** 10 ** exponent, as an integer. */
export function minorUnitFactor(code: string): number {
  return 10 ** currencyMeta(code).exponent
}

/**
 * Banker-safe half-up rounding for positive and negative values.
 *
 * Math.round(-0.5) === -0 in JavaScript (rounds toward +Infinity), which makes
 * credit notes and negative adjustments round inconsistently with positive
 * amounts. This rounds away from zero on the .5 boundary so that
 * round(x) === -round(-x) always holds.
 */
export function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Cannot round a non-finite value')
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/** Convert a major-unit decimal (12.34) to minor units (1234). */
export function toMinor(major: number, currency: string): number {
  if (!Number.isFinite(major)) throw new Error('Amount must be a finite number')
  return roundHalfAwayFromZero(major * minorUnitFactor(currency))
}

/**
 * Parse a decimal STRING exactly into minor units.
 *
 * This exists because `toMinor` cannot be made correct for all inputs. The
 * value 1.005 is not representable in IEEE-754; the nearest double is
 * 1.00499999999999989..., so `1.005 * 100` yields 100.49999999999999 and any
 * rounding of that gives 100, not the 101 the user typed. The precision is lost
 * at the literal, before our code runs.
 *
 * The only fix is to never let the value become a float. API request bodies
 * therefore accept amounts as strings or as integer minor units, and this
 * function does the conversion by digit manipulation rather than arithmetic.
 *
 * This is why the invoice API contract uses `unitAmountMinor: number` (integer)
 * rather than `unitAmount: 12.34`.
 */
export function parseMoneyInput(input: string | number, currency: string): number {
  if (typeof input === 'number') {
    // Integers are already unambiguous; anything else is a float and lossy.
    if (Number.isInteger(input)) return toMinor(input, currency)
    return toMinor(input, currency)
  }

  const trimmed = input.trim().replace(/[\s,_]/g, '')
  if (!/^-?\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '-') {
    throw new Error(`Cannot parse "${input}" as a monetary amount`)
  }

  const negative = trimmed.startsWith('-')
  const unsigned = negative ? trimmed.slice(1) : trimmed
  const [wholeRaw = '', fracRaw = ''] = unsigned.split('.')
  const whole = wholeRaw === '' ? '0' : wholeRaw
  const exponent = currencyMeta(currency).exponent

  // Pad the fraction to the currency's exponent, keeping one extra digit so a
  // half-up decision can be made on the digit that falls off the end.
  const padded = fracRaw.padEnd(exponent + 1, '0')
  const kept = padded.slice(0, exponent)
  const nextDigit = Number(padded[exponent] ?? '0')

  let minor = Number(`${whole}${kept}` || '0')
  if (!Number.isSafeInteger(minor)) {
    throw new Error('Amount exceeds the safe integer range')
  }
  if (nextDigit >= 5) minor += 1

  return negative ? -minor : minor
}

/** Convert minor units (1234) to a major-unit decimal (12.34). */
export function toMajor(minor: number, currency: string): number {
  assertInteger(minor, 'minor amount')
  return minor / minorUnitFactor(currency)
}

export function assertInteger(value: number, label = 'value'): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer in minor units, received ${value}`)
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} exceeds the safe integer range`)
  }
}

/**
 * Apply a percentage rate to a minor-unit amount, returning minor units.
 * Rate is expressed in basis points to keep the input space integral
 * (1500 bps = 15.00%). Percentages as floats reintroduce the exact problem
 * minor units were adopted to avoid.
 */
export function applyBasisPoints(amountMinor: number, basisPoints: number): number {
  assertInteger(amountMinor, 'amountMinor')
  assertInteger(basisPoints, 'basisPoints')
  return roundHalfAwayFromZero((amountMinor * basisPoints) / 10_000)
}

/**
 * Distribute a minor-unit total across n weighted parts with ZERO rounding
 * loss: the returned parts always sum exactly to `total`.
 *
 * Used for allocating a partial payment or an invoice-level discount across
 * line items. The naive approach (round each share independently) leaks or
 * invents money; the largest-remainder method does not.
 */
export function allocate(total: number, weights: number[]): number[] {
  assertInteger(total, 'total')
  if (weights.length === 0) return []
  if (weights.some((w) => w < 0)) throw new Error('Weights must be non-negative')

  const weightSum = weights.reduce((a, b) => a + b, 0)
  if (weightSum === 0) {
    // Degenerate case: no weights. Put everything on the first slot so the
    // invariant (parts sum to total) still holds.
    return weights.map((_, i) => (i === 0 ? total : 0))
  }

  const sign = total < 0 ? -1 : 1
  const magnitude = Math.abs(total)

  const exact = weights.map((w) => (magnitude * w) / weightSum)
  const floored = exact.map((v) => Math.floor(v))
  let remainder = magnitude - floored.reduce((a, b) => a + b, 0)

  // Hand the leftover minor units to the parts with the largest fractional
  // remainder, breaking ties by index for deterministic output.
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)

  const result = [...floored]
  for (const { i } of order) {
    if (remainder <= 0) break
    result[i] = (result[i] ?? 0) + 1
    remainder -= 1
  }

  return result.map((v) => v * sign)
}

/** Format minor units for display. Uses Intl so locale rules are respected. */
export function formatMoney(minor: number, currency: string, locale = 'en-US'): string {
  const meta = currencyMeta(currency)
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: meta.code,
    minimumFractionDigits: meta.exponent,
    maximumFractionDigits: meta.exponent,
  }).format(toMajor(minor, currency))
}

export function sum(values: number[]): number {
  values.forEach((v) => assertInteger(v, 'summand'))
  return values.reduce((a, b) => a + b, 0)
}
