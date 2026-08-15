import { FormEvent, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, FileText, Plus, Search, Users } from 'lucide-react'
import { ApiError, api, newIdempotencyKey } from '../lib/api'
import { useAuth, useCan } from '../lib/auth'
import { useI18n } from '../i18n'
import { REGION_LABEL, REGION_REQUIRED } from '../lib/countries'
import { CountrySelect } from '../components/CountrySelect'
import { formatMoney } from '../lib/format'
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorNotice,
  Input,
  Modal,
  Select,
  StatusBadge,
  Skeleton,
  useToast,
} from '../components/ui'

/* ========================================================================== */
/* Invoices                                                                    */
/* ========================================================================== */

interface InvoiceRow {
  _id: string
  number: string
  status: string
  currency: string
  issueDate: string
  dueDate: string
  totalMinor: number
  amountDueMinor: number
  client: { name: string } | null
}

/** Labels are keys, resolved at render so the filter row follows the language. */
const STATUS_FILTERS = [
  { value: '', label: 'inv.all' },
  { value: 'DRAFT', label: 'inv.drafts' },
  { value: 'SENT,VIEWED,PARTIALLY_PAID', label: 'inv.open' },
  { value: 'OVERDUE', label: 'inv.overdue' },
  { value: 'PAID', label: 'inv.paid' },
] as const

export function Invoices() {
  const { org } = useAuth()
  const { t, formatDate, formatRelativeDays } = useI18n()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['invoices', org?.id, status, search],
    queryFn: () => {
      const params = new URLSearchParams()
      if (status) params.set('status', status)
      if (search) params.set('search', search)
      return api<{ data: InvoiceRow[]; pagination: { total: number } }>(
        `/api/v1/invoices?${params.toString()}`,
      )
    },
    enabled: Boolean(org),
  })

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink-900">{t('inv.title')}</h1>
          <p className="text-sm text-ink-500">
            {t('inv.totalCount', { count: data?.pagination.total ?? 0 })}
          </p>
        </div>
        <Link to="/app/invoices/new">
          <Button icon={<Plus className="h-4 w-4" />}>{t('inv.new')}</Button>
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              onClick={() => setStatus(filter.value)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                status === filter.value
                  ? 'bg-ink-900 text-white'
                  : 'bg-white text-ink-600 hover:bg-ink-100 border border-ink-200'
              }`}
            >
              {t(filter.label)}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('inv.searchPlaceholder')}
            className="h-10 w-full rounded-lg border border-ink-200 bg-white pl-9 pr-3 text-sm placeholder:text-ink-400 focus:border-cobalt focus:outline-none focus:ring-2 focus:ring-cobalt/20 sm:w-64"
          />
        </div>
      </div>

      <Card padded={false}>
        {isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : !data || data.data.length === 0 ? (
          <EmptyState
            icon={<FileText className="h-5 w-5" />}
            title={t('inv.none')}
            description={search || status ? t('inv.noneFiltered') : t('inv.noneHelp')}
            action={
              !search && !status ? (
                <Link to="/app/invoices/new">
                  <Button icon={<Plus className="h-4 w-4" />}>{t('inv.new')}</Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            {/* Desktop table */}
            <table className="hidden w-full sm:table">
              <thead>
                <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
                  <th className="px-4 py-3 font-semibold">{t('inv.number')}</th>
                  <th className="px-4 py-3 font-semibold">{t('inv.client')}</th>
                  <th className="px-4 py-3 font-semibold">{t('inv.due')}</th>
                  <th className="px-4 py-3 text-right font-semibold">{t('inv.total')}</th>
                  <th className="px-4 py-3 text-right font-semibold">{t('inv.dueNow')}</th>
                  <th className="px-4 py-3 font-semibold">{t('inv.status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {data.data.map((invoice) => (
                  <tr key={invoice._id} className="group hover:bg-ink-50">
                    <td className="px-4 py-3">
                      <Link
                        to={`/app/invoices/${invoice._id}`}
                        className="money text-sm font-semibold text-ink-900 group-hover:text-cobalt"
                      >
                        {invoice.number}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-700">
                      {invoice.client?.name ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-500">
                      {formatDate(invoice.dueDate, 'medium')}
                      {invoice.status === 'OVERDUE' && (
                        <span className="ms-1.5 text-xs text-rose">
                          {formatRelativeDays(invoice.dueDate)}
                        </span>
                      )}
                    </td>
                    <td className="money px-4 py-3 text-right text-sm text-ink-700">
                      {formatMoney(invoice.totalMinor, invoice.currency)}
                    </td>
                    <td className="money px-4 py-3 text-right text-sm font-semibold text-ink-900">
                      {formatMoney(invoice.amountDueMinor, invoice.currency)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={invoice.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Mobile cards */}
            <ul className="divide-y divide-ink-100 sm:hidden">
              {data.data.map((invoice) => (
                <li key={invoice._id}>
                  <Link
                    to={`/app/invoices/${invoice._id}`}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="money text-sm font-semibold text-ink-900">{invoice.number}</p>
                      <p className="truncate text-xs text-ink-500">
                        {invoice.client?.name ?? '—'} · {t('inv.due').toLowerCase()}{' '}
                        {formatDate(invoice.dueDate, 'short')}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="money text-sm font-semibold text-ink-900">
                        {formatMoney(invoice.amountDueMinor, invoice.currency)}
                      </p>
                      <StatusBadge status={invoice.status} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  )
}

/* ========================================================================== */
/* Clients                                                                     */
/* ========================================================================== */

interface ClientRow {
  _id: string
  name: string
  email: string | null
  country: string
  isBusiness: boolean
  taxId: string | null
  defaultCurrency: string
  archivedAt: string | null
}

export function Clients() {
  const { org, meta } = useAuth()
  const { t } = useI18n()
  const canEdit = useCan('MEMBER')
  const queryClient = useQueryClient()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['clients', org?.id, search],
    queryFn: () =>
      api<{ data: ClientRow[] }>(
        `/api/v1/clients${search ? `?search=${encodeURIComponent(search)}` : ''}`,
      ),
    enabled: Boolean(org),
  })

  const archive = useMutation({
    mutationFn: (id: string) => api(`/api/v1/clients/${id}/archive`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['clients'] })
      toast.push(t('client.archived'), 'success')
    },
  })

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink-900">{t('client.title')}</h1>
          <p className="text-sm text-ink-500">{t('client.subtitle')}</p>
        </div>
        {canEdit && (
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>
            {t('client.add')}
          </Button>
        )}
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('client.searchPlaceholder')}
          className="h-10 w-full rounded-lg border border-ink-200 bg-white pl-9 pr-3 text-sm placeholder:text-ink-400 focus:border-cobalt focus:outline-none focus:ring-2 focus:ring-cobalt/20 sm:w-72"
        />
      </div>

      <Card padded={false}>
        {isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : !data || data.data.length === 0 ? (
          <EmptyState
            icon={<Users className="h-5 w-5" />}
            title={t('client.none')}
            description={t('client.noneHelp')}
            action={
              canEdit ? (
                <Button onClick={() => setOpen(true)}>{t('client.addFirst')}</Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {data.data.map((client) => (
              <li
                key={client._id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900">{client.name}</p>
                  <p className="truncate text-xs text-ink-500">
                    {client.email ?? t('client.noEmail')} · {client.country} ·{' '}
                    {client.isBusiness ? t('client.business') : t('client.consumer')}
                    {client.taxId ? ` · ${client.taxId}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="money text-xs text-ink-500">{client.defaultCurrency}</span>
                  {canEdit && (
                    <button
                      onClick={() => archive.mutate(client._id)}
                      aria-label={t('client.archiveAria', { name: client.name })}
                      className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                    >
                      <Archive className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ClientModal
        open={open}
        onClose={() => setOpen(false)}
        currencies={meta?.currencies.map((c) => c.code) ?? ['USD']}
        onCreated={() => {
          void queryClient.invalidateQueries({ queryKey: ['clients'] })
          toast.push(t('client.added'), 'success')
          setOpen(false)
        }}
      />
    </div>
  )
}

function ClientModal({
  open,
  onClose,
  currencies,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  currencies: string[]
  onCreated: () => void
}) {
  const { org } = useAuth()
  const { t } = useI18n()
  const [form, setForm] = useState({
    name: '',
    email: '',
    country: org?.country ?? 'GH',
    region: '',
    isBusiness: true,
    taxId: '',
    taxRegistered: false,
    defaultCurrency: org?.baseCurrency ?? 'USD',
  })
  const [error, setError] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  const set = (key: keyof typeof form, value: string | boolean) =>
    setForm((current) => ({ ...current, [key]: value }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    setFields({})
    try {
      await api('/api/v1/clients', {
        method: 'POST',
        // A retried create cannot duplicate the client.
        idempotencyKey: newIdempotencyKey(),
        body: {
          ...form,
          email: form.email || null,
          taxId: form.taxId || null,
          region: form.region || null,
        },
      })
      onCreated()
      setForm({ ...form, name: '', email: '', taxId: '' })
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
        setFields(err.fieldErrors)
      } else setError(t('client.saveFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  // Only where a sub-national code changes the tax answer.
  const needsRegion = REGION_REQUIRED.has(form.country)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('client.addTitle')}
      description={t('client.addDescription')}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button onClick={submit} loading={submitting}>
            {t('client.add')}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorNotice message={error} />}

        <Input
          label={t('client.name')}
          required
          value={form.name}
          error={fields.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="Acme Ltd"
        />
        <Input
          label={t('client.billingEmail')}
          type="email"
          value={form.email}
          error={fields.email}
          hint={t('client.emailHint')}
          onChange={(e) => set('email', e.target.value)}
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <CountrySelect
            value={form.country}
            error={fields.country}
            showTaxHint={false}
            hint={t('client.countryHint')}
            onChange={(code) => set('country', code)}
          />
          {needsRegion ? (
            <Input
              label={REGION_LABEL[form.country] ?? t('client.region')}
              value={form.region}
              error={fields.region}
              hint={t('client.regionHint')}
              onChange={(e) => set('region', e.target.value.toUpperCase())}
            />
          ) : (
            <Select
              label={t('client.currency')}
              value={form.defaultCurrency}
              onChange={(e) => set('defaultCurrency', e.target.value)}
            >
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          )}
        </div>

        {needsRegion && (
          <Select
            label={t('client.currency')}
            value={form.defaultCurrency}
            onChange={(e) => set('defaultCurrency', e.target.value)}
          >
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
        )}

        <div className="space-y-2.5 rounded-lg bg-ink-50 p-3">
          <Checkbox
            label={t('client.isBusiness')}
            description={t('client.isBusinessHelp')}
            checked={form.isBusiness}
            onChange={(e) => set('isBusiness', e.target.checked)}
          />
          <Checkbox
            label={t('client.taxRegistered')}
            checked={form.taxRegistered}
            onChange={(e) => set('taxRegistered', e.target.checked)}
          />
          <Input
            label={t('client.taxId')}
            value={form.taxId}
            error={fields.taxId}
            hint={t('client.taxIdHint')}
            onChange={(e) => set('taxId', e.target.value)}
            placeholder="DE123456789"
            mono
          />
        </div>
      </form>
    </Modal>
  )
}
