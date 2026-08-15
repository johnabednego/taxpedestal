import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, ShieldAlert } from 'lucide-react'
import dayjs from 'dayjs'
import { api } from '../lib/api'
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
        `Scanned ${report.scanned}, settled ${report.settled}`,
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
        `Checked ${report.checked}, drift ${report.drifted}, repaired ${report.repaired}`,
        report.drifted > 0 ? 'warning' : 'success',
      ),
  })

  if (isLoading) return <Skeleton className="h-96" />

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-5 w-5 text-cobalt" />
        <h1 className="text-2xl font-bold text-ink-900">Admin console</h1>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ['Workspaces', overview?.organisations],
          ['Users', overview?.users],
          ['Invoices issued', overview?.invoices.issued],
          ['Payments', overview?.successfulPayments],
          ['Failed webhooks', overview?.webhooks.failed],
        ].map(([label, value]) => (
          <Card key={String(label)}>
            <p className="text-sm text-ink-500">{label}</p>
            <p className="money mt-1 text-2xl font-bold text-ink-900">{value ?? 0}</p>
          </Card>
        ))}
      </div>

      <Card>
        <SectionHeading
          title="Reconciliation"
          description="Recover payments whose webhook never arrived, and verify balances against the ledger."
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            loading={reconcile.isPending}
            icon={<RefreshCw className="h-4 w-4" />}
            onClick={() => reconcile.mutate()}
          >
            Sweep pending payments
          </Button>
          <Button
            variant="secondary"
            loading={reconcileBalances.isPending}
            icon={<RefreshCw className="h-4 w-4" />}
            onClick={() => reconcileBalances.mutate()}
          >
            Verify ledger balances
          </Button>
        </div>
      </Card>

      <Card padded={false}>
        <div className="px-5 pt-5">
          <SectionHeading
            title="Webhook inspector"
            description="What your system did with each provider event — not just what they sent."
          />
        </div>
        {!webhooks || webhooks.data.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-ink-500">No webhook events recorded yet.</p>
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
                    {dayjs(event.createdAt).format('D MMM HH:mm')}
                    {event.attempts > 1 ? ` · ${event.attempts} deliveries` : ''}
                    {event.error ? ` · ${event.error}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {!event.signatureValid && <Badge tone="danger">Bad signature</Badge>}
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
