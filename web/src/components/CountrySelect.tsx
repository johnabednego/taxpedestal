import { Select } from './ui'
import { useAuth } from '../lib/auth'
import { useI18n } from '../i18n'
import { countryName, flagFor, type CountryOption } from '../lib/countries'

/**
 * Country picker.
 *
 * Lists EVERY country, never only the ones with automatic tax. An earlier
 * version fed this from the tax registry, which meant a business in China,
 * Iraq or Israel could not complete registration at all, the option simply
 * was not there.
 *
 * Countries without automatic tax are still selectable and are labelled, so the
 * user learns the capability boundary at the moment it matters instead of
 * discovering a zero-tax invoice later.
 */
export function CountrySelect({
  label,
  value,
  onChange,
  hint,
  error,
  disabled,
  required,
  showTaxHint = true,
}: {
  label?: string
  value: string
  onChange: (code: string) => void
  hint?: string
  error?: string
  disabled?: boolean
  required?: boolean
  showTaxHint?: boolean
}) {
  const { meta } = useAuth()
  const { t } = useI18n()

  // Fallback covers the moment before /meta resolves, and an offline client.
  const countries: CountryOption[] =
    meta?.countries ??
    ['US', 'GB', 'DE', 'FR', 'ES', 'CN', 'IN', 'NG', 'GH', 'IL', 'IQ', 'BR', 'ZA'].map((code) => ({
      code,
      name: countryName(code),
      defaultCurrency: 'USD',
      hasAutomaticTax: false,
    }))

  const selected = countries.find((c) => c.code === value)

  const taxHint =
    showTaxHint && selected
      ? selected.hasAutomaticTax
        ? t('country.automaticTax', { country: selected.name })
        : t('country.manualTax', { country: selected.name })
      : undefined

  return (
    <Select
      label={label ?? t('auth.country')}
      value={value}
      error={error}
      disabled={disabled}
      required={required}
      hint={hint ?? taxHint}
      onChange={(e) => onChange(e.target.value)}
    >
      {countries.map((country) => (
        <option key={country.code} value={country.code}>
          {flagFor(country.code)} {country.name}
          {/* Parenthesised, not comma-separated: "Afghanistan, manual tax"
              reads as part of the country's name. */}
          {country.hasAutomaticTax ? '' : ` (${t('country.manualSuffix')})`}
        </option>
      ))}
    </Select>
  )
}
