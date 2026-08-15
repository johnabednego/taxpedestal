import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, ShieldAlert } from 'lucide-react'
import { api } from '../lib/api'
import { useI18n, type TranslationKey } from '../i18n'
import { Badge, Button, Card, SectionHeading, Skeleton, useToast } from '../components/ui'

interface Overview {
  organisations: number
  users: number
  invoices: { total: number; issued: number }
  successfulPayments: number
  webhooks: { failed: number; pending: number }
}

interface WebhookEvent {
  _id: string
  provider: string
  eventType: string
  status: string
  signatureValid: boolean
  error: string | null
  attempts: number
  createdAt: string
}

export default function Admin() {
  const toast = useToast()
  const { t, locale } = useI18n()
  const queryClient = useQueryClient()

  const { data: overview, isLoading } = useQuery({
    queryKey: ['admin-overview'],
    queryFn: () => api<Overview>('/api/v1/admin/overview'),
  })

  const { data: webhooks } = useQuery({
    queryKey: ['admin-webhooks'],
    queryFn: () => api<{ data: WebhookEvent[] }>('/api/v1/admin/webhooks?limit=25'),
  })

  const reconcile = useMutation({
    mutationFn: () => api<{ settled: number; scanned: number }>('/api/v1/admin/reconcile/payments', { method: 'POST' }),
    onSuccess: (report) => {
      toast.push(
        t('admin.sweepResult', { scanned: report.scanned, settled: report.settled }),
        report.settled > 0 ? 'warning' : 'success',
      )
      void queryClient.invalidateQueries({ queryKey: ['admin-overview'] })
    },
  })

  const reconcileBalances = useMutation({
    mutationFn: () =>
      api<{ checked: number; drifted: number; repaired: number }>(
        '/api/v1/admin/reconcile/balances',
        { method: 'POST', body: { repair: true } },
      ),
    onSuccess: (report) =>
      toast.push(
        t('admin.balanceResult', {
          checked: report.checked,
          drifted: report.drifted,
          repaired: report.repaired,
        }),
        report.drifted > 0 ? 'warning' : 'success',
      ),
  })

  if (isLoading) return <Skeleton className="h-96" />

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-5 w-5 text-cobalt" />
        <h1 className="text-2xl font-bold text-ink-900">{t('admin.title')}</h1>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {(
          [
            ['admin.workspaces', overview?.organisations],
            ['admin.users', overview?.users],
            ['admin.invoicesIssued', overview?.invoices.issued],
            ['admin.payments', overview?.successfulPayments],
            ['admin.failedWebhooks', overview?.webhooks.failed],
          ] as Array<[TranslationKey, number | undefined]>
        ).map(([label, value]) => (
          <Card key={label}>
            <p className="text-sm text-ink-500">{t(label)}</p>
            <p className="money mt-1 text-2xl font-bold text-ink-900">{value ?? 0}</p>
          </Card>
        ))}
      </div>

      <Card>
        <SectionHeading
          title={t('admin.reconciliation')}
          description={t('admin.reconciliationHelp')}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            loading={reconcile.isPending}
            icon={<RefreshCw className="h-4 w-4" />}
            onClick={() => reconcile.mutate()}
          >
            {t('admin.sweepPayments')}
          </Button>
          <Button
            variant="secondary"
            loading={reconcileBalances.isPending}
            icon={<RefreshCw className="h-4 w-4" />}
            onClick={() => reconcileBalances.mutate()}
          >
            {t('admin.verifyBalances')}
          </Button>
        </div>
      </Card>

      <Card padded={false}>
        <div className="px-5 pt-5">
          <SectionHeading
            title={t('admin.webhookInspector')}
            description={t('admin.webhookInspectorHelp')}
          />
        </div>
        {!webhooks || webhooks.data.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-ink-500">{t('admin.noWebhooks')}</p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {webhooks.data.map((event) => (
              <li key={event._id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="money text-sm font-medium text-ink-900">{event.provider}</span>
                    <span className="text-xs text-ink-500">{event.eventType}</span>
                  </div>
                  <p className="truncate text-xs text-ink-400">
                    {new Intl.DateTimeFormat(locale, {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    }).format(new Date(event.createdAt))}
                    {event.attempts > 1
                      ? ` · ${t('admin.deliveries', { count: event.attempts })}`
                      : ''}
                    {event.error ? ` · ${event.error}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {!event.signatureValid && <Badge tone="danger">{t('admin.badSignature')}</Badge>}
                  <Badge
                    tone={
                      event.status === 'PROCESSED'
                        ? 'success'
                        : event.status === 'FAILED'
                          ? 'danger'
                          : 'neutral'
                    }
                  >
                    {event.status}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
