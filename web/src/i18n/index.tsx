import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { BRAND } from '../brand'
import { COUNTRY_LANGUAGE, RTL_LANGUAGES, findLanguage } from './languages'
import { CATALOGS, type TranslationKey } from './locales'

/**
 * Internationalisation.
 *
 * ============================================================================
 * DESIGN DECISIONS
 * ============================================================================
 * 1. PER-KEY FALLBACK, not per-language. A locale with 80% coverage renders a
 *    complete interface with the remaining fifth in English, rather than
 *    showing raw keys or refusing to load. This is what makes it safe to add a
 *    language incrementally instead of needing a full catalogue before launch.
 *
 * 2. DIRECTION IS DERIVED, not configured. Arabic, Hebrew, Persian and Urdu set
 *    `dir="rtl"` on the document element, which flips the entire layout through
 *    CSS logical properties. Retrofitting RTL by adding conditional classes to
 *    each component is where most attempts collapse; setting the document
 *    direction once and using logical properties costs almost nothing.
 *
 * 3. NUMBERS AND DATES GO THROUGH Intl. Translating labels but formatting
 *    "1,234.56" the American way in a German interface is a half-measure that
 *    reads as broken to the people it is meant to serve.
 *
 * 4. THE PREFERENCE IS THE USER'S. Detected from the browser on first visit,
 *    then persisted. It is never inferred from their country — plenty of people
 *    live somewhere whose majority language is not theirs.
 */

export interface LanguageOption {
  code: string
  /** Name in the language itself — a French speaker looks for "Français". */
  endonym: string
  /** Name in the current interface language, for context. */
  exonym: string
  rtl: boolean
  /** Share of keys translated. Surfaced so coverage is honest. */
  coverage: number
}

const STORAGE_KEY = 'taxpedestal.locale'
/**
 * Records that the CURRENT locale was chosen by a person, not detected.
 *
 * The distinction decides who wins when a visitor picks a language on the
 * marketing site and then signs into an account saved with a different one.
 * A deliberate choice made minutes ago should beat a preference saved months
 * ago — and should update the account, not be overwritten by it.
 */
const EXPLICIT_KEY = 'taxpedestal.localeExplicit'

interface I18nState {
  locale: string
  dir: 'ltr' | 'rtl'
  setLocale: (code: string, explicit?: boolean) => void
  /** True when the current locale was chosen rather than detected. */
  isExplicit: () => boolean
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string
  languages: LanguageOption[]
  /** Best-guess interface language for a country, for onboarding defaults. */
  languageForCountry: (country: string) => string
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string
  formatDate: (value: string | Date, style?: 'short' | 'medium' | 'long') => string
  formatRelativeDays: (value: string | Date) => string
}

const I18nContext = createContext<I18nState | null>(null)

export function useI18n(): I18nState {
  const context = useContext(I18nContext)
  if (!context) throw new Error('useI18n must be used inside I18nProvider')
  return context
}

/** Convenience for the common case. */
export function useT(): I18nState['t'] {
  return useI18n().t
}

function detectLocale(): string {
  if (typeof window === 'undefined') return 'en'

  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored && CATALOGS[stored]) return stored

  // Try the full tag first (pt-BR), then the primary subtag (pt).
  for (const candidate of navigator.languages ?? [navigator.language]) {
    if (!candidate) continue
    if (CATALOGS[candidate]) return candidate
    const primary = candidate.split('-')[0]?.toLowerCase()
    if (primary && CATALOGS[primary]) return primary
  }
  return 'en'
}

/**
 * Locale-aware number rendering for values interpolated into translated text.
 *
 * Standalone rather than a hook because `t` needs it during render and the
 * memoised `formatNumber` is defined further down the provider.
 */
function formatNumberIn(locale: string, value: number): string {
  try {
    return new Intl.NumberFormat(locale).format(value)
  } catch {
    return String(value)
  }
}

function displayName(code: string, inLocale: string): string {
  try {
    return new Intl.DisplayNames([inLocale], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

const ENGLISH = CATALOGS.en!
const TOTAL_KEYS = Object.keys(ENGLISH).length

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<string>(detectLocale)

  const dir: 'ltr' | 'rtl' = RTL_LANGUAGES.has(locale.split('-')[0] ?? '') ? 'rtl' : 'ltr'

  /**
   * Direction and language are set on <html>, not on a wrapper div.
   *
   * `dir` on the root is what makes CSS logical properties, text selection,
   * caret movement and native form controls behave correctly. `lang` drives
   * hyphenation, spellcheck and screen-reader pronunciation.
   */
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('lang', locale)
    root.setAttribute('dir', dir)
    return () => {
      root.setAttribute('dir', 'ltr')
    }
  }, [locale, dir])

  /**
   * Change the interface language.
   *
   * `explicit` defaults to true because almost every caller is a person
   * clicking the switcher. Adopting a saved account preference passes false,
   * so that adopting does not itself count as a new decision.
   */
  const setLocale = useCallback((code: string, explicit = true) => {
    setLocaleState(code)
    localStorage.setItem(STORAGE_KEY, code)
    if (explicit) localStorage.setItem(EXPLICIT_KEY, 'true')
  }, [])

  /** Did the person choose this language themselves? */
  const isExplicit = useCallback(
    () => localStorage.getItem(EXPLICIT_KEY) === 'true',
    [],
  )

  const t = useCallback<I18nState['t']>(
    (key, vars) => {
      const catalog = CATALOGS[locale] ?? CATALOGS[locale.split('-')[0] ?? 'en'] ?? ENGLISH

      /**
       * Plural selection.
       *
       * When a `count` is supplied, the catalogue may carry one entry per CLDR
       * plural category (`key_one`, `key_other`, and for Arabic also `_zero`,
       * `_two`, `_few`, `_many`). Intl.PluralRules picks the category for the
       * active locale, so the rule lives in the platform rather than in a
       * hand-written `count === 1 ? … : …` that is wrong outside English.
       *
       * Falls back through: exact category -> `_other` -> the bare key. That
       * ordering is what lets a catalogue translate only `_other` and still
       * render, instead of showing a raw key.
       */
      const resolve = (candidate: string): string | undefined =>
        (catalog as Record<string, string | undefined>)[candidate] ??
        (ENGLISH as Record<string, string | undefined>)[candidate]

      let text: string | undefined
      if (vars && typeof vars.count === 'number') {
        let category = 'other'
        try {
          category = new Intl.PluralRules(locale).select(vars.count)
        } catch {
          // Unknown locale tag; 'other' is the safe default.
        }
        text = resolve(`${key}_${category}`) ?? resolve(`${key}_other`)
      }
      // Per-key fallback: a missing translation shows English, never the key.
      text ??= resolve(key) ?? key

      // {brand} is always available without the caller passing it. Catalogues
      // therefore never hardcode the product name, which is what makes a
      // rename a one-line change instead of fifteen file edits.
      text = text.replaceAll('{brand}', BRAND.name)

      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          // Numbers are localised too: an Arabic or Hindi interface showing
          // "1,234" in Latin digits is the same half-measure as translating
          // labels but not formatting.
          const rendered =
            typeof value === 'number' ? formatNumberIn(locale, value) : String(value)
          text = text.replaceAll(`{${name}}`, rendered)
        }
      }
      return text
    },
    [locale],
  )

  /**
   * Offered languages.
   *
   * Only those with a catalogue are listed. The registry in languages.ts knows
   * of 70, but listing 55 at 0% would be a worse product than listing 15
   * honestly — per-key fallback means an untranslated language renders entirely
   * in English, which is not a language choice, it is a broken one.
   *
   * Coverage is COUNTED here rather than declared anywhere, so the figure the
   * user sees cannot drift from the catalogue it describes.
   */
  const languages = useMemo<LanguageOption[]>(
    () =>
      Object.keys(CATALOGS)
        .map((code) => {
          const catalog = CATALOGS[code]!
          const translated = Object.keys(catalog).filter(
            (key) => catalog[key as TranslationKey],
          ).length
          const registered = findLanguage(code)
          return {
            code,
            endonym: registered?.endonym ?? displayName(code, code),
            exonym: registered?.english ?? displayName(code, locale),
            rtl: RTL_LANGUAGES.has(code.split('-')[0] ?? ''),
            coverage: Math.round((translated / TOTAL_KEYS) * 100),
          }
        })
        .sort((a, b) => b.coverage - a.coverage || a.endonym.localeCompare(b.endonym, locale)),
    [locale],
  )

  const formatNumber = useCallback<I18nState['formatNumber']>(
    (value, options) => {
      try {
        return new Intl.NumberFormat(locale, options).format(value)
      } catch {
        return String(value)
      }
    },
    [locale],
  )

  const formatDate = useCallback<I18nState['formatDate']>(
    (value, style = 'medium') => {
      try {
        return new Intl.DateTimeFormat(locale, { dateStyle: style }).format(new Date(value))
      } catch {
        return String(value)
      }
    },
    [locale],
  )

  /** "in 3 days" / "il y a 3 jours" — Intl handles the plural rules. */
  const formatRelativeDays = useCallback<I18nState['formatRelativeDays']>(
    (value) => {
      const days = Math.round((new Date(value).getTime() - Date.now()) / 86_400_000)
      try {
        return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(days, 'day')
      } catch {
        return `${days} days`
      }
    },
    [locale],
  )

  /**
   * Maps a country to a language we can actually render.
   *
   * The registry covers 206 countries, but falls back to English when the
   * mapped language has no catalogue — offering someone Amharic and then
   * showing them English is worse than showing English from the start.
   */
  const languageForCountry = useCallback((country: string): string => {
    const mapped = COUNTRY_LANGUAGE[country.toUpperCase()]
    if (mapped && CATALOGS[mapped]) return mapped
    return 'en'
  }, [])

  const value = useMemo<I18nState>(
    () => ({
      locale,
      dir,
      setLocale,
      isExplicit,
      t,
      languages,
      languageForCountry,
      formatNumber,
      formatDate,
      formatRelativeDays,
    }),
    [
      locale,
      dir,
      setLocale,
      isExplicit,
      t,
      languages,
      languageForCountry,
      formatNumber,
      formatDate,
      formatRelativeDays,
    ],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export type { TranslationKey }
