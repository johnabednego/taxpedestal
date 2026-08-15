import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { api, setAccessToken, setActiveOrg, setUnauthorisedHandler } from './api'
import { registerCurrencies, type CurrencyMeta } from './format'
import { useI18n } from '../i18n'
import type { CountryOption } from './countries'

export interface AuthUser {
  _id: string
  email: string
  fullName: string
  avatarColor: string
  /** Interface language saved on the account. Null when never chosen. */
  preferredLocale: string | null
  platformRole: 'USER' | 'SUPERADMIN'
  emailVerifiedAt: string | null
}

export interface AuthOrg {
  id: string
  name: string
  slug: string
  country: string
  baseCurrency: string
  taxRegistered: boolean
  brandColor: string
  logoUrl: string | null
  plan: string
  onboardingCompletedAt: string | null
  role: 'VIEWER' | 'MEMBER' | 'ADMIN' | 'OWNER'
}

interface AuthState {
  user: AuthUser | null
  org: AuthOrg | null
  organisations: AuthOrg[]
  loading: boolean
  meta: {
    currencies: CurrencyMeta[]
    /** Every ISO country. Operating anywhere is always allowed. */
    countries: CountryOption[]
    /** Subset with automatic tax computation. */
    taxCountries: string[]
  } | null
  login: (email: string, password: string) => Promise<void>
  register: (input: RegisterInput) => Promise<void>
  logout: () => Promise<void>
  switchOrg: (id: string) => void
  refreshUser: () => Promise<void>
}

export interface RegisterInput {
  fullName: string
  email: string
  password: string
  organisationName: string
  country: string
  baseCurrency: string
}

const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthProvider')
  return context
}

/** Role rank, mirroring the server, so the UI hides what the API would reject. */
const RANK = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 } as const

export function useCan(minimum: keyof typeof RANK): boolean {
  const { org } = useAuth()
  if (!org) return false
  return RANK[org.role] >= RANK[minimum]
}

const ORG_STORAGE_KEY = 'taxpedestal.activeOrg'

export function AuthProvider({ children }: { children: ReactNode }) {
  // I18nProvider sits above this one in main.tsx, so the locale is available.
  const { locale } = useI18n()
  const [user, setUser] = useState<AuthUser | null>(null)
  const [organisations, setOrganisations] = useState<AuthOrg[]>([])
  const [orgId, setOrgId] = useState<string | null>(() =>
    typeof localStorage === 'undefined' ? null : localStorage.getItem(ORG_STORAGE_KEY),
  )
  const [loading, setLoading] = useState(true)
  const [meta, setMeta] = useState<AuthState['meta']>(null)

  const org = useMemo(
    () => organisations.find((o) => o.id === orgId) ?? organisations[0] ?? null,
    [organisations, orgId],
  )

  useEffect(() => {
    setActiveOrg(org?.id ?? null)
  }, [org])

  const loadUser = useCallback(async () => {
    const data = await api<{ user: AuthUser; organisations: AuthOrg[] }>('/api/v1/auth/me')
    setUser(data.user)
    setOrganisations(data.organisations)
    if (!data.organisations.some((o) => o.id === orgId)) {
      setOrgId(data.organisations[0]?.id ?? null)
    }
  }, [orgId])

  /**
   * Bootstrap: try to restore a session using the httpOnly refresh cookie.
   * There is no token in localStorage to read, so a silent refresh is the only
   * way to know whether the user is signed in.
   */
  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const refreshed = await fetch(
          `${import.meta.env.VITE_API_URL ?? 'http://localhost:4000'}/api/v1/auth/refresh`,
          { method: 'POST', credentials: 'include' },
        )
        if (refreshed.ok) {
          const { accessToken } = (await refreshed.json()) as { accessToken: string }
          setAccessToken(accessToken)
          if (!cancelled) await loadUser()
        }
      } catch {
        // Not signed in. Not an error.
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
    // Intentionally runs once: loadUser depends on orgId, which would re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Reference data, refetched whenever the language changes.
   *
   * `/meta` returns the 249 country names in the requested language, so this
   * cannot be a one-off fetch: switching to French has to re-ask for
   * "Allemagne" rather than leave every picker in English.
   */
  useEffect(() => {
    let cancelled = false

    void api<{
      currencies: CurrencyMeta[]
      countries: CountryOption[]
      taxCountries: string[]
    }>('/api/v1/meta', { anonymous: true })
      .then((data) => {
        registerCurrencies(data.currencies)
        if (!cancelled) setMeta(data)
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [locale])

  useEffect(() => {
    setUnauthorisedHandler(() => {
      setUser(null)
      setOrganisations([])
      setAccessToken(null)
    })
    return () => setUnauthorisedHandler(null)
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const data = await api<{ user: AuthUser; organisation: AuthOrg; accessToken: string }>(
      '/api/v1/auth/login',
      { method: 'POST', body: { email, password }, anonymous: true },
    )
    setAccessToken(data.accessToken)
    setUser(data.user)
    const full = await api<{ user: AuthUser; organisations: AuthOrg[] }>('/api/v1/auth/me')
    setOrganisations(full.organisations)
    setOrgId(full.organisations[0]?.id ?? null)
  }, [])

  const register = useCallback(async (input: RegisterInput) => {
    const data = await api<{ user: AuthUser; organisation: AuthOrg; accessToken: string }>(
      '/api/v1/auth/register',
      { method: 'POST', body: input, anonymous: true },
    )
    setAccessToken(data.accessToken)
    setUser(data.user)
    const full = await api<{ user: AuthUser; organisations: AuthOrg[] }>('/api/v1/auth/me')
    setOrganisations(full.organisations)
    setOrgId(full.organisations[0]?.id ?? null)
  }, [])

  const logout = useCallback(async () => {
    await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => undefined)
    setAccessToken(null)
    setUser(null)
    setOrganisations([])
    localStorage.removeItem(ORG_STORAGE_KEY)
  }, [])

  const switchOrg = useCallback((id: string) => {
    setOrgId(id)
    localStorage.setItem(ORG_STORAGE_KEY, id)
  }, [])

  const value = useMemo<AuthState>(
    () => ({
      user,
      org,
      organisations,
      loading,
      meta,
      login,
      register,
      logout,
      switchOrg,
      refreshUser: loadUser,
    }),
    [user, org, organisations, loading, meta, login, register, logout, switchOrg, loadUser],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
