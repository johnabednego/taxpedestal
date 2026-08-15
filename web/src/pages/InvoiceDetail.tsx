import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Ban,
  BellRing,
  Check,
  Clock,
  Copy,
  Download,
  Loader2,
  Pencil,
  Send,
  Smartphone,
  Trash2,
  Wallet,
} from 'lucide-react'
import { ApiError, api, apiUrl, getAccessToken, newIdempotencyKey } from '../lib/api'
import { useCan } from '../lib/auth'
import { useI18n } from '../i18n'
import { ComplianceNotice, type ComplianceData } from '../components/ComplianceNotice'
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { formatMoney, parseMoney } from '../lib/format'
import {
  Badge,
  BackLink,
  Button,
  Card,
  ErrorNotice,
  Input,
  Modal,
  SectionHeading,
  Select,
  StatusBadge,
  Skeleton,
  useToast,
} from '../components/ui'

/* ========================================================================== */
/* Invoice detail                                                              */
/* ========================================================================== */

interface InvoiceDetailData {
  invoice: {
    _id: string
    number: string
    status: string
    currency: string
    issueDate: string
    dueDate: string
    reference: string | null
    notes: string | null
    lines: Array<{
      _id: string
      description: string
      quantityMilli: number
      unitAmountMinor: number
      netMinor: number
      taxMinor: number
      totalMinor: number
    }>
    subtotalMinor: number
    discountMinor: number
    taxMinor: number
    totalMinor: number
    amountPaidMinor: number
    amountDueMinor: number
    taxSnapshot: {
      components: Array<{ code: string; label: string; amountMinor: number }>
      notes: string[]
    }
    client: { name: string; email: string | null; country: string } | null
  }
  payments: Array<{
    _id: string
    amountMinor: number
    currency: string
    status: string
    method: string
    channelDetail: string | null
    paidAt: string | null
    provider: string
  }>
  ledger: Array<{
    _id: string
    type: string
    amountMinor: number
    description: string
    createdAt: string
  }>
  publicUrl: string
  treatmentLabel: string | null
  compliance: ComplianceData | null
}

export function InvoiceDetail() {
  const { id } = useParams<{ id: string }>()
  const { t, tOr, locale, formatDate } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useToast()
  const canEdit = useCan('MEMBER')
  const canAdmin = useCan('ADMIN')
  const [payOpen, setPayOpen] = useState(false)
  const [voidOpen, setVoidOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  /** Payment id awaiting a rejection reason, or null. */
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const { data, isLoading, error } = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => api<InvoiceDetailData>(`/api/v1/invoices/${id}`),
    enabled: Boolean(id),
  })

  const send = useMutation({
    mutationFn: () =>
      api(`/api/v1/invoices/${id}/send`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: { sendEmail: true },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['invoice', id] })
      toast.push(t('inv.sent'), 'success')
    },
    onError: (e) => toast.push(e instanceof ApiError ? e.message : t('inv.couldNotSend'), 'danger'),
  })

  const remind = useMutation({
    mutationFn: () => api(`/api/v1/invoices/${id}/remind`, { method: 'POST' }),
    onSuccess: () => toast.push(t('inv.reminderSent'), 'success'),
    onError: (e) => toast.push(e instanceof ApiError ? e.message : t('inv.couldNotRemind'), 'danger'),
  })

  const remove = useMutation({
    mutationFn: () => api(`/api/v1/invoices/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.push(t('inv.deleted'), 'success')
      void queryClient.invalidateQueries({ queryKey: ['invoices'] })
      navigate('/app/invoices')
    },
    onError: (e) => toast.push(e instanceof ApiError ? e.message : t('inv.deleteFailed'), 'danger'),
  })

  /**
   * Resolve a bank transfer the customer declared on the public page.
   *
   * This closes a loop that was previously open at the supplier's end: the
   * payment page could create a PENDING manual payment, and the confirm and
   * reject endpoints existed, but nothing in the interface listed a pending
   * payment or called them. A customer could say "I've paid" and the invoice
   * would stay unpaid with no way to act on it.
   *
   * Confirming is what credits the invoice, deliberately a human decision,
   * because an unauthenticated web page must never be able to clear a debt.
   */
  const confirmPayment = useMutation({
    mutationFn: (paymentId: string) =>
      api(`/api/v1/invoices/${id}/payments/${paymentId}/confirm`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['invoice', id] })
      toast.push(t('pay.confirmed'), 'success')
    },
    onError: (e) => toast.push(e instanceof ApiError ? e.message : t('pay.confirmFailed'), 'danger'),
  })

  const rejectPayment = useMutation({
    mutationFn: ({ paymentId, reason }: { paymentId: string; reason: string }) =>
      api(`/api/v1/invoices/${id}/payments/${paymentId}/reject`, {
        method: 'POST',
        body: { reason: reason || undefined },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['invoice', id] })
      toast.push(t('pay.rejected'), 'success')
    },
    onError: (e) => toast.push(e instanceof ApiError ? e.message : t('error.generic'), 'danger'),
  })

  if (isLoading) return <Skeleton className="h-96" />
  if (error || !data) return <ErrorNotice message={t('inv.loadFailed')} />

  const { invoice } = data
  const isDraft = invoice.status === 'DRAFT'
  const isOpen = !['PAID', 'VOID', 'DRAFT'].includes(invoice.status)

  // Only manual payments can be confirmed by hand; gateway payments settle
  // through their webhook, and the server rejects confirming those.
  const pendingPayments = data.payments.filter(
    (payment) => payment.status === 'PENDING' && payment.provider === 'MANUAL',
  )

  /**
   * Download the PDF.
   *
   * Fetched with the Authorization header rather than opened as a plain link:
   * the access token lives in memory, not a cookie, so a bare <a href> would
   * arrive unauthenticated and 401.
   */
  const downloadPdf = async () => {
    try {
      const response = await fetch(`${apiUrl}/api/v1/invoices/${id}/pdf`, {
        headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
        credentials: 'include',
      })
      if (!response.ok) throw new Error('Download failed')

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${invoice.number}.pdf`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.push(t('inv.downloadFailed'), 'danger')
    }
  }

  const copyLink = async () => {
    await navigator.clipboard.writeText(data.publicUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-5">
      <BackLink to="/app/invoices" label={t('inv.allInvoices')} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="money text-2xl font-bold text-ink-900">{invoice.number}</h1>
            <StatusBadge status={invoice.status} />
          </div>
          <p className="mt-0.5 text-sm text-ink-500">
            {invoice.client?.name} · {t('inv.due').toLowerCase()}{' '}
            {formatDate(invoice.dueDate, 'medium')}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {!isDraft && (
            <>
              <Button
                variant="secondary"
                size="sm"
                icon={<Download className="h-3.5 w-3.5" />}
                onClick={downloadPdf}
              >
                {t('inv.pdf')}
              </Button>
              <Button variant="secondary" size="sm" onClick={copyLink} icon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}>
                {copied ? t('action.copied') : t('inv.copyPayLink')}
              </Button>
            </>
          )}
          {isDraft && canEdit && (
            <>
              <Link to={`/app/invoices/${id}/edit`}>
                <Button variant="secondary" size="sm" icon={<Pencil className="h-3.5 w-3.5" />}>
                  {t('inv.edit')}
                </Button>
              </Link>
              <Button size="sm" loading={send.isPending} icon={<Send className="h-3.5 w-3.5" />} onClick={() => send.mutate()}>
                {t('action.send')}
              </Button>
            </>
          )}
          {/* Deleting is confined to drafts by the server; an issued invoice is
              voided so the record survives. ADMIN-only, matching the API. */}
          {isDraft && canAdmin && (
            <Button
              variant="ghost"
              size="sm"
              loading={remove.isPending}
              icon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => {
                if (window.confirm(t('inv.deleteConfirm', { number: invoice.number }))) {
                  remove.mutate()
                }
              }}
            >
              {t('inv.delete')}
            </Button>
          )}
          {isOpen && canEdit && (
            <>
              <Button variant="secondary" size="sm" loading={remind.isPending} icon={<BellRing className="h-3.5 w-3.5" />} onClick={() => remind.mutate()}>
                {t('inv.remind')}
              </Button>
              <Button size="sm" onClick={() => setPayOpen(true)}>
                {t('inv.recordPayment')}
              </Button>
            </>
          )}
          {invoice.status !== 'VOID' && invoice.amountPaidMinor === 0 && canAdmin && (
            <Button variant="ghost" size="sm" icon={<Ban className="h-3.5 w-3.5" />} onClick={() => setVoidOpen(true)}>
              {t('inv.void')}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        {/* Document */}
        <Card>
          <table className="w-full">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="pb-2 font-semibold">Description</th>
                <th className="pb-2 text-right font-semibold">Qty</th>
                <th className="pb-2 text-right font-semibold">Unit</th>
                <th className="pb-2 text-right font-semibold">{t('inv.amount')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {invoice.lines.map((line) => (
                <tr key={line._id}>
                  <td className="py-2.5 text-sm text-ink-800">{line.description}</td>
                  <td className="money py-2.5 text-right text-sm text-ink-600">
                    {line.quantityMilli / 1000}
                  </td>
                  <td className="money py-2.5 text-right text-sm text-ink-600">
                    {formatMoney(line.unitAmountMinor, invoice.currency)}
                  </td>
                  <td className="money py-2.5 text-right text-sm font-medium text-ink-900">
                    {formatMoney(line.netMinor, invoice.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4 space-y-1.5 border-t border-ink-100 pt-4">
            <SummaryRow label={t('inv.subtotal')} value={formatMoney(invoice.subtotalMinor, invoice.currency)} />
            {invoice.discountMinor > 0 && (
              <SummaryRow label={t('inv.discount')} value={`−${formatMoney(invoice.discountMinor, invoice.currency)}`} />
            )}
            {invoice.taxSnapshot.components.map((component) => (
              <SummaryRow
                key={component.code}
                label={component.label}
                value={formatMoney(component.amountMinor, invoice.currency)}
              />
            ))}
            <div className="flex items-baseline justify-between border-t border-ink-200 pt-2.5">
              <span className="text-sm font-semibold text-ink-900">{t('inv.total')}</span>
              <span className="money text-xl font-bold text-ink-900">
                {formatMoney(invoice.totalMinor, invoice.currency)}
              </span>
            </div>
            {invoice.amountPaidMinor > 0 && (
              <>
                <SummaryRow label={t('inv.amountPaid')} value={`−${formatMoney(invoice.amountPaidMinor, invoice.currency)}`} />
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-semibold text-ink-900">{t('inv.stillDue')}</span>
                  <span className="money text-lg font-bold text-cobalt">
                    {formatMoney(invoice.amountDueMinor, invoice.currency)}
                  </span>
                </div>
              </>
            )}
          </div>

          {invoice.taxSnapshot.notes.length > 0 && (
            <div className="mt-4 rounded-lg bg-ink-50 px-3 py-2">
              {invoice.taxSnapshot.notes.map((note) => (
                <p key={note} className="text-xs text-ink-600">{note}</p>
              ))}
            </div>
          )}
          {invoice.notes && (
            <p className="mt-4 whitespace-pre-wrap text-sm text-ink-600">{invoice.notes}</p>
          )}
        </Card>

        {/* Ledger and compliance */}
        <div className="space-y-5">
          {/* Declared transfers, first: this is the one thing on the page that
              is waiting on the user rather than reporting to them. */}
          {pendingPayments.length > 0 && canEdit && (
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <Clock className="h-4 w-4 text-amber" />
                <h2 className="text-base font-semibold text-ink-900">{t('pay.pendingTitle')}</h2>
              </div>
              <p className="mb-4 text-sm leading-relaxed text-ink-600">{t('pay.pendingHelp')}</p>

              <ul className="space-y-3">
                {pendingPayments.map((payment) => (
                  <li
                    key={payment._id}
                    className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="money text-sm font-semibold text-ink-900">
                          {formatMoney(payment.amountMinor, payment.currency)}
                        </p>
                        <p className="text-xs text-ink-500">
                          {payment.channelDetail ??
                            tOr(`method.${payment.method}`, payment.method)}
                          {payment.paidAt
                            ? ` · ${t('pay.declaredOn', {
                                date: formatDate(payment.paidAt, 'medium'),
                              })}`
                            : ''}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRejecting(payment._id)}
                        >
                          {t('pay.reject')}
                        </Button>
                        <Button
                          size="sm"
                          loading={
                            confirmPayment.isPending && confirmPayment.variables === payment._id
                          }
                          onClick={() => confirmPayment.mutate(payment._id)}
                        >
                          {t('pay.confirmReceipt')}
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <ComplianceNotice compliance={data.compliance} />
          <Card>
            <SectionHeading
              title={t('inv.ledger')}
              description={t('inv.ledgerSubtitle')}
            />
            {data.ledger.length === 0 ? (
              <p className="py-4 text-center text-sm text-ink-500">{t('inv.nothingRecorded')}</p>
            ) : (
              <ul className="space-y-2.5">
                {data.ledger.map((entry) => (
                  <li key={entry._id} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Badge tone={entry.amountMinor < 0 ? 'success' : 'neutral'}>
                          {tOr(`ledger.${entry.type}`, entry.type)}
                        </Badge>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-ink-500">{entry.description}</p>
                      <p className="text-2xs text-ink-400">
                        {new Intl.DateTimeFormat(locale, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }).format(new Date(entry.createdAt))}
                      </p>
                    </div>
                    <span
                      className={`money shrink-0 text-sm font-semibold ${
                        entry.amountMinor < 0 ? 'text-jade' : 'text-ink-900'
                      }`}
                    >
                      {formatMoney(entry.amountMinor, invoice.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {data.payments.length > 0 && (
            <Card>
              <SectionHeading title={t('inv.payments')} />
              <ul className="divide-y divide-ink-100">
                {data.payments.map((payment) => (
                  <li key={payment._id} className="flex items-center justify-between py-2">
                    <div>
                      <p className="text-sm text-ink-800">
                        {payment.channelDetail ??
                          tOr(`method.${payment.method}`, payment.method.replace('_', ' ').toLowerCase())}
                      </p>
                      <p className="text-xs text-ink-500">
                        {payment.provider} ·{' '}
                        {payment.paidAt ? formatDate(payment.paidAt, 'short') : payment.status}
                      </p>
                    </div>
                    <span className="money text-sm font-medium">
                      {formatMoney(payment.amountMinor, payment.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <RecordPaymentModal
        open={payOpen}
        onClose={() => setPayOpen(false)}
        invoiceId={invoice._id}
        currency={invoice.currency}
        amountDueMinor={invoice.amountDueMinor}
        onDone={() => {
          void queryClient.invalidateQueries({ queryKey: ['invoice', id] })
          toast.push('Payment recorded', 'success')
          setPayOpen(false)
        }}
      />

      <VoidModal
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        invoiceId={invoice._id}
        onDone={() => {
          void queryClient.invalidateQueries({ queryKey: ['invoice', id] })
          toast.push(t('inv.voided'), 'success')
          setVoidOpen(false)
        }}
      />

      <Modal
        open={rejecting !== null}
        onClose={() => {
          setRejecting(null)
          setRejectReason('')
        }}
        title={t('pay.rejectTitle')}
        description={t('pay.rejectDescription')}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setRejecting(null)
                setRejectReason('')
              }}
            >
              {t('action.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={rejectPayment.isPending}
              onClick={() => {
                if (!rejecting) return
                rejectPayment.mutate(
                  { paymentId: rejecting, reason: rejectReason },
                  {
                    onSettled: () => {
                      setRejecting(null)
                      setRejectReason('')
                    },
                  },
                )
              }}
            >
              {t('pay.reject')}
            </Button>
          </>
        }
      >
        <Input
          label={t('pay.rejectReason')}
          value={rejectReason}
          hint={t('pay.rejectReasonHint')}
          onChange={(e) => setRejectReason(e.target.value)}
        />
      </Modal>
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-ink-500">{label}</span>
      <span className="money text-ink-700">{value}</span>
    </div>
  )
}

function RecordPaymentModal({
  open,
  onClose,
  invoiceId,
  currency,
  amountDueMinor,
  onDone,
}: {
  open: boolean
  onClose: () => void
  invoiceId: string
  currency: string
  amountDueMinor: number
  onDone: () => void
}) {
  const { t } = useI18n()
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('BANK_TRANSFER')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) setAmount(String(amountDueMinor / 100))
  }, [open, amountDueMinor])

  const submit = async () => {
    setSaving(true)
    setError('')
    try {
      await api(`/api/v1/invoices/${invoiceId}/payments`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: { amountMinor: parseMoney(amount, currency), method },
      })
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('inv.recordFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('inv.recordPaymentTitle')}
      description={t('inv.recordPaymentDescription')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('action.cancel')}</Button>
          <Button onClick={submit} loading={saving}>{t('inv.record')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <ErrorNotice message={error} />}
        <Input
          label={t('inv.amountWithCurrency', { currency })}
          value={amount}
          mono
          inputMode="decimal"
          onChange={(e) => setAmount(e.target.value)}
          hint={t('inv.outstanding', { amount: formatMoney(amountDueMinor, currency) })}
        />
        <Select label={t('inv.method')} value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="BANK_TRANSFER">{t('method.BANK_TRANSFER')}</option>
          <option value="CASH">{t('method.CASH')}</option>
          <option value="CHEQUE">{t('method.CHEQUE')}</option>
          <option value="MOBILE_MONEY">{t('method.MOBILE_MONEY')}</option>
          <option value="OTHER">{t('method.OTHER')}</option>
        </Select>
      </div>
    </Modal>
  )
}

function VoidModal({
  open,
  onClose,
  invoiceId,
  onDone,
}: {
  open: boolean
  onClose: () => void
  invoiceId: string
  onDone: () => void
}) {
  const { t } = useI18n()
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    setSaving(true)
    setError('')
    try {
      await api(`/api/v1/invoices/${invoiceId}/void`, { method: 'POST', body: { reason } })
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not void the invoice')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('inv.voidTitle')}
      description={t('inv.voidDescription')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="danger" onClick={submit} loading={saving} disabled={reason.trim().length < 3}>
            {t('inv.voidInvoice')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <ErrorNotice message={error} />}
        <Input
          label={t('inv.voidReason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Duplicate of NWS-0041"
          hint={t('inv.voidReasonHint')}
        />
      </div>
    </Modal>
  )
}

/* ========================================================================== */
/* Public payment page                                                         */
/* ========================================================================== */

interface PublicData {
  invoice: {
    number: string
    status: string
    currency: string
    dueDate: string
    lines: Array<{ description: string; quantityMilli: number; netMinor: number }>
    subtotalMinor: number
    discountMinor: number
    totalMinor: number
    amountDueMinor: number
    taxComponents: Array<{ code: string; label: string; amountMinor: number }>
    taxNotes: string[]
    notes: string | null
    formatted: { amountDue: string; total: string }
    supplier: { name: string; brandColor: string; country: string; taxId: string | null }
    customer: { name: string; country: string }
  }
  payment: {
    rails: Array<{ providerId: string; displayName: string; methods: string[]; recommended: boolean }>
    bankTransfer: {
      accountName: string | null
      bankName: string | null
      accountNumber: string | null
      routingCode: string | null
      swiftBic: string | null
      mobileMoneyNumber: string | null
      mobileMoneyProvider: string | null
      additionalDetails: string | null
      reference: string
    } | null
  }
}

export function PublicInvoice() {
  const { token } = useParams<{ token: string }>()
  const { t, formatDate } = useI18n()
  const [paying, setPaying] = useState(false)
  const [error, setError] = useState('')
  const [otpMessage, setOtpMessage] = useState('')
  const [phone, setPhone] = useState('')
  const [network, setNetwork] = useState('mtn')

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['public-invoice', token],
    queryFn: () => api<PublicData>(`/api/v1/public/invoices/${token}`, { anonymous: true }),
    enabled: Boolean(token),
  })

  if (isLoading) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <Skeleton className="h-96" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="text-center">
          <h1 className="text-xl font-semibold text-ink-900">{t('pay.notFound')}</h1>
          <p className="mt-1 text-sm text-ink-500">{t('pay.notFoundHelp')}</p>
        </div>
      </div>
    )
  }

  const { invoice, payment } = data
  const settled = invoice.amountDueMinor <= 0

  const startCheckout = async (providerId: string, useMobileMoney: boolean) => {
    setPaying(true)
    setError('')
    setOtpMessage('')
    try {
      const result = await api<{
        action: string
        redirectUrl: string | null
        instruction: string | null
      }>(`/api/v1/public/invoices/${token}/checkout`, {
        method: 'POST',
        anonymous: true,
        body: {
          providerId,
          mobileMoney: useMobileMoney ? { phone, provider: network } : null,
        },
      })

      if (result.action === 'redirect' && result.redirectUrl) {
        window.location.href = result.redirectUrl
        return
      }
      if (result.action === 'otp') {
        setOtpMessage(result.instruction ?? 'Approve the prompt on your phone.')
        // Poll for the webhook to land.
        const interval = setInterval(() => void refetch(), 4000)
        setTimeout(() => clearInterval(interval), 120_000)
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the payment')
    } finally {
      setPaying(false)
    }
  }

  return (
    <div className="min-h-screen bg-ink-50 py-8 px-4">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="flex justify-end">
          <LanguageSwitcher compact />
        </div>

        <div className="text-center">
          <p className="font-display text-lg font-bold text-ink-900">{invoice.supplier.name}</p>
          <p className="text-sm text-ink-500">
            {t('pay.sentYou', { name: invoice.supplier.name, number: invoice.number })}
          </p>
        </div>

        <Card>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-ink-500">
                {settled ? t('pay.paidInFull') : t('pay.amountDue')}
              </p>
              <p className="money mt-1 text-3xl font-bold text-ink-900">
                {invoice.formatted.amountDue}
              </p>
              {!settled && (
                <p className="mt-1 text-sm text-ink-500">
                  {t('pay.dueOn', { date: formatDate(invoice.dueDate, 'long') })}
                </p>
              )}
            </div>
            {settled && (
              <div className="animate-stamp-in rotate-[-12deg] rounded-lg border-2 border-jade px-3 py-1 shadow-stamp">
                <span className="text-sm font-bold uppercase tracking-wide text-jade">Paid</span>
              </div>
            )}
          </div>

          <div className="mt-5 border-t border-ink-100 pt-4">
            {invoice.lines.map((line, index) => (
              <div key={index} className="flex justify-between py-1.5 text-sm">
                <span className="text-ink-700">
                  {line.description}
                  <span className="ml-1.5 text-ink-400">×{line.quantityMilli / 1000}</span>
                </span>
                <span className="money text-ink-900">
                  {formatMoney(line.netMinor, invoice.currency)}
                </span>
              </div>
            ))}

            <div className="mt-2 space-y-1 border-t border-ink-100 pt-2">
              <SummaryRow label={t('inv.subtotal')} value={formatMoney(invoice.subtotalMinor, invoice.currency)} />
              {invoice.taxComponents.map((c) => (
                <SummaryRow key={c.code} label={c.label} value={formatMoney(c.amountMinor, invoice.currency)} />
              ))}
              <div className="flex items-baseline justify-between border-t border-ink-200 pt-2">
                <span className="text-sm font-semibold">{t('inv.total')}</span>
                <span className="money text-lg font-bold">{invoice.formatted.total}</span>
              </div>
            </div>
          </div>

          {invoice.taxNotes.length > 0 && (
            <div className="mt-3 rounded-lg bg-ink-50 px-3 py-2">
              {invoice.taxNotes.map((note) => (
                <p key={note} className="text-xs text-ink-600">{note}</p>
              ))}
            </div>
          )}
        </Card>

        {!settled && payment.bankTransfer && (
          <BankTransferCard
            details={payment.bankTransfer}
            amount={invoice.formatted.amountDue}
            token={token!}
            onDeclared={() => void refetch()}
          />
        )}

        {!settled && payment.rails.length > 0 && (
          <Card>
            <SectionHeading title={t('pay.payByCard')} />
            {error && <ErrorNotice message={error} />}

            {otpMessage ? (
              <div className="rounded-lg bg-cobalt-50 px-4 py-4 text-center">
                <Loader2 className="mx-auto h-5 w-5 animate-spin text-cobalt" />
                <p className="mt-2 text-sm font-medium text-cobalt-700">{otpMessage}</p>
                <p className="mt-1 text-xs text-cobalt-700">{t('pay.updatesAutomatically')}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {payment.rails.map((rail) => {
                  const supportsMomo = rail.methods.includes('MOBILE_MONEY')
                  return (
                    <div key={rail.providerId} className="rounded-lg border border-ink-200 p-3">
                      <div className="flex items-center gap-2">
                        {supportsMomo ? (
                          <Smartphone className="h-4 w-4 text-ink-500" />
                        ) : (
                          <Wallet className="h-4 w-4 text-ink-500" />
                        )}
                        <span className="text-sm font-medium text-ink-900">
                          {rail.displayName}
                        </span>
                        {rail.recommended && <Badge tone="info">{t('pay.recommended')}</Badge>}
                      </div>

                      {supportsMomo && (
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          <Input
                            label={t('pay.mobileMoneyNumber')}
                            value={phone}
                            mono
                            inputMode="tel"
                            placeholder="024 123 4567"
                            onChange={(e) => setPhone(e.target.value)}
                          />
                          <Select
                            label={t('pay.network')}
                            value={network}
                            onChange={(e) => setNetwork(e.target.value)}
                          >
                            <option value="mtn">MTN</option>
                            <option value="vod">Telecel</option>
                            <option value="atl">AirtelTigo</option>
                          </Select>
                        </div>
                      )}

                      <Button
                        className="mt-3 w-full"
                        loading={paying}
                        disabled={supportsMomo && phone.trim().length < 6}
                        onClick={() => startCheckout(rail.providerId, supportsMomo)}
                      >
                        Pay {invoice.formatted.amountDue}
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        )}

        {/* Secondary to paying, so it stays muted rather than competing with
            the pay button above it. */}
        <div className="text-center">
          <a
            href={`${apiUrl}/api/v1/public/invoices/${token}/pdf`}
            className="inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-900"
          >
            <Download className="h-3.5 w-3.5" />
            {t('pay.downloadPdf')}
          </a>
        </div>

        <p className="pb-8 text-center text-xs text-ink-400">
          {t('pay.securedBy')} · {invoice.supplier.country}
          {invoice.supplier.taxId ? ` · ${invoice.supplier.taxId}` : ''}
        </p>
      </div>
    </div>
  )
}

/**
 * Bank transfer, the rail that works in every country on earth.
 *
 * Card gateways onboard merchants in roughly fifty countries. For everyone
 * else this IS the payment method, so it is presented as a first-class option
 * rather than a footnote: the details are copyable, the reference is
 * pre-filled, and the customer can tell the supplier the transfer is on its
 * way.
 *
 * Declaring a transfer does NOT mark the invoice paid, an unauthenticated
 * page must never be able to clear a debt. The supplier confirms once the
 * money lands.
 */
function BankTransferCard({
  details,
  amount,
  token,
  onDeclared,
}: {
  details: NonNullable<PublicData['payment']['bankTransfer']>
  amount: string
  token: string
  onDeclared: () => void
}) {
  const [declaring, setDeclaring] = useState(false)
  const [declared, setDeclared] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const { t } = useI18n()

  const rows: Array<[string, string | null]> = [
    ['Account name', details.accountName],
    ['Bank', details.bankName],
    ['Account number', details.accountNumber],
    ['IBAN / routing', details.routingCode],
    ['SWIFT / BIC', details.swiftBic],
    [
      details.mobileMoneyProvider ? `${details.mobileMoneyProvider} number` : 'Mobile money',
      details.mobileMoneyNumber,
    ],
    ['Reference', details.reference],
  ]

  const copy = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value)
    setCopied(label)
    setTimeout(() => setCopied(null), 1600)
  }

  const declare = async () => {
    setDeclaring(true)
    setError('')
    try {
      const result = await api<{ message: string }>(
        `/api/v1/public/invoices/${token}/declare-transfer`,
        { method: 'POST', anonymous: true, body: {} },
      )
      setDeclared(result.message)
      onDeclared()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not notify the sender')
    } finally {
      setDeclaring(false)
    }
  }

  return (
    <Card>
      <SectionHeading
        title={t('pay.payByTransfer')}
        description={t('pay.transferInstruction', { amount })}
      />

      <dl className="divide-y divide-ink-100 rounded-lg border border-ink-200">
        {rows
          .filter(([, value]) => Boolean(value))
          .map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <dt className="text-xs text-ink-500">{label}</dt>
              <dd className="flex items-center gap-2">
                <span className="money text-sm font-medium text-ink-900">{value}</span>
                <button
                  onClick={() => void copy(label, value as string)}
                  aria-label={`Copy ${label}`}
                  className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                >
                  {copied === label ? (
                    <Check className="h-3.5 w-3.5 text-jade" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
              </dd>
            </div>
          ))}
      </dl>

      {details.additionalDetails && (
        <p className="mt-3 whitespace-pre-wrap rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
          {details.additionalDetails}
        </p>
      )}

      {error && (
        <div className="mt-3">
          <ErrorNotice message={error} />
        </div>
      )}

      {declared ? (
        <div className="mt-4 rounded-lg bg-jade-50 px-4 py-3">
          <p className="text-sm font-medium text-jade-700">{declared}</p>
        </div>
      ) : (
        <Button variant="secondary" className="mt-4 w-full" loading={declaring} onClick={declare}>
          {t('pay.madeTransfer')}
        </Button>
      )}
      <p className="mt-2 text-center text-xs text-ink-400">{t('pay.senderConfirms')}</p>
    </Card>
  )
}
