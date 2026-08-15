import { FormEvent, useEffect, useState } from 'react'
import { BRAND } from '../brand'
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { Logo } from '../components/Logo'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { ApiError, api, setAccessToken } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useI18n } from '../i18n'
import { Button, Card, ErrorNotice, Input } from '../components/ui'

/**
 * Pages reached from links in transactional email.
 *
 * Every email TaxPedestal sends points at one of these routes. They were missing
 * in an earlier build, which meant verification, password reset and team
 * invitations all bounced to the landing page — the emails worked perfectly and
 * the journeys were dead ends.
 */

function Shell({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-ink-50 px-4 py-12">
      <div className="absolute end-4 top-4">
        <LanguageSwitcher compact />
      </div>
      <div className="w-full max-w-md">
        <Link to="/" className="mb-6 flex items-center justify-center gap-2">
          <Logo size={32} />
          <span className="font-display text-lg font-bold tracking-tightest">{BRAND.name}</span>
        </Link>

        <Card>
          <h1 className="text-xl font-bold text-ink-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-ink-500">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </Card>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Email verification                                                          */
/* -------------------------------------------------------------------------- */

export function VerifyEmail() {
  const { t } = useI18n()
  const [params] = useSearchParams()
  const token = params.get('token')
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!token) {
      setState('failed')
      setMessage('That link is missing its verification code.')
      return
    }

    void api('/api/v1/auth/verify-email', {
      method: 'POST',
      anonymous: true,
      body: { token },
    })
      .then(() => setState('done'))
      .catch((err) => {
        setState('failed')
        setMessage(
          err instanceof ApiError ? err.message : 'We could not verify that link.',
        )
      })
  }, [token])

  return (
    <Shell title={t('flow.confirmingEmail')}>
      {state === 'working' && (
        <div className="flex items-center gap-2 text-sm text-ink-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('flow.checkingLink')}
        </div>
      )}

      {state === 'done' && (
        <div>
          <div className="flex items-center gap-2 text-jade">
            <CheckCircle2 className="h-5 w-5" />
            <p className="text-sm font-medium">{t('flow.emailConfirmed')}</p>
          </div>
          <Link to="/app">
            <Button className="mt-5 w-full">{t('flow.goToDashboard')}</Button>
          </Link>
        </div>
      )}

      {state === 'failed' && (
        <div>
          <div className="flex items-start gap-2 text-rose">
            <XCircle className="mt-0.5 h-5 w-5 shrink-0" />
            <p className="text-sm">{message}</p>
          </div>
          <Link to="/login">
            <Button variant="secondary" className="mt-5 w-full">
              {t('flow.backToSignIn')}
            </Button>
          </Link>
        </div>
      )}
    </Shell>
  )
}

/* -------------------------------------------------------------------------- */
/* Forgot password                                                             */
/* -------------------------------------------------------------------------- */

export function ForgotPassword() {
  const { t } = useI18n()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      await api('/api/v1/auth/forgot-password', {
        method: 'POST',
        anonymous: true,
        body: { email },
      })
      setSent(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the reset link')
    } finally {
      setSubmitting(false)
    }
  }

  if (sent) {
    return (
      <Shell title={t('flow.checkEmail')}>
        {/* Deliberately the same message whether or not the account exists —
            confirming it would turn this into a user-enumeration oracle. */}
        <p className="text-sm text-ink-600">{t('flow.resetSentTo', { email })}</p>
        <Link to="/login">
          <Button variant="secondary" className="mt-5 w-full">
            {t('flow.backToSignIn')}
          </Button>
        </Link>
      </Shell>
    )
  }

  return (
    <Shell title={t('flow.forgotTitle')} subtitle={t('flow.forgotSubtitle')}>
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorNotice message={error} />}
        <Input
          label={t('auth.email')}
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
        />
        <Button type="submit" className="w-full" loading={submitting}>
          {t('flow.sendLink')}
        </Button>
        <Link to="/login" className="block text-center text-sm text-cobalt hover:underline">
          {t('flow.backToSignIn')}
        </Link>
      </form>
    </Shell>
  )
}

/* -------------------------------------------------------------------------- */
/* Reset password                                                              */
/* -------------------------------------------------------------------------- */

export function ResetPassword() {
  const { t } = useI18n()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (password !== confirm) {
      setFields({ confirm: 'Both passwords must match' })
      return
    }

    setSubmitting(true)
    setError('')
    setFields({})
    try {
      await api('/api/v1/auth/reset-password', {
        method: 'POST',
        anonymous: true,
        body: { token, password },
      })
      setDone(true)
      setTimeout(() => navigate('/login'), 2500)
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
        setFields(err.fieldErrors)
      } else setError('Could not reset your password')
    } finally {
      setSubmitting(false)
    }
  }

  if (!token) {
    return (
      <Shell title={t('flow.linkNotValid')}>
        <p className="text-sm text-ink-600">{t('flow.resetMissingCode')}</p>
        <Link to="/forgot-password">
          <Button className="mt-5 w-full">{t('flow.requestNewLink')}</Button>
        </Link>
      </Shell>
    )
  }

  if (done) {
    return (
      <Shell title={t('flow.passwordUpdated')}>
        <div className="flex items-center gap-2 text-jade">
          <CheckCircle2 className="h-5 w-5" />
          <p className="text-sm font-medium">{t('flow.resetSignInNow')}</p>
        </div>
      </Shell>
    )
  }

  return (
    <Shell title={t('flow.resetTitle')}>
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorNotice message={error} />}
        <Input
          label={t('flow.newPassword')}
          type="password"
          required
          autoComplete="new-password"
          value={password}
          error={fields.password}
          hint={t('flow.passwordHintShort')}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Input
          label={t('flow.confirmNewPassword')}
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          error={fields.confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <Button type="submit" className="w-full" loading={submitting}>
          {t('flow.setPassword')}
        </Button>
      </form>
    </Shell>
  )
}

/* -------------------------------------------------------------------------- */
/* Accept invitation                                                           */
/* -------------------------------------------------------------------------- */

interface InvitationDetails {
  organisationName: string
  inviterName: string | null
  role: string
  email: string | null
  hasAccount: boolean
}

export function AcceptInvite() {
  const { t } = useI18n()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { refreshUser } = useAuth()
  const token = params.get('token') ?? ''

  const [details, setDetails] = useState<InvitationDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [fullName, setFullName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!token) {
      setLoadError('That invitation link is missing its code.')
      setLoading(false)
      return
    }

    void api<InvitationDetails>(`/api/v1/auth/invitation/${token}`, { anonymous: true })
      .then(setDetails)
      .catch((err) =>
        setLoadError(
          err instanceof ApiError ? err.message : 'We could not load that invitation.',
        ),
      )
      .finally(() => setLoading(false))
  }, [token])

  const accept = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    setFields({})
    try {
      const result = await api<{ accessToken: string }>(
        `/api/v1/auth/invitation/${token}/accept`,
        {
          method: 'POST',
          anonymous: true,
          // An existing user needs neither; a new one needs both.
          body: details?.hasAccount ? {} : { fullName, password },
        },
      )
      setAccessToken(result.accessToken)
      await refreshUser()
      navigate('/app')
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
        setFields(err.fieldErrors)
      } else setError('Could not accept the invitation')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <Shell title={t('flow.loadingInvitation')}>
        <div className="flex items-center gap-2 text-sm text-ink-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          One moment…
        </div>
      </Shell>
    )
  }

  if (loadError || !details) {
    return (
      <Shell title={t('flow.invitationNotValid')}>
        <div className="flex items-start gap-2 text-rose">
          <XCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <p className="text-sm">{loadError}</p>
        </div>
        <Link to="/login">
          <Button variant="secondary" className="mt-5 w-full">
            {t('flow.backToSignIn')}
          </Button>
        </Link>
      </Shell>
    )
  }

  return (
    <Shell
      title={`Join ${details.organisationName}`}
      subtitle={
        details.inviterName
          ? `${details.inviterName} invited you as ${details.role.toLowerCase()}.`
          : `You have been invited as ${details.role.toLowerCase()}.`
      }
    >
      <form onSubmit={accept} className="space-y-4">
        {error && <ErrorNotice message={error} />}

        {details.email && (
          <div className="rounded-lg bg-ink-50 px-3 py-2">
            <p className="text-xs text-ink-500">{t('flow.invitationSentTo')}</p>
            <p className="money text-sm font-medium text-ink-900">{details.email}</p>
          </div>
        )}

        {!details.hasAccount && (
          <>
            <Input
              label={t('auth.fullName')}
              required
              autoComplete="name"
              value={fullName}
              error={fields.fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
            <Input
              label={t('flow.choosePassword')}
              type="password"
              required
              autoComplete="new-password"
              value={password}
              error={fields.password}
              hint={t('flow.passwordHintShort')}
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        )}

        <Button type="submit" className="w-full" loading={submitting}>
          {details.hasAccount ? 'Accept invitation' : 'Create account and join'}
        </Button>
      </form>
    </Shell>
  )
}
