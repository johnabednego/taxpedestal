/**
 * Catalogue integrity check.
 *
 * Run with: npm run check:locales
 *
 * Verifies that every catalogue uses only keys that exist in English (a typo
 * in a key would silently render the English fallback forever) and reports
 * coverage per language so gaps are visible rather than assumed.
 *
 * ============================================================================
 * PLURALS
 * ============================================================================
 * Keys ending in a CLDR plural category (`_one`, `_other`, …) form a family.
 * Two rules follow from that, and both matter:
 *
 * 1. A language may use categories English does not have. Arabic distinguishes
 *    six; English has two. `dash.drafts_few` is therefore legitimate even
 *    though no such English key exists, it is validated against the FAMILY
 *    (`dash.drafts_*`), so a typo in the base is still caught.
 *
 * 2. Coverage is counted per family, not per key. Otherwise Arabic supplying
 *    six correct forms where English has two would score 300% on that family,
 *    and a language that supplied only `_other` would look complete.
 */
import { CATALOGS } from '../src/i18n/locales'

const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const
const PLURAL_SUFFIX = new RegExp(`_(${PLURAL_CATEGORIES.join('|')})$`)

/** `dash.drafts_one` -> `dash.drafts`; a non-plural key is returned unchanged. */
const familyOf = (key: string): string => key.replace(PLURAL_SUFFIX, '')

const en = CATALOGS.en!
const englishKeys = new Set(Object.keys(en))
/** The unit of coverage: one entry per plural family, one per ordinary key. */
const englishFamilies = new Set([...englishKeys].map(familyOf))

let failed = false

console.log(`English keys: ${englishKeys.size} (${englishFamilies.size} families)\n`)
console.log('LANGUAGE  COVERAGE  MISSING  UNKNOWN KEYS')
console.log('─'.repeat(52))

for (const [code, catalog] of Object.entries(CATALOGS)) {
  const keys = Object.keys(catalog)
  const unknown = keys.filter((k) => !englishFamilies.has(familyOf(k)))
  const covered = new Set(
    keys.filter((k) => englishFamilies.has(familyOf(k))).map(familyOf),
  )
  const coverage = Math.round((covered.size / englishFamilies.size) * 100)
  const missing = englishFamilies.size - covered.size

  const row = `${code.padEnd(9)} ${String(coverage).padStart(7)}% ${String(missing).padStart(8)}`
  if (unknown.length > 0) {
    failed = true
    console.log(`${row}  ${unknown.join(', ')}`)
  } else {
    console.log(row)
  }
}

/*
 * Placeholders must match, or a variable silently disappears from a sentence.
 *
 * `{count}` is exempt inside a plural family: several languages name small
 * numbers as words rather than digits. Arabic's "one" form reads "one open
 * invoice", not "1 open invoice", so requiring the digit there would force a
 * grammatically wrong translation. Every other placeholder is still mandatory,
 * because dropping {name} or {date} loses information rather than style.
 */
console.log('')
for (const [code, catalog] of Object.entries(CATALOGS)) {
  for (const [key, value] of Object.entries(catalog)) {
    if (typeof value !== 'string') continue

    const isPlural = PLURAL_SUFFIX.test(key)
    const source =
      (en as Record<string, string | undefined>)[key] ??
      // Fall back to any English member of the same family, so `_few` is
      // checked against `_other` rather than skipped entirely.
      (isPlural
        ? PLURAL_CATEGORIES.map(
            (c) => (en as Record<string, string | undefined>)[`${familyOf(key)}_${c}`],
          ).find(Boolean)
        : undefined)
    if (!source) continue

    const placeholders = (text: string) =>
      (text.match(/\{(\w+)\}/g) ?? []).filter((p) => !(isPlural && p === '{count}')).sort()

    const expected = placeholders(source).join(',')
    const actual = placeholders(value).join(',')
    if (expected !== actual) {
      failed = true
      console.log(
        `PLACEHOLDER MISMATCH  ${code} ${key}: expected ${expected || '(none)'}, got ${actual || '(none)'}`,
      )
    }
  }
}

console.log(failed ? '\nFAILED' : '\nAll catalogues valid.')
process.exit(failed ? 1 : 0)
