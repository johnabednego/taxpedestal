/**
 * Formatting helpers.
 *
 * Mirrors server/src/core/money.ts. Amounts arrive as INTEGER MINOR UNITS and
 * are only converted at the moment of display, never stored or arithmetic'd as
 * floats in the client either, or the totals shown would drift from the totals
 * charged.
 */

export interface CurrencyMeta {
  code: string
  exponent: number
  symbol: string
  name: string
}

/** Fallback until /meta loads. Zero-decimal currencies are the trap. */
const FALLBACK_EXPONENTS: Record<string, number> = { JPY: 0, KRW: 0, KWD: 3 }

let exponents: Record<string, number> = { ...FALLBACK_EXPONENTS }

export function registerCurrencies(list: CurrencyMeta[]): void {
  exponents = Object.fromEntries(list.map((c) => [c.code, c.exponent]))
}

export function exponentFor(currency: string): number {
  return exponents[currency.toUpperCase()] ?? 2
}

export function formatMoney(minor: number, currency: string, locale = 'en-GB'): string {
  const exponent = exponentFor(currency)
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(minor / 10 ** exponent)
  } catch {
    return `${currency} ${(minor / 10 ** exponent).toFixed(exponent)}`
  }
}

/** Compact form for dashboard tiles: GH₵1.2M rather than GH₵1,234,567.00 */
export function formatCompact(minor: number, currency: string, locale = 'en-GB'): string {
  const exponent = exponentFor(currency)
  const major = minor / 10 ** exponent
  if (Math.abs(major) < 10_000) return formatMoney(minor, currency, locale)
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(major)
  } catch {
    return formatMoney(minor, currency, locale)
  }
}

/** Parse a typed decimal string into minor units WITHOUT float arithmetic. */
export function parseMoney(input: string, currency: string): number {
  const trimmed = input.trim().replace(/[\s,_]/g, '')
  if (!/^-?\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '-') return 0

  const negative = trimmed.startsWith('-')
  const unsigned = negative ? trimmed.slice(1) : trimmed
  const [whole = '', frac = ''] = unsigned.split('.')
  const exponent = exponentFor(currency)

  const padded = frac.padEnd(exponent + 1, '0')
  const kept = padded.slice(0, exponent)
  const next = Number(padded[exponent] ?? '0')

  let minor = Number(`${whole || '0'}${kept}` || '0')
  if (next >= 5) minor += 1
  return negative ? -minor : minor
}

/** Minor units -> an editable decimal string for inputs. */
export function toInputValue(minor: number, currency: string): string {
  const exponent = exponentFor(currency)
  if (exponent === 0) return String(minor)
  const negative = minor < 0
  const digits = String(Math.abs(minor)).padStart(exponent + 1, '0')
  const whole = digits.slice(0, -exponent)
  const frac = digits.slice(-exponent)
  return `${negative ? '-' : ''}${whole}.${frac}`
}

/** Quantity is stored in thousandths. */
export const qtyToInput = (milli: number): string => String(milli / 1000)
export const inputToQty = (value: string): number => Math.round((Number(value) || 0) * 1000)

export const formatPercent = (basisPoints: number): string =>
  `${(basisPoints / 100).toFixed(basisPoints % 100 === 0 ? 0 : 2)}%`

export function relativeDays(date: string | Date): string {
  const target = new Date(date)
  const days = Math.round((target.getTime() - Date.now()) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  if (days > 0) return `in ${days} days`
  return `${Math.abs(days)} days ago`
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}
