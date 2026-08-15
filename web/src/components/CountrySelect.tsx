import { Select } from './ui'
import { BRAND } from '../brand'
import { useAuth } from '../lib/auth'
import { countryName, flagFor, type CountryOption } from '../lib/countries'

/**
 * Country picker.
 *
 * Lists EVERY country, never only the ones with automatic tax. An earlier
 * version fed this from the tax registry, which meant a business in China,
 * Iraq or Israel could not complete registration at all — the option simply
 * was not there.
 *
 * Countries without automatic tax are still selectable and are labelled, so the
 * user learns the capability boundary at the moment it matters instead of
 * discovering a zero-tax invoice later.
 */
export function CountrySelect({
  label = 'Country',
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
        ? `Tax is calculated automatically for ${selected.name}.`
        : `${BRAND.name} has no built-in tax rules for ${selected.name} yet. You can define your own in Settings.`
      : undefined

  return (
    <Select
      label={label}
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
          {country.hasAutomaticTax ? '' : ' — manual tax'}
        </option>
      ))}
    </Select>
  )
}
