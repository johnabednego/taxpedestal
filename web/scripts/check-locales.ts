/**
 * Catalogue integrity check.
 *
 * Run with: npm run check:locales
 *
 * Verifies that every catalogue uses only keys that exist in English (a typo
 * in a key would silently render the English fallback forever) and reports
 * coverage per language so gaps are visible rather than assumed.
 */
import { CATALOGS } from '../src/i18n/locales'

const en = CATALOGS.en!
const englishKeys = new Set(Object.keys(en))
let failed = false

console.log(`English keys: ${englishKeys.size}\n`)
console.log('LANGUAGE  COVERAGE  MISSING  UNKNOWN KEYS')
console.log('─'.repeat(52))

for (const [code, catalog] of Object.entries(CATALOGS)) {
  const keys = Object.keys(catalog)
  const unknown = keys.filter((k) => !englishKeys.has(k))
  const translated = keys.filter((k) => englishKeys.has(k)).length
  const coverage = Math.round((translated / englishKeys.size) * 100)

  if (unknown.length > 0) {
    failed = true
    console.log(`${code.padEnd(9)} ${String(coverage).padStart(7)}% ${String(englishKeys.size - translated).padStart(8)}  ${unknown.join(', ')}`)
  } else {
    console.log(`${code.padEnd(9)} ${String(coverage).padStart(7)}% ${String(englishKeys.size - translated).padStart(8)}`)
  }
}

// Placeholders must match, or a variable silently disappears from a sentence.
console.log('')
for (const [code, catalog] of Object.entries(CATALOGS)) {
  for (const [key, value] of Object.entries(catalog)) {
    const source = en[key as keyof typeof en]
    if (!source || typeof value !== 'string') continue
    const expected = (source.match(/\{(\w+)\}/g) ?? []).sort().join(',')
    const actual = (value.match(/\{(\w+)\}/g) ?? []).sort().join(',')
    if (expected !== actual) {
      failed = true
      console.log(`PLACEHOLDER MISMATCH  ${code} ${key}: expected ${expected || '(none)'}, got ${actual || '(none)'}`)
    }
  }
}

console.log(failed ? '\nFAILED' : '\nAll catalogues valid.')
process.exit(failed ? 1 : 0)
