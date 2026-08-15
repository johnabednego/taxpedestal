import { useEffect, useMemo, useState } from 'react'
import { BRAND } from '../brand'
import { useI18n, type TranslationKey } from '../i18n'
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { Logo } from '../components/Logo'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  Check,
  FileText,
  Globe2,
  Landmark,
  Loader2,
  ScrollText,
  ShieldCheck,
  Smartphone,
  Wallet,
} from 'lucide-react'
import { api } from '../lib/api'
import { formatMoney } from '../lib/format'
import { Button } from '../components/ui'

/**
 * Landing page.
 *
 * The hero is NOT a screenshot. It is a working invoice wired to the real
 * /invoices/preview endpoint, so changing the customer's country recomputes tax
 * through the same engine that prices production invoices.
 *
 * That is the entire pitch made tangible in one interaction: switch from a UK
 * domestic supply to Germany-to-France B2B and watch 20% VAT become a
 * reverse-charge notice; switch to India and watch one tax line split into two.
 * A static marketing page cannot demonstrate that, and a screenshot cannot fake
 * it.
 *
 * The six scenarios deliberately span four continents and six distinct
 * mechanisms. An earlier version used two EU cases plus Ghana, which read as a
 * regional tool rather than a global one.
 */

interface PreviewResponse {
  subtotalMinor: number
  discountMinor: number
  taxMinor: number
  totalMinor: number
  taxComponents: Array<{ code: string; label: string; basisPoints: number; amountMinor: number }>
  taxNotes: string[]
  treatmentLabel: string | null
}

interface Scenario {
  id: string
  flag: string
  currency: string
  supplierCountry: string
  supplierRegion?: string
  supplyType: 'goods' | 'services' | 'digital_services'
  customer: {
    country: string
    region?: string | null
    isBusiness: boolean
    taxId?: string | null
    taxRegistered: boolean
  }
  customerName: string
}

/**
 * Chosen to span continents AND tax mechanisms. Every entry exercises a
 * different code path in the engine: a flat national rate, a liability shift, a
 * destination lookup, a sub-national split, a state rate, and a multi-component
 * levy. Nothing here is a variation on the same rule.
 */
const SCENARIOS: Scenario[] = [
  {
    id: 'gb',
    flag: '🇬🇧',
    currency: 'GBP',
    supplierCountry: 'GB',
    supplyType: 'services',
    customerName: 'Pentland Works Ltd',
    customer: { country: 'GB', isBusiness: true, taxId: 'GB123456789', taxRegistered: true },
  },
  {
    id: 'eu-b2b',
    flag: '🇩🇪',
    currency: 'EUR',
    supplierCountry: 'DE',
    supplyType: 'services',
    customerName: 'Atelier Rive Gauche SARL',
    customer: { country: 'FR', isBusiness: true, taxId: 'FR12345678901', taxRegistered: true },
  },
  {
    id: 'eu-b2c',
    flag: '🇭🇺',
    currency: 'EUR',
    supplierCountry: 'DE',
    supplyType: 'digital_services',
    customerName: 'Zsófia Nagy',
    customer: { country: 'HU', isBusiness: false, taxRegistered: false },
  },
  {
    id: 'in',
    flag: '🇮🇳',
    currency: 'INR',
    supplierCountry: 'IN',
    supplierRegion: 'MH',
    supplyType: 'services',
    customerName: 'Kadamba Systems Pvt Ltd',
    customer: { country: 'IN', region: 'KA', isBusiness: true, taxRegistered: true },
  },
  {
    id: 'us',
    flag: '🇺🇸',
    currency: 'USD',
    supplierCountry: 'US',
    supplierRegion: 'CA',
    supplyType: 'goods',
    customerName: 'Lone Star Supply Co',
    customer: { country: 'US', region: 'TX', isBusiness: true, taxRegistered: true },
  },
  {
    id: 'gh',
    flag: '🇬🇭',
    currency: 'GHS',
    supplierCountry: 'GH',
    supplyType: 'services',
    customerName: 'Kwame Foods Ltd',
    customer: { country: 'GH', isBusiness: true, taxId: 'C0098765432', taxRegistered: true },
  },
]

const LINES = [
  // Descriptions are key ids; the demo invoice is marketing copy and reads in
  // the visitor's language like everything around it.
  { descriptionKey: 'site.demoLine1', quantityMilli: 1000, unitAmountMinor: 180_000 },
  { descriptionKey: 'site.demoLine2', quantityMilli: 3000, unitAmountMinor: 45_000 },
]

export default function Landing() {
  const { t } = useI18n()
  const [active, setActive] = useState<Scenario>(SCENARIOS[0]!)
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)

    void api<PreviewResponse>('/api/v1/invoices/preview-public', {
      method: 'POST',
      anonymous: true,
      body: {
        supplierCountry: active.supplierCountry,
        supplierRegion: active.supplierRegion ?? null,
        customer: active.customer,
        currency: active.currency,
        lines: LINES.map(({ descriptionKey, ...line }) => ({
          ...line,
          description: t(descriptionKey as TranslationKey),
          supplyType: active.supplyType,
        })),
      },
    })
      .then((data) => {
        if (!cancelled) setPreview(data)
      })
      .catch(() => {
        // The API may not be running when someone opens the marketing page.
        // Degrade to a static example rather than showing a broken hero.
        if (!cancelled) setFailed(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [active, t])

  const subtotal = useMemo(
    () => LINES.reduce((sum, l) => sum + (l.quantityMilli * l.unitAmountMinor) / 1000, 0),
    [],
  )

  return (
    <div className="min-h-screen bg-ink-50">
      {/* ---- Nav ---------------------------------------------------------- */}
      <header className="sticky top-0 z-40 border-b border-ink-100 bg-ink-50/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Link to="/" className="flex items-center gap-2">
            <Logo />
            <span className="font-display text-lg font-bold tracking-tightest">{BRAND.name}</span>
          </Link>
          <nav className="hidden items-center gap-7 text-sm text-ink-600 md:flex">
            <a href="#tax" className="hover:text-ink-900">{t('site.taxEngine')}</a>
            <a href="#collect" className="hover:text-ink-900">{t('site.gettingPaid')}</a>
            <a href="#trust" className="hover:text-ink-900">{t('site.reliability')}</a>
          </nav>
          <div className="flex items-center gap-1.5">
            <LanguageSwitcher compact />
            <Link to="/login">
              <Button variant="ghost" size="sm">{t('auth.signIn')}</Button>
            </Link>
            <Link to="/register">
              <Button size="sm">{t('site.startFree')}</Button>
            </Link>
          </div>
        </div>
      </header>

      {/* ---- Hero --------------------------------------------------------- */}
      <section className="mx-auto max-w-6xl px-5 pt-14 pb-20 md:pt-20">
        <div className="grid items-start gap-12 lg:grid-cols-[1fr_1.05fr]">
          <div className="animate-fade-up">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-ink-200 bg-white px-3 py-1 text-xs font-medium text-ink-600">
              <Globe2 className="h-3.5 w-3.5 text-cobalt" />
              {t('site.heroBadge', { count: 53 })}
            </div>

            <h1 className="font-display text-[2.6rem] font-bold leading-[1.05] tracking-tightest text-ink-900 sm:text-6xl">
              {t('site.heroTitleA')}
              <br />
              <span className="text-cobalt">{t('site.heroTitleB')}</span>
            </h1>

            <p className="mt-5 max-w-lg text-lg leading-relaxed text-ink-600">
              {t('site.heroBody')}
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link to="/register">
                <Button size="lg" icon={<ArrowRight className="h-4 w-4" />}>
                  {t('site.ctaPrimary')}
                </Button>
              </Link>
              <a href="#tax">
                <Button size="lg" variant="secondary">
                  {t('site.ctaSecondary')}
                </Button>
              </a>
            </div>

            <p className="mt-4 text-sm text-ink-500">{t('site.freeNote')}</p>

            <div className="mt-10 flex flex-wrap gap-x-6 gap-y-3 text-sm text-ink-600">
              {[
                { icon: Smartphone, text: t('site.railMobileMoney') },
                { icon: Wallet, text: t('site.railCards') },
                { icon: Landmark, text: t('site.railBank') },
              ].map(({ icon: Icon, text }) => (
                <span key={text} className="inline-flex items-center gap-1.5">
                  <Icon className="h-4 w-4 text-ink-400" />
                  {text}
                </span>
              ))}
            </div>
          </div>

          {/* ---- The live invoice ---------------------------------------- */}
          <div className="animate-fade-up [animation-delay:120ms]">
            <div className="mb-3 flex items-center gap-2 text-xs font-medium text-ink-500">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-jade opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-jade" />
              </span>
              {t('site.liveHint')}
            </div>

            <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-ink-200 bg-white p-1.5 sm:grid-cols-3">
              {SCENARIOS.map((scenario) => (
                <button
                  key={scenario.id}
                  onClick={() => setActive(scenario)}
                  aria-pressed={active.id === scenario.id}
                  className={`rounded-lg px-2.5 py-2 text-left transition-colors ${
                    active.id === scenario.id
                      ? 'bg-ink-900 text-white'
                      : 'text-ink-600 hover:bg-ink-50'
                  }`}
                >
                  <span className="block truncate text-sm font-semibold">
                    {scenario.flag} {t(`site.sc.${scenario.id}.label` as TranslationKey)}
                  </span>
                  <span
                    className={`block truncate text-2xs ${
                      active.id === scenario.id ? 'text-ink-300' : 'text-ink-400'
                    }`}
                  >
                    {t(`site.sc.${scenario.id}.sub` as TranslationKey)}
                  </span>
                </button>
              ))}
            </div>

            <div className="mt-3 overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-lift">
              <div className="flex items-start justify-between border-b border-ink-100 px-6 py-5">
                <div>
                  <p className="font-display text-base font-bold">Northwind Studio</p>
                  <p className="text-xs text-ink-500">
                    {t('site.registeredIn', { country: active.supplierCountry })}
                    {active.supplierRegion ? ` · ${active.supplierRegion}` : ''}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-2xs font-semibold uppercase tracking-wide text-ink-400">
                    {t('site.invoiceWord')}
                  </p>
                  <p className="money text-sm font-semibold">NWS-0042</p>
                </div>
              </div>

              <div className="px-6 py-4">
                <p className="text-2xs font-semibold uppercase tracking-wide text-ink-400">
                  {t('site.billedTo')}
                </p>
                <p className="text-sm font-medium text-ink-900">{active.customerName}</p>
                <p className="text-xs text-ink-500">
                  {active.customer.country}
                  {active.customer.taxId ? ` · ${active.customer.taxId}` : ''}
                  {active.customer.isBusiness ? ' · Business' : ' · Consumer'}
                </p>
              </div>

              <div className="px-6">
                <div className="border-t border-ink-100 pt-3">
                  {LINES.map((line) => (
                    <div key={line.descriptionKey} className="flex justify-between py-1.5 text-sm">
                      <span className="text-ink-700">
                        {t(line.descriptionKey as TranslationKey)}
                        <span className="ml-1.5 text-ink-400">×{line.quantityMilli / 1000}</span>
                      </span>
                      <span className="money text-ink-900">
                        {formatMoney(
                          (line.quantityMilli * line.unitAmountMinor) / 1000,
                          active.currency,
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-2 border-t border-ink-100 px-6 py-4">
                <div className="flex justify-between py-1 text-sm">
                  <span className="text-ink-500">{t('inv.subtotal')}</span>
                  <span className="money text-ink-700">
                    {formatMoney(subtotal, active.currency)}
                  </span>
                </div>

                {loading && (
                  <div className="flex items-center gap-2 py-2 text-sm text-ink-400">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('site.computingTax')}
                  </div>
                )}

                {!loading && failed && (
                  <div className="py-2 text-xs text-ink-400">
                    {t('site.apiOffline')}
                  </div>
                )}

                {!loading && !failed && preview && (
                  <div className="animate-fade-up">
                    {preview.taxComponents.length > 0 ? (
                      preview.taxComponents.map((component) => (
                        <div
                          key={component.code}
                          className="flex justify-between py-1 text-sm"
                        >
                          <span className="text-ink-500">{component.label}</span>
                          <span className="money text-ink-700">
                            {formatMoney(component.amountMinor, active.currency)}
                          </span>
                        </div>
                      ))
                    ) : (
                      <div className="flex justify-between py-1 text-sm">
                        <span className="text-ink-500">Tax</span>
                        <span className="money text-ink-700">
                          {formatMoney(0, active.currency)}
                        </span>
                      </div>
                    )}

                    <div className="mt-2 flex items-baseline justify-between border-t border-ink-200 pt-3">
                      <span className="text-sm font-semibold text-ink-900">{t('site.totalDue')}</span>
                      <span className="money text-2xl font-bold text-ink-900">
                        {formatMoney(preview.totalMinor, active.currency)}
                      </span>
                    </div>

                    {preview.taxNotes.length > 0 && (
                      <div className="mt-3 rounded-lg bg-cobalt-50 px-3 py-2">
                        <p className="text-xs leading-relaxed text-cobalt-700">
                          <ScrollText className="mr-1 inline h-3 w-3" />
                          {preview.taxNotes[0]}
                        </p>
                      </div>
                    )}

                    <p className="mt-2.5 text-xs text-ink-500">
                      {t(`site.sc.${active.id}.teaches` as TranslationKey)}
                    </p>
                  </div>
                )}
              </div>
            </div>

            <p className="mt-3 text-center text-xs text-ink-400">
              {t('site.liveFooter')}
            </p>
          </div>
        </div>
      </section>

      {/* ---- Tax ---------------------------------------------------------- */}
      <section id="tax" className="border-y border-ink-100 bg-white py-20">
        <div className="mx-auto max-w-6xl px-5">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-wide text-cobalt">
              {t('site.taxEyebrow')}
            </p>
            <h2 className="mt-2 text-3xl font-bold text-ink-900 sm:text-4xl">
              {t('site.taxTitle')}
            </h2>
            <p className="mt-4 text-lg text-ink-600">{t('site.taxLead')}</p>
          </div>

          <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: Building2,
                title: t('site.featShift.title'),
                body: t('site.featShift.body'),
                regions: 'EU · UK',
              },
              {
                icon: Globe2,
                title: t('site.featDestination.title'),
                body: t('site.featDestination.body'),
                regions: 'EU OSS',
              },
              {
                icon: Landmark,
                title: t('site.featSubnational.title'),
                body: t('site.featSubnational.body'),
                regions: 'US · Canada · India',
              },
              {
                icon: BadgeCheck,
                title: t('site.featDated.title'),
                body: t('site.featDated.body'),
                regions: t('site.featDated.regions', { count: 53 }),
              },
            ].map(({ icon: Icon, title, body, regions }) => (
              <div key={title} className="rounded-xl border border-ink-100 bg-ink-50 p-6">
                <Icon className="h-5 w-5 text-cobalt" />
                <h3 className="mt-4 text-base font-semibold text-ink-900">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-600">{body}</p>
                <p className="mt-3 text-2xs font-semibold uppercase tracking-wide text-ink-400">
                  {regions}
                </p>
              </div>
            ))}
          </div>

          {/* Coverage. Concrete beats a claim of "global". */}
          <div className="mt-10 rounded-xl border border-ink-100 bg-ink-50 p-6">
            <p className="text-sm font-semibold text-ink-900">{t('site.coverageTitle')}</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {[
                { region: t('site.regionEurope'), detail: t('site.regionEuropeDetail') },
                { region: t('site.regionAfrica'), detail: t('site.regionAfricaDetail') },
                { region: t('site.regionAmericas'), detail: t('site.regionAmericasDetail') },
                { region: t('site.regionAsiaPacific'), detail: t('site.regionAsiaPacificDetail') },
                { region: t('site.regionMiddleEast'), detail: t('site.regionMiddleEastDetail') },
              ].map(({ region, detail }) => (
                <div key={region}>
                  <p className="text-xs font-semibold uppercase tracking-wide text-cobalt">
                    {region}
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-ink-600">{detail}</p>
                </div>
              ))}
            </div>
            <p className="mt-5 border-t border-ink-200 pt-4 text-sm text-ink-500">
              {t('site.coverageFooter')}
            </p>
          </div>
        </div>
      </section>

      {/* ---- Collect ------------------------------------------------------ */}
      <section id="collect" className="py-20">
        <div className="mx-auto max-w-6xl px-5">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-cobalt">
                {t('site.gettingPaid')}
              </p>
              <h2 className="mt-2 text-3xl font-bold text-ink-900 sm:text-4xl">
                {t('site.collectTitle')}
              </h2>
              <p className="mt-4 text-lg text-ink-600">
                {t('site.collectBody')}
              </p>
              <ul className="mt-6 space-y-3">
                {[
                  t('site.collectBullet1'),
                  t('site.collectBullet2'),
                  t('site.collectBullet3'),
                  t('site.collectBullet4'),
                  t('site.collectBullet5'),
                ].map((item) => (
                  <li key={item} className="flex gap-2.5 text-sm text-ink-700">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-jade" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-card">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-ink-500">{t('pay.amountDue')}</p>
                  <p className="money text-3xl font-bold text-ink-900">€4,250.00</p>
                </div>
                <div className="rotate-[-12deg] rounded-lg border-2 border-jade px-3 py-1 shadow-stamp">
                  <span className="text-sm font-bold uppercase tracking-wide text-jade">{t('site.paidTag')}</span>
                </div>
              </div>
              <div className="mt-5 space-y-2">
                {[
                  { icon: Wallet, label: t('site.methodCard'), note: t('site.methodCardNote') },
                  { icon: Landmark, label: t('site.methodBank'), note: t('site.methodBankNote') },
                  { icon: Smartphone, label: t('site.methodMobile'), note: t('site.methodMobileNote') },
                ].map(({ icon: Icon, label, note }) => (
                  <div
                    key={label}
                    className="flex items-center gap-3 rounded-lg border border-ink-200 px-4 py-3"
                  >
                    <Icon className="h-4 w-4 text-ink-500" />
                    <div>
                      <p className="text-sm font-medium text-ink-900">{label}</p>
                      <p className="text-xs text-ink-500">{note}</p>
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs text-ink-500">
                {t('site.collectFooter')}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---- Trust -------------------------------------------------------- */}
      <section id="trust" className="border-t border-ink-100 bg-ink-900 py-20 text-white">
        <div className="mx-auto max-w-6xl px-5">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-wide text-cobalt-400">
              {t('site.reliability')}
            </p>
            <h2 className="mt-2 text-3xl font-bold sm:text-4xl">
              {t('site.reliabilityTitle')}
            </h2>
            <p className="mt-4 text-lg text-ink-300">
              {t('site.reliabilityBody')}
            </p>
          </div>

          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {[
              {
                icon: ScrollText,
                title: t('site.relLedger.title'),
                body: t('site.relLedger.body'),
              },
              {
                icon: ShieldCheck,
                title: t('site.relOnce.title'),
                body: t('site.relOnce.body'),
              },
              {
                icon: FileText,
                title: t('site.relReconcile.title'),
                body: t('site.relReconcile.body'),
              },
            ].map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-xl border border-ink-700 bg-ink-800 p-6">
                <Icon className="h-5 w-5 text-cobalt-400" />
                <h3 className="mt-4 text-base font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-300">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- CTA ---------------------------------------------------------- */}
      <section className="py-20">
        <div className="mx-auto max-w-3xl px-5 text-center">
          <h2 className="text-3xl font-bold text-ink-900 sm:text-4xl">
            {t('site.finalCta')}
          </h2>
          <p className="mt-4 text-lg text-ink-600">
            {t('site.freeNote')}
          </p>
          <div className="mt-8 flex justify-center">
            <Link to="/register">
              <Button size="lg" icon={<ArrowRight className="h-4 w-4" />}>
                {t('site.createWorkspace')}
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-ink-100 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 text-sm text-ink-500 sm:flex-row">
          <div className="flex items-center gap-2">
            <Logo />
            <span className="font-display font-bold text-ink-900">{BRAND.name}</span>
          </div>
          <p>
            {t('site.rights', {
              // A string, not a number: numeric vars go through Intl grouping,
              // which would render the year as "2,026".
              year: String(new Date().getFullYear()),
              tagline: t('site.tagline'),
            })}
          </p>
        </div>
      </footer>
    </div>
  )
}

