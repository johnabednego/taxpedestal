/**
 * Language registry.
 *
 * Two things live here:
 *   1. Every language the interface can be shown in, with its script direction.
 *   2. A country -> official language map, so the picker can offer a sensible
 *      default for anyone anywhere.
 *
 * TRANSLATION STATUS IS TRACKED HONESTLY. `coverage` says whether a language is
 * fully translated, partially translated, or listed but not yet done. A locale
 * with no translation file falls back to English PER KEY rather than showing
 * blanks or raw keys, a half-translated screen is usable, a screen full of
 * `invoice.status.overdue` is not.
 *
 * Why not machine-translate the long tail and call it complete: this is a
 * financial product. "Outstanding", "due", "settled" and "void" are terms with
 * specific meanings, and a confident mistranslation on a screen where someone
 * decides whether they have been paid is worse than English they can look up.
 * The infrastructure is ready; adding a language is one file and a registry
 * line.
 */

export type Direction = 'ltr' | 'rtl'

/**
 * Coverage is NOT declared here.
 *
 * An earlier version of this file carried a hand-written `coverage` field, and
 * it was already wrong: Hindi, Russian, Japanese and German were all labelled
 * 'complete' while their catalogues stood at 33%, 32%, 32% and 42%. A fact that
 * can be computed should never be maintained by hand, least of all one the UI
 * shows users to set their expectations.
 *
 * See i18n/index.tsx, which counts translated keys against the English source
 * at render time.
 */

export interface Language {
  /** BCP 47 tag. */
  code: string
  /** Name in the language itself, a picker in English helps nobody. */
  endonym: string
  /** Name in English, for admin and support. */
  english: string
  direction: Direction
}

/**
 * Languages the interface offers.
 *
 * Ordered by number of speakers so the common cases sit near the top of the
 * picker, with the rest sorted alphabetically by endonym at render time.
 */
export const LANGUAGES: Language[] = [
  { code: 'en', endonym: 'English', english: 'English', direction: 'ltr' },
  { code: 'zh', endonym: '中文', english: 'Chinese (Simplified)', direction: 'ltr' },
  { code: 'hi', endonym: 'हिन्दी', english: 'Hindi', direction: 'ltr' },
  { code: 'es', endonym: 'Español', english: 'Spanish', direction: 'ltr' },
  { code: 'fr', endonym: 'Français', english: 'French', direction: 'ltr' },
  { code: 'ar', endonym: 'العربية', english: 'Arabic', direction: 'rtl' },
  { code: 'pt', endonym: 'Português', english: 'Portuguese', direction: 'ltr' },
  { code: 'ru', endonym: 'Русский', english: 'Russian', direction: 'ltr' },
  { code: 'de', endonym: 'Deutsch', english: 'German', direction: 'ltr' },
  { code: 'ja', endonym: '日本語', english: 'Japanese', direction: 'ltr' },
  { code: 'sw', endonym: 'Kiswahili', english: 'Swahili', direction: 'ltr' },
  { code: 'id', endonym: 'Bahasa Indonesia', english: 'Indonesian', direction: 'ltr' },
  { code: 'tr', endonym: 'Türkçe', english: 'Turkish', direction: 'ltr' },
  { code: 'it', endonym: 'Italiano', english: 'Italian', direction: 'ltr' },
  { code: 'nl', endonym: 'Nederlands', english: 'Dutch', direction: 'ltr' },
  { code: 'vi', endonym: 'Tiếng Việt', english: 'Vietnamese', direction: 'ltr' },
  { code: 'ko', endonym: '한국어', english: 'Korean', direction: 'ltr' },
  { code: 'pl', endonym: 'Polski', english: 'Polish', direction: 'ltr' },
  { code: 'uk', endonym: 'Українська', english: 'Ukrainian', direction: 'ltr' },
  { code: 'fa', endonym: 'فارسی', english: 'Persian', direction: 'rtl' },
  { code: 'ur', endonym: 'اردو', english: 'Urdu', direction: 'rtl' },
  { code: 'he', endonym: 'עברית', english: 'Hebrew', direction: 'rtl' },
  { code: 'bn', endonym: 'বাংলা', english: 'Bengali', direction: 'ltr' },
  { code: 'th', endonym: 'ไทย', english: 'Thai', direction: 'ltr' },
  { code: 'ms', endonym: 'Bahasa Melayu', english: 'Malay', direction: 'ltr' },
  { code: 'ta', endonym: 'தமிழ்', english: 'Tamil', direction: 'ltr' },
  { code: 'am', endonym: 'አማርኛ', english: 'Amharic', direction: 'ltr' },
  { code: 'ha', endonym: 'Hausa', english: 'Hausa', direction: 'ltr' },
  { code: 'yo', endonym: 'Yorùbá', english: 'Yoruba', direction: 'ltr' },
  { code: 'ig', endonym: 'Igbo', english: 'Igbo', direction: 'ltr' },
  { code: 'zu', endonym: 'isiZulu', english: 'Zulu', direction: 'ltr' },
  { code: 'af', endonym: 'Afrikaans', english: 'Afrikaans', direction: 'ltr' },
  { code: 'el', endonym: 'Ελληνικά', english: 'Greek', direction: 'ltr' },
  { code: 'cs', endonym: 'Čeština', english: 'Czech', direction: 'ltr' },
  { code: 'ro', endonym: 'Română', english: 'Romanian', direction: 'ltr' },
  { code: 'hu', endonym: 'Magyar', english: 'Hungarian', direction: 'ltr' },
  { code: 'sv', endonym: 'Svenska', english: 'Swedish', direction: 'ltr' },
  { code: 'da', endonym: 'Dansk', english: 'Danish', direction: 'ltr' },
  { code: 'fi', endonym: 'Suomi', english: 'Finnish', direction: 'ltr' },
  { code: 'no', endonym: 'Norsk', english: 'Norwegian', direction: 'ltr' },
  { code: 'bg', endonym: 'Български', english: 'Bulgarian', direction: 'ltr' },
  { code: 'sr', endonym: 'Српски', english: 'Serbian', direction: 'ltr' },
  { code: 'hr', endonym: 'Hrvatski', english: 'Croatian', direction: 'ltr' },
  { code: 'sk', endonym: 'Slovenčina', english: 'Slovak', direction: 'ltr' },
  { code: 'sl', endonym: 'Slovenščina', english: 'Slovenian', direction: 'ltr' },
  { code: 'lt', endonym: 'Lietuvių', english: 'Lithuanian', direction: 'ltr' },
  { code: 'lv', endonym: 'Latviešu', english: 'Latvian', direction: 'ltr' },
  { code: 'et', endonym: 'Eesti', english: 'Estonian', direction: 'ltr' },
  { code: 'ne', endonym: 'नेपाली', english: 'Nepali', direction: 'ltr' },
  { code: 'si', endonym: 'සිංහල', english: 'Sinhala', direction: 'ltr' },
  { code: 'km', endonym: 'ខ្មែរ', english: 'Khmer', direction: 'ltr' },
  { code: 'lo', endonym: 'ລາວ', english: 'Lao', direction: 'ltr' },
  { code: 'my', endonym: 'မြန်မာ', english: 'Burmese', direction: 'ltr' },
  { code: 'ka', endonym: 'ქართული', english: 'Georgian', direction: 'ltr' },
  { code: 'hy', endonym: 'Հայերեն', english: 'Armenian', direction: 'ltr' },
  { code: 'az', endonym: 'Azərbaycan', english: 'Azerbaijani', direction: 'ltr' },
  { code: 'kk', endonym: 'Қазақша', english: 'Kazakh', direction: 'ltr' },
  { code: 'uz', endonym: "O'zbekcha", english: 'Uzbek', direction: 'ltr' },
  { code: 'mn', endonym: 'Монгол', english: 'Mongolian', direction: 'ltr' },
  { code: 'is', endonym: 'Íslenska', english: 'Icelandic', direction: 'ltr' },
  { code: 'sq', endonym: 'Shqip', english: 'Albanian', direction: 'ltr' },
  { code: 'mk', endonym: 'Македонски', english: 'Macedonian', direction: 'ltr' },
  { code: 'mt', endonym: 'Malti', english: 'Maltese', direction: 'ltr' },
  { code: 'ga', endonym: 'Gaeilge', english: 'Irish', direction: 'ltr' },
  { code: 'mg', endonym: 'Malagasy', english: 'Malagasy', direction: 'ltr' },
  { code: 'so', endonym: 'Soomaali', english: 'Somali', direction: 'ltr' },
  { code: 'rw', endonym: 'Kinyarwanda', english: 'Kinyarwanda', direction: 'ltr' },
  { code: 'ps', endonym: 'پښتو', english: 'Pashto', direction: 'rtl' },
  { code: 'ku', endonym: 'Kurdî', english: 'Kurdish', direction: 'rtl' },
  { code: 'dv', endonym: 'ދިވެހި', english: 'Dhivehi', direction: 'rtl' },
]

const BY_CODE = new Map(LANGUAGES.map((language) => [language.code, language]))

export function findLanguage(code: string): Language | undefined {
  return BY_CODE.get(code.split('-')[0]?.toLowerCase() ?? code)
}

export function directionFor(code: string): Direction {
  return findLanguage(code)?.direction ?? 'ltr'
}

export const RTL_LANGUAGES = new Set(
  LANGUAGES.filter((language) => language.direction === 'rtl').map((l) => l.code),
)

/**
 * Country -> its principal official language.
 *
 * Used to preselect a sensible interface language, and to offer "one language
 * per country" in the picker as a starting point. Where a country has several
 * official languages the most widely used in commerce is chosen, because this
 * only sets a DEFAULT the user can immediately change.
 */
export const COUNTRY_LANGUAGE: Record<string, string> = {
  AD: 'es', AE: 'ar', AF: 'fa', AG: 'en', AI: 'en', AL: 'sq', AM: 'hy', AO: 'pt',
  AR: 'es', AS: 'en', AT: 'de', AU: 'en', AW: 'nl', AZ: 'az',
  BA: 'sr', BB: 'en', BD: 'bn', BE: 'nl', BF: 'fr', BG: 'bg', BH: 'ar', BI: 'fr',
  BJ: 'fr', BM: 'en', BN: 'ms', BO: 'es', BR: 'pt', BS: 'en', BT: 'ne', BW: 'en',
  BY: 'ru', BZ: 'en',
  CA: 'en', CD: 'fr', CF: 'fr', CG: 'fr', CH: 'de', CI: 'fr', CL: 'es', CM: 'fr',
  CN: 'zh', CO: 'es', CR: 'es', CU: 'es', CV: 'pt', CY: 'el', CZ: 'cs',
  DE: 'de', DJ: 'fr', DK: 'da', DM: 'en', DO: 'es', DZ: 'ar',
  EC: 'es', EE: 'et', EG: 'ar', ER: 'ar', ES: 'es', ET: 'am',
  FI: 'fi', FJ: 'en', FM: 'en', FO: 'da', FR: 'fr',
  GA: 'fr', GB: 'en', GD: 'en', GE: 'ka', GH: 'en', GI: 'en', GL: 'da', GM: 'en',
  GN: 'fr', GQ: 'es', GR: 'el', GT: 'es', GW: 'pt', GY: 'en',
  HK: 'zh', HN: 'es', HR: 'hr', HT: 'fr', HU: 'hu',
  ID: 'id', IE: 'en', IL: 'he', IN: 'hi', IQ: 'ar', IR: 'fa', IS: 'is', IT: 'it',
  JM: 'en', JO: 'ar', JP: 'ja',
  KE: 'sw', KG: 'ru', KH: 'km', KI: 'en', KM: 'ar', KN: 'en', KP: 'ko', KR: 'ko',
  KW: 'ar', KY: 'en', KZ: 'kk',
  LA: 'lo', LB: 'ar', LC: 'en', LI: 'de', LK: 'si', LR: 'en', LS: 'en', LT: 'lt',
  LU: 'fr', LV: 'lv', LY: 'ar',
  MA: 'ar', MC: 'fr', MD: 'ro', ME: 'sr', MG: 'mg', MH: 'en', MK: 'mk', ML: 'fr',
  MM: 'my', MN: 'mn', MO: 'zh', MR: 'ar', MT: 'mt', MU: 'en', MV: 'dv', MW: 'en',
  MX: 'es', MY: 'ms', MZ: 'pt',
  NA: 'en', NE: 'fr', NG: 'en', NI: 'es', NL: 'nl', NO: 'no', NP: 'ne', NZ: 'en',
  OM: 'ar',
  PA: 'es', PE: 'es', PG: 'en', PH: 'en', PK: 'ur', PL: 'pl', PR: 'es', PS: 'ar',
  PT: 'pt', PY: 'es',
  QA: 'ar',
  RO: 'ro', RS: 'sr', RU: 'ru', RW: 'rw',
  SA: 'ar', SB: 'en', SC: 'fr', SD: 'ar', SE: 'sv', SG: 'en', SI: 'sl', SK: 'sk',
  SL: 'en', SM: 'it', SN: 'fr', SO: 'so', SR: 'nl', SS: 'en', ST: 'pt', SV: 'es',
  SY: 'ar', SZ: 'en',
  TD: 'fr', TG: 'fr', TH: 'th', TJ: 'ru', TL: 'pt', TM: 'ru', TN: 'ar', TO: 'en',
  TR: 'tr', TT: 'en', TW: 'zh', TZ: 'sw',
  UA: 'uk', UG: 'en', US: 'en', UY: 'es', UZ: 'uz',
  VA: 'it', VC: 'en', VE: 'es', VG: 'en', VI: 'en', VN: 'vi', VU: 'fr',
  WS: 'en',
  YE: 'ar',
  ZA: 'en', ZM: 'en', ZW: 'en',
}

export function languageForCountry(country: string): string {
  return COUNTRY_LANGUAGE[country.toUpperCase()] ?? 'en'
}

/**
 * Best interface language for this visitor.
 *
 * Order: an explicit saved choice, then the browser's preferences in order,
 * then English. The browser list is walked rather than only its first entry,
 * because someone whose first preference we do not have may well have a second
 * that we do.
 */
export function detectLanguage(saved?: string | null): string {
  if (saved && BY_CODE.has(saved)) return saved

  if (typeof navigator !== 'undefined') {
    for (const preference of navigator.languages ?? [navigator.language]) {
      const base = preference?.split('-')[0]?.toLowerCase()
      if (base && BY_CODE.has(base)) return base
    }
  }

  return 'en'
}
