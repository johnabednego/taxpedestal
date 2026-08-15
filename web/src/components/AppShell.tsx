import { useState } from 'react'
import { BRAND } from '../brand'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  BarChart3,
  ChevronDown,
  FileText,
  LogOut,
  Menu,
  Settings,
  Shield,
  Users,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import { useAuth } from '../lib/auth'
import { initials } from '../lib/format'
import { useI18n, type TranslationKey } from '../i18n'
import { LanguageSwitcher } from './LanguageSwitcher'

interface NavItem {
  to: string
  key: TranslationKey
  icon: typeof BarChart3
  end?: boolean
}

const NAV: NavItem[] = [
  { to: '/app', key: 'nav.dashboard', icon: BarChart3, end: true },
  { to: '/app/invoices', key: 'nav.invoices', icon: FileText },
  { to: '/app/clients', key: 'nav.clients', icon: Users },
  { to: '/app/settings', key: 'nav.settings', icon: Settings },
]

export default function AppShell() {
  const { user, org, organisations, switchOrg, logout } = useAuth()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [orgMenuOpen, setOrgMenuOpen] = useState(false)

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  const sidebar = (
    <div className="flex h-full flex-col">
      {/* Workspace switcher */}
      <div className="relative px-3 py-4">
        <button
          onClick={() => setOrgMenuOpen((v) => !v)}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-ink-100"
        >
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-2xs font-bold text-white"
            style={{ backgroundColor: org?.brandColor ?? '#2B59FF' }}
          >
            {org ? initials(org.name) : '—'}
          </div>
          <div className="min-w-0 flex-1 text-start">
            <p className="truncate text-sm font-semibold text-ink-900">{org?.name ?? t('nav.workspace')}</p>
            <p className="truncate text-2xs uppercase tracking-wide text-ink-400">
              {org?.role ?? ''}
            </p>
          </div>
          <ChevronDown className="h-4 w-4 shrink-0 text-ink-400" />
        </button>

        {orgMenuOpen && organisations.length > 0 && (
          <div className="absolute start-3 end-3 top-full z-20 mt-1 rounded-lg border border-ink-200 bg-white py-1 shadow-lift">
            {organisations.map((option) => (
              <button
                key={option.id}
                onClick={() => {
                  switchOrg(option.id)
                  setOrgMenuOpen(false)
                }}
                className={clsx(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-ink-50',
                  option.id === org?.id ? 'font-semibold text-ink-900' : 'text-ink-600',
                )}
              >
                <span
                  className="flex h-6 w-6 items-center justify-center rounded text-2xs font-bold text-white"
                  style={{ backgroundColor: option.brandColor }}
                >
                  {initials(option.name)}
                </span>
                <span className="truncate">{option.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <nav className="flex-1 space-y-0.5 px-3">
        {NAV.map(({ to, key, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={() => setMobileOpen(false)}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-ink-900 text-white'
                  : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
              )
            }
          >
            <Icon className="h-4 w-4" />
            {t(key)}
          </NavLink>
        ))}

        {/* Only rendered for platform staff. The API returns 404 for everyone
            else, so this is presentation, not the security boundary. */}
        {user?.platformRole === 'SUPERADMIN' && (
          <NavLink
            to="/app/admin"
            onClick={() => setMobileOpen(false)}
            className={({ isActive }) =>
              clsx(
                'mt-4 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium',
                isActive
                  ? 'bg-cobalt text-white'
                  : 'text-cobalt-700 hover:bg-cobalt-50',
              )
            }
          >
            <Shield className="h-4 w-4" />
            {t('nav.admin')}
          </NavLink>
        )}
      </nav>

      <div className="border-t border-ink-100 p-3">
        <LanguageSwitcher />
        <div className="flex items-center gap-2.5 px-1 py-1.5">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-full text-2xs font-bold text-white"
            style={{ backgroundColor: user?.avatarColor ?? '#2B59FF' }}
          >
            {user ? initials(user.fullName) : '—'}
          </div>
          <div className="min-w-0 flex-1 text-start">
            <p className="truncate text-sm font-medium text-ink-900">{user?.fullName}</p>
            <p className="truncate text-xs text-ink-500">{user?.email}</p>
          </div>
          <button
            onClick={handleLogout}
            aria-label={t('nav.signOut')}
            className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-ink-50">
      {/* Mobile header */}
      <div className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-ink-100 bg-white px-4 lg:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          aria-label={t('nav.openMenu')}
          className="rounded-lg p-2 text-ink-600 hover:bg-ink-100"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="font-display font-bold">{BRAND.shortName}</span>
        <div
          className="flex h-8 w-8 items-center justify-center rounded-full text-2xs font-bold text-white"
          style={{ backgroundColor: user?.avatarColor ?? '#2B59FF' }}
        >
          {user ? initials(user.fullName) : '—'}
        </div>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-ink-900/40"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <div className="absolute start-0 top-0 h-full w-72 bg-white shadow-lift">
            <button
              onClick={() => setMobileOpen(false)}
              aria-label={t('nav.closeMenu')}
              className="absolute end-3 top-4 rounded-lg p-1.5 text-ink-400 hover:bg-ink-100"
            >
              <X className="h-4 w-4" />
            </button>
            {sidebar}
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 start-0 hidden w-64 border-e border-ink-100 bg-white lg:block">
        {sidebar}
      </aside>

      <main className="lg:ps-64">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
