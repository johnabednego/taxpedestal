/**
 * Country registry.
 *
 * ============================================================================
 * THE DISTINCTION THIS FILE EXISTS TO ENFORCE
 * ============================================================================
 * There are two different questions, and conflating them was a real defect:
 *
 *   1. "Can I run my business from here?"      -> EVERY country. Always.
 *   2. "Can TaxPedestal compute my tax for me?"   -> the 40-odd jurisdictions
 *                                                 with a built-in rule.
 *
 * The first version of this product answered both from the tax registry, which
 * meant a business in China, Iraq or Israel could not even complete
 * registration — the country picker simply did not list them. That is not a
 * missing feature, it is a locked door.
 *
 * Now: operating countries come from here (the full ISO 3166-1 list), and tax
 * automation is a capability that a country either has or does not. Where it
 * does not, the organisation defines its own tax components (see
 * Organisation.customTaxProfile). Nothing is ever blocked.
 *
 * DISPLAY NAMES ARE NOT STORED. `Intl.DisplayNames` resolves a code to a name
 * in whatever locale the reader is using — "DE" becomes Germany, Allemagne,
 * Deutschland or 德国 with no translation table on our side. Hardcoding English
 * names would have made the product monolingual by construction.
 */

/** ISO 3166-1 alpha-2, the officially assigned set. */
export const COUNTRY_CODES = [
  'AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ',
  'BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS',
  'BT','BV','BW','BY','BZ','CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN',
  'CO','CR','CU','CV','CW','CX','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE',
  'EG','EH','ER','ES','ET','FI','FJ','FK','FM','FO','FR','GA','GB','GD','GE','GF',
  'GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HM',
  'HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT','JE','JM',
  'JO','JP','KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ','LA','LB','LC',
  'LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MH','MK',
  'ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA',
  'NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG',
  'PH','PK','PL','PM','PN','PR','PS','PT','PW','PY','QA','RE','RO','RS','RU','RW',
  'SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS',
  'ST','SV','SX','SY','SZ','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO',
  'TR','TT','TV','TW','TZ','UA','UG','UM','US','UY','UZ','VA','VC','VE','VG','VI',
  'VN','VU','WF','WS','YE','YT','ZA','ZM','ZW',
] as const

export type CountryCode = (typeof COUNTRY_CODES)[number]

const COUNTRY_SET = new Set<string>(COUNTRY_CODES)

export function isValidCountry(code: string): boolean {
  return COUNTRY_SET.has(code.toUpperCase())
}

/**
 * Default invoicing currency per country.
 *
 * A convenience for onboarding only — the user can pick any supported currency.
 * Countries absent from this map fall back to USD, which is the pragmatic
 * default for cross-border invoicing.
 */
export const COUNTRY_DEFAULT_CURRENCY: Record<string, string> = {
  AE: 'AED', AR: 'ARS', AU: 'AUD', BD: 'BDT', BR: 'BRL', CA: 'CAD', CH: 'CHF',
  CL: 'CLP', CN: 'CNY', CO: 'COP', CZ: 'CZK', DK: 'DKK', EG: 'EGP', ET: 'ETB',
  GB: 'GBP', GH: 'GHS', HK: 'HKD', HU: 'HUF', ID: 'IDR', IL: 'ILS', IN: 'INR',
  IQ: 'IQD', IS: 'ISK', JO: 'JOD', JP: 'JPY', KE: 'KES', KR: 'KRW', KW: 'KWD',
  LK: 'LKR', MA: 'MAD', MX: 'MXN', MY: 'MYR', NG: 'NGN', NO: 'NOK', NZ: 'NZD',
  OM: 'OMR', PE: 'PEN', PH: 'PHP', PK: 'PKR', PL: 'PLN', QA: 'QAR', RO: 'RON',
  RS: 'RSD', RU: 'RUB', RW: 'RWF', SA: 'SAR', SE: 'SEK', SG: 'SGD', TH: 'THB',
  TN: 'TND', TR: 'TRY', TW: 'TWD', TZ: 'TZS', UA: 'UAH', UG: 'UGX', US: 'USD',
  UY: 'UYU', VN: 'VND', ZA: 'ZAR', ZM: 'ZMW',
  // Eurozone.
  AT: 'EUR', BE: 'EUR', CY: 'EUR', DE: 'EUR', EE: 'EUR', ES: 'EUR', FI: 'EUR',
  FR: 'EUR', GR: 'EUR', HR: 'EUR', IE: 'EUR', IT: 'EUR', LT: 'EUR', LU: 'EUR',
  LV: 'EUR', MT: 'EUR', NL: 'EUR', PT: 'EUR', SI: 'EUR', SK: 'EUR',
  // West and Central African CFA franc zones.
  BF: 'XOF', BJ: 'XOF', CI: 'XOF', GW: 'XOF', ML: 'XOF', NE: 'XOF', SN: 'XOF',
  TG: 'XOF', CF: 'XAF', CG: 'XAF', CM: 'XAF', GA: 'XAF', GQ: 'XAF', TD: 'XAF',
}

export function defaultCurrencyFor(country: string): string {
  return COUNTRY_DEFAULT_CURRENCY[country.toUpperCase()] ?? 'USD'
}

/**
 * Resolve a country code to a display name in the requested locale.
 *
 * Falls back to the raw code rather than throwing: an unrecognised code should
 * degrade to something readable, not break a page.
 */
export function countryName(code: string, locale = 'en'): string {
  try {
    const display = new Intl.DisplayNames([locale], { type: 'region' })
    return display.of(code.toUpperCase()) ?? code.toUpperCase()
  } catch {
    return code.toUpperCase()
  }
}

/** All operating countries, named for the given locale and sorted for it. */
export function listCountries(locale = 'en'): Array<{ code: string; name: string }> {
  const collator = new Intl.Collator(locale)
  return COUNTRY_CODES.map((code) => ({ code, name: countryName(code, locale) })).sort((a, b) =>
    collator.compare(a.name, b.name),
  )
}
