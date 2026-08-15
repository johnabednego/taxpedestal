import { FormEvent, useState } from 'react'
import { BRAND } from '../brand'
import { useI18n, type TranslationKey } from '../i18n'
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { Logo } from '../components/Logo'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { ApiError } from '../lib/api'
import { useAuth } from '../lib/auth'
import { Button, ErrorNotice, Input, Select } from '../components/ui'
import { CountrySelect } from '../components/CountrySelect'

function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
  footer: React.ReactNode
}) {
  const { t } = useI18n()
  return (
    <div className="flex min-h-screen">
      {/* Form side */}
      <div className="relative flex w-full flex-col justify-center px-6 py-12 lg:w-1/2 lg:px-16">
        <div className="absolute end-6 top-6">
          <LanguageSwitcher compact />
        </div>
        <div className="mx-auto w-full max-w-sm">
          <Link to="/" className="mb-8 flex items-center gap-2">
            <Logo size={32} />
            <span className="font-display text-lg font-bold tracking-tightest">{BRAND.name}</span>
          </Link>

          <h1 className="text-2xl font-bold text-ink-900">{title}</h1>
          <p className="mt-1.5 text-sm text-ink-500">{subtitle}</p>

          <div className="mt-8">{children}</div>
          <div className="mt-6 text-sm text-ink-500">{footer}</div>
        </div>
      </div>

      {/* Editorial side. Hidden on mobile, decoration must never cost a
          keystroke on a phone. */}
      <div className="hidden bg-ink-900 lg:flex lg:w-1/2 lg:flex-col lg:justify-center lg:px-16">
        <blockquote className="max-w-md">
          <p className="font-display text-3xl font-bold leading-tight tracking-tightest text-white">
            {t('auth.quote')}
          </p>
          <footer className="mt-6 text-sm text-ink-400">
            {t('auth.quoteFooter', { count: 53 })}
          </footer>
        </blockquote>

        <div className="mt-12 grid grid-cols-3 gap-6 border-t border-ink-700 pt-8">
          {([
            ['53', 'auth.statJurisdictions'],
            ['3', 'auth.statRails'],
            ['0', 'auth.statDoubleCharges'],
          ] as Array<[string, TranslationKey]>).map(([value, label]) => (
            <div key={label}>
              <p className="money text-2xl font-bold text-cobalt-400">{value}</p>
              <p className="mt-0.5 text-xs text-ink-400">{t(label)}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function Login() {
  const { login, user, loading } = useAuth()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  if (!loading && user) return <Navigate to="/app" replace />

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    setFields({})
    try {
      await login(email, password)
      navigate('/app')
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
        setFields(err.fieldErrors)
      } else {
        setError(t('auth.serverUnreachable'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout
      title={t('auth.welcomeBack')}
      subtitle={t('auth.signInSubtitle')}
      footer={
        <>
          {t('auth.noAccount')}{' '}
          <Link to="/register" className="font-medium text-cobalt hover:underline">
            {t('auth.signUp')}
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {error && <ErrorNotice message={error} />}

        <Input
          label={t('auth.email')}
          type="email"
          autoComplete="email"
          required
          value={email}
          error={fields.email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
        />
        <div>
          <Input
            label={t('auth.password')}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            error={fields.password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Link
            to="/forgot-password"
            className="mt-1 inline-block text-xs text-cobalt hover:underline"
          >
            {t('auth.forgotPassword')}
          </Link>
        </div>


        <Button type="submit" className="w-full" loading={submitting} size="lg">
          {t('auth.signIn')}
        </Button>

        <p className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-500">
          {t('auth.demoAccount')} <span className="money">demo@taxpedestal.app</span> /{' '}
          <span className="money">taxpedestal-demo-2026</span>
        </p>
      </form>
    </AuthLayout>
  )
}

export function Register() {
  const { register, user, loading, meta } = useAuth()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [form, setForm] = useState({
    fullName: '',
    email: '',
    password: '',
    organisationName: '',
    country: 'GH',
    baseCurrency: 'GHS',
  })
  const [error, setError] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  if (!loading && user) return <Navigate to="/app" replace />

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }))

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    setFields({})
    try {
      await register(form)
      navigate('/app')
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
        setFields(err.fieldErrors)
      } else {
        setError(t('auth.serverUnreachable'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  // Fallback only, used for the split second before /meta responds. Spread
  // across regions so the picker never implies a home market.
  const currencies = meta?.currencies ?? [
    { code: 'USD', exponent: 2, symbol: '$', name: 'US Dollar' },
    { code: 'EUR', exponent: 2, symbol: '€', name: 'Euro' },
    { code: 'GBP', exponent: 2, symbol: '£', name: 'Pound Sterling' },
    { code: 'INR', exponent: 2, symbol: '₹', name: 'Indian Rupee' },
    { code: 'GHS', exponent: 2, symbol: 'GH₵', name: 'Ghana Cedi' },
  ]

  return (
    <AuthLayout
      title={t('auth.createWorkspace')}
      subtitle={t('auth.createSubtitle')}
      footer={
        <>
          {t('auth.hasAccount')}{' '}
          <Link to="/login" className="font-medium text-cobalt hover:underline">
            {t('auth.signIn')}
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {error && <ErrorNotice message={error} />}

        <Input
          label={t('auth.fullName')}
          required
          autoComplete="name"
          value={form.fullName}
          error={fields.fullName}
          onChange={(e) => set('fullName')(e.target.value)}
          placeholder="Ama Mensah"
        />
        <Input
          label={t('auth.workEmail')}
          type="email"
          required
          autoComplete="email"
          value={form.email}
          error={fields.email}
          onChange={(e) => set('email')(e.target.value)}
          placeholder="you@company.com"
        />
        <Input
          label={t('auth.password')}
          type="password"
          required
          autoComplete="new-password"
          value={form.password}
          error={fields.password}
          hint={t('auth.passwordHint')}
          onChange={(e) => set('password')(e.target.value)}
        />
        <Input
          label={t('auth.businessName')}
          required
          value={form.organisationName}
          error={fields.organisationName}
          onChange={(e) => set('organisationName')(e.target.value)}
          placeholder="Northwind Studio"
        />

        <div className="grid grid-cols-2 gap-3">
          <CountrySelect
            value={form.country}
            error={fields.country}
            onChange={(code) => {
              set('country')(code)
              // Suggest the local currency, which the user can still change.
              const match = meta?.countries.find((c) => c.code === code)
              if (match) set('baseCurrency')(match.defaultCurrency)
            }}
          />
          <Select
            label={t('auth.currency')}
            value={form.baseCurrency}
            error={fields.baseCurrency}
            onChange={(e) => set('baseCurrency')(e.target.value)}
          >
            {currencies.map((currency) => (
              <option key={currency.code} value={currency.code}>
                {currency.code}, {currency.name}
              </option>
            ))}
          </Select>
        </div>

        <Button
          type="submit"
          className="w-full"
          loading={submitting}
          size="lg"
          icon={<ArrowRight className="h-4 w-4" />}
        >
          {t('site.createWorkspace')}
        </Button>
      </form>
    </AuthLayout>
  )
}
