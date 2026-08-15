/**
 * Country helpers for the client.
 *
 * Names are resolved with Intl.DisplayNames against the browser's locale, so a
 * French user sees "Allemagne" and a Chinese user sees "德国" without us
 * shipping a translation file. The API sends the same list already localized;
 * this is the offline fallback and the formatter for anything rendered locally.
 */

export interface CountryOption {
  code: string
  name: string
  defaultCurrency: string
  hasAutomaticTax: boolean
}

export function browserLocale(): string {
  if (typeof navigator === 'undefined') return 'en'
  return navigator.language || 'en'
}

export function countryName(code: string, locale = browserLocale()): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code.toUpperCase()) ?? code
  } catch {
    return code.toUpperCase()
  }
}

/** Flag emoji from an ISO code, by offsetting into the regional indicator range. */
export function flagFor(code: string): string {
  const upper = code.toUpperCase()
  if (!/^[A-Z]{2}$/.test(upper)) return ''
  return String.fromCodePoint(
    ...[...upper].map((c) => 0x1f1e6 - 65 + c.charCodeAt(0)),
  )
}

/** Sub-national codes are only required where they change the tax answer. */
export const REGION_REQUIRED = new Set(['US', 'CA', 'IN'])

export const REGION_LABEL: Record<string, string> = {
  US: 'State',
  CA: 'Province',
  IN: 'State',
}
