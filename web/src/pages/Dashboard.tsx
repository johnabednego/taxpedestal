import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { AlertTriangle, FileText, Plus, Users, Wallet } from 'lucide-react'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useI18n } from '../i18n'
import { formatCompact, formatMoney } from '../lib/format'
import { Button, Card, EmptyState, SectionHeading, Skeleton } from '../components/ui'

interface Summary {
  currency: string
  outstanding: { amountMinor: number; formatted: string; count: number }
  overdue: { amountMinor: number; formatted: string; count: number }
  collectedThisMonth: { amountMinor: number; formatted: string }
  draftCount: number
  clientCount: number
  aging: Array<{
    /** Stable identifier; `bucket` is the API's English fallback. */
    bucketId: string
    bucket: string
    amountMinor: number
    formatted: string
    count: number
  }>
  monthly: Array<{ month: string; invoicedMinor: number; collectedMinor: number; count: number }>
  topClients: Array<{ name: string; amountMinor: number; formatted: string; invoiceCount: number }>
  recentPayments: Array<{
    id: string
    amountMinor: number
    formatted: string
    method: string
    channelDetail: string | null
    paidAt: string | null
    invoiceNumber: string | null
  }>
}

export default function Dashboard() {
  const { org } = useAuth()
  const { t, tOr, locale, formatNumber } = useI18n()
  const { data, isLoading, error } = useQuery({
    queryKey: ['analytics', org?.id],
    queryFn: () => api<Summary>('/api/v1/analytics/summary'),
    enabled: Boolean(org),
  })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-72" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <EmptyState
        icon={<AlertTriangle className="h-5 w-5" />}
        title={t('dash.loadFailed')}
        description={t('dash.loadFailedHelp')}
      />
    )
  }

  // Series names are shown in the tooltip and legend, so they are translated
  // rather than used as raw data keys.
  const invoicedLabel = t('dash.chartInvoiced')
  const collectedLabel = t('dash.chartCollected')

  const chartData = data.monthly.map((m) => ({
    // Month abbreviations come from Intl, so a French chart reads "janv."
    // rather than "Jan".
    month: new Intl.DateTimeFormat(locale, { month: 'short' }).format(
      new Date(`${m.month}-01T00:00:00`),
    ),
    [invoicedLabel]: m.invoicedMinor / 100,
    [collectedLabel]: m.collectedMinor / 100,
  }))

  const hasActivity = data.monthly.length > 0 || data.outstanding.count > 0

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink-900">{t('dash.title')}</h1>
          <p className="text-sm text-ink-500">{org?.name}</p>
        </div>
        <Link to="/app/invoices/new">
          <Button icon={<Plus className="h-4 w-4" />}>{t('inv.new')}</Button>
        </Link>
      </div>

      {/* Metrics */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label={t('dash.outstanding')}
          value={data.outstanding.formatted}
          sub={t('dash.openInvoices', { count: data.outstanding.count })}
          icon={<FileText className="h-4 w-4" />}
        />
        <Metric
          label={t('dash.overdue')}
          value={data.overdue.formatted}
          sub={t('dash.pastDue', { count: data.overdue.count })}
          icon={<AlertTriangle className="h-4 w-4" />}
          tone={data.overdue.amountMinor > 0 ? 'danger' : 'neutral'}
        />
        <Metric
          label={t('dash.collected')}
          value={data.collectedThisMonth.formatted}
          sub={t('dash.receivedIntoAccount')}
          icon={<Wallet className="h-4 w-4" />}
          tone="success"
        />
        <Metric
          label={t('dash.clients')}
          value={formatNumber(data.clientCount)}
          sub={t('dash.drafts', { count: data.draftCount })}
          icon={<Users className="h-4 w-4" />}
        />
      </div>

      {!hasActivity ? (
        <Card>
          <EmptyState
            icon={<FileText className="h-5 w-5" />}
            title={t('dash.noInvoices')}
            description={t('dash.noInvoicesHelp')}
            action={
              <Link to="/app/invoices/new">
                <Button icon={<Plus className="h-4 w-4" />}>{t('dash.createInvoice')}</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          {/* Cashflow */}
          <Card>
            <SectionHeading
              title={t('dash.invoicedVsCollected')}
              description={t('dash.invoicedVsCollectedHelp')}
            />
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="invoiced" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#2B59FF" stopOpacity={0.22} />
                      <stop offset="100%" stopColor="#2B59FF" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="collected" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#0E9F6E" stopOpacity={0.22} />
                      <stop offset="100%" stopColor="#0E9F6E" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E8ECF3" vertical={false} />
                  <XAxis
                    dataKey="month"
                    tick={{ fontSize: 12, fill: '#8494BA' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 12, fill: '#8494BA' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: number) => formatCompact(v * 100, data.currency)}
                  />
                  <Tooltip
                    formatter={(value: number) => formatMoney(value * 100, data.currency)}
                    contentStyle={{
                      borderRadius: 10,
                      border: '1px solid #E8ECF3',
                      fontSize: 13,
                      boxShadow: '0 8px 24px -8px rgba(11,27,58,0.18)',
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey={invoicedLabel}
                    stroke="#2B59FF"
                    strokeWidth={2}
                    fill="url(#invoiced)"
                  />
                  <Area
                    type="monotone"
                    dataKey={collectedLabel}
                    stroke="#0E9F6E"
                    strokeWidth={2}
                    fill="url(#collected)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Aging */}
            <Card>
              <SectionHeading
                title={t('dash.aging')}
                description={t('dash.agingSubtitle')}
              />
              {data.aging.length === 0 ? (
                <p className="py-6 text-center text-sm text-ink-500">
                  {t('dash.nothingOutstanding')}
                </p>
              ) : (
                <div className="space-y-3">
                  {data.aging.map((bucket) => {
                    const max = Math.max(...data.aging.map((b) => b.amountMinor), 1)
                    // Compared against the stable id, not the English prose —
                    // the label is translated and would never match.
                    const isLate = bucket.bucketId !== 'notYetDue'
                    return (
                      <div key={bucket.bucketId}>
                        <div className="mb-1 flex items-baseline justify-between text-sm">
                          <span className="text-ink-600">
                            {tOr(`aging.${bucket.bucketId}`, bucket.bucket)}
                          </span>
                          <span className="money font-medium text-ink-900">
                            {bucket.formatted}
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-ink-100">
                          <div
                            className={`h-full rounded-full ${isLate ? 'bg-amber' : 'bg-cobalt'}`}
                            style={{ width: `${(bucket.amountMinor / max) * 100}%` }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </Card>

            {/* Recent payments */}
            <Card>
              <SectionHeading title={t('dash.recentPayments')} />
              {data.recentPayments.length === 0 ? (
                <p className="py-6 text-center text-sm text-ink-500">{t('dash.noPayments')}</p>
              ) : (
                <ul className="divide-y divide-ink-100">
                  {data.recentPayments.map((payment) => (
                    <li key={payment.id} className="flex items-center justify-between py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink-900">
                          {payment.invoiceNumber ?? t('dash.payment')}
                        </p>
                        <p className="truncate text-xs text-ink-500">
                          {payment.channelDetail ??
                            tOr(
                              `method.${payment.method}`,
                              payment.method.replace('_', ' ').toLowerCase(),
                            )}
                          {payment.paidAt
                            ? ` · ${new Intl.DateTimeFormat(locale, {
                                day: 'numeric',
                                month: 'short',
                              }).format(new Date(payment.paidAt))}`
                            : ''}
                        </p>
                      </div>
                      <span className="money shrink-0 text-sm font-semibold text-jade">
                        {payment.formatted}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {data.topClients.length > 0 && (
            <Card>
              <SectionHeading title={t('dash.topClients')} description={t('dash.topClientsHelp')} />
              <ul className="divide-y divide-ink-100">
                {data.topClients.map((client) => (
                  <li key={client.name} className="flex items-center justify-between py-2.5">
                    <div>
                      <p className="text-sm font-medium text-ink-900">{client.name}</p>
                      <p className="text-xs text-ink-500">
                        {t('dash.invoiceCount', { count: client.invoiceCount })}
                      </p>
                    </div>
                    <span className="money text-sm font-semibold text-ink-900">
                      {client.formatted}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

function Metric({
  label,
  value,
  sub,
  icon,
  tone = 'neutral',
}: {
  label: string
  value: string
  sub: string
  icon: React.ReactNode
  tone?: 'neutral' | 'success' | 'danger'
}) {
  return (
    <Card className="relative">
      <div className="flex items-start justify-between">
        <p className="text-sm text-ink-500">{label}</p>
        <span
          className={
            tone === 'danger'
              ? 'text-rose'
              : tone === 'success'
                ? 'text-jade'
                : 'text-ink-400'
          }
        >
          {icon}
        </span>
      </div>
      <p
        className={`money mt-2 text-2xl font-bold ${
          tone === 'danger' ? 'text-rose' : 'text-ink-900'
        }`}
      >
        {value}
      </p>
      <p className="mt-0.5 text-xs text-ink-500">{sub}</p>
    </Card>
  )
}
