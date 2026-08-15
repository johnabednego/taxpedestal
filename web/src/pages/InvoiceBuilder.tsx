import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Plus, ScrollText, Trash2 } from 'lucide-react'
import dayjs from 'dayjs'
import { ApiError, api, newIdempotencyKey } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useI18n } from '../i18n'
import { formatMoney, inputToQty, parseMoney, qtyToInput, toInputValue } from '../lib/format'
import {
  BackLink,
  Button,
  Card,
  ErrorNotice,
  Input,
  Select,
  Textarea,
  useToast,
} from '../components/ui'

interface ClientOption {
  _id: string
  name: string
  country: string
  defaultCurrency: string
  isBusiness: boolean
  taxId: string | null
}

interface Preview {
  subtotalMinor: number
  discountMinor: number
  taxMinor: number
  totalMinor: number
  taxComponents: Array<{ code: string; label: string; amountMinor: number }>
  taxNotes: string[]
  treatmentLabel: string | null
}

/** Shape of a draft being loaded back into the builder. */
interface LoadedInvoice {
  _id: string
  status: string
  currency: string
  issueDate: string
  dueDate: string
  reference: string | null
  notes: string | null
  client: { _id: string } | null
  lines: Array<{
    _id: string
    description: string
    quantityMilli: number
    unitAmountMinor: number
    supplyType?: LineDraft['supplyType']
  }>
}

interface LineDraft {
  key: string
  description: string
  quantity: string
  unitAmount: string
  supplyType: 'goods' | 'services' | 'digital_services'
}

const emptyLine = (): LineDraft => ({
  key: Math.random().toString(36).slice(2),
  description: '',
  quantity: '1',
  unitAmount: '',
  supplyType: 'services',
})

export default function InvoiceBuilder() {
  // `meta` is read here rather than inside the JSX below: calling a hook from
  // within the render tree happens to work but breaks the moment the call sits
  // behind a condition.
  const { org, meta } = useAuth()
  const { t } = useI18n()
  const navigate = useNavigate()
  const toast = useToast()

  /**
   * Doubles as the draft editor.
   *
   * `PATCH /invoices/:id` and the DRAFT-only guard have always existed on the
   * server; nothing in the interface reached them, so a draft could be created
   * and sent but never corrected. Reusing this component rather than writing a
   * second form keeps one implementation of the line editor and the live tax
   * preview, two places computing a total is how they end up disagreeing.
   */
  const { id: editingId } = useParams<{ id: string }>()
  const isEdit = Boolean(editingId)

  const [clientId, setClientId] = useState('')
  const [currency, setCurrency] = useState(org?.baseCurrency ?? 'USD')
  const [issueDate, setIssueDate] = useState(dayjs().format('YYYY-MM-DD'))
  const [dueDate, setDueDate] = useState(dayjs().add(14, 'day').format('YYYY-MM-DD'))
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()])
  const [discountPercent, setDiscountPercent] = useState('0')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const { data: clients } = useQuery({
    queryKey: ['clients', org?.id, 'picker'],
    queryFn: () => api<{ data: ClientOption[] }>('/api/v1/clients?limit=100'),
    enabled: Boolean(org),
  })

  const selectedClient = clients?.data.find((c) => c._id === clientId)

  /**
   * Load the draft being edited.
   *
   * Only DRAFT invoices are editable, the server rejects anything else, so an
   * issued invoice reached through a hand-typed URL is bounced back to its
   * detail page rather than presented in a form that cannot save.
   */
  const { data: existing } = useQuery({
    queryKey: ['invoice', editingId],
    queryFn: () => api<{ invoice: LoadedInvoice }>(`/api/v1/invoices/${editingId}`),
    enabled: isEdit,
  })

  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    if (!existing || hydrated) return
    const invoice = existing.invoice

    if (invoice.status !== 'DRAFT') {
      toast.push(t('inv.onlyDraftsEditable'), 'warning')
      navigate(`/app/invoices/${invoice._id}`, { replace: true })
      return
    }

    setClientId(invoice.client?._id ?? '')
    setCurrency(invoice.currency)
    setIssueDate(dayjs(invoice.issueDate).format('YYYY-MM-DD'))
    setDueDate(dayjs(invoice.dueDate).format('YYYY-MM-DD'))
    setReference(invoice.reference ?? '')
    setNotes(invoice.notes ?? '')
    setLines(
      invoice.lines.length > 0
        ? invoice.lines.map((line) => ({
            key: line._id,
            description: line.description,
            quantity: qtyToInput(line.quantityMilli),
            unitAmount: toInputValue(line.unitAmountMinor, invoice.currency),
            supplyType: line.supplyType ?? 'services',
          }))
        : [emptyLine()],
    )
    // Guards against the currency effect below clobbering the saved currency
    // before the client list has loaded.
    setHydrated(true)
  }, [existing, hydrated, navigate, t, toast])

  // Adopt the client's preferred currency when one is chosen. Skipped until an
  // edited draft has been hydrated, so loading a draft does not rewrite the
  // currency it was saved with.
  useEffect(() => {
    if (isEdit && !hydrated) return
    if (selectedClient) setCurrency(selectedClient.defaultCurrency)
  }, [selectedClient, isEdit, hydrated])

  const payloadLines = useMemo(
    () =>
      lines
        .filter((line) => line.description.trim() && line.unitAmount.trim())
        .map((line) => ({
          description: line.description.trim(),
          quantityMilli: inputToQty(line.quantity),
          unitAmountMinor: parseMoney(line.unitAmount, currency),
          supplyType: line.supplyType,
        })),
    [lines, currency],
  )

  /**
   * Live preview.
   *
   * Debounced and always computed BY THE SERVER using the same pricing function
   * that will persist the invoice. Recomputing totals in the browser would
   * eventually disagree with the saved figures, a class of bug that erodes
   * trust faster than almost anything else in a billing product.
   */
  useEffect(() => {
    if (!clientId || payloadLines.length === 0) {
      setPreview(null)
      return
    }

    const timer = setTimeout(() => {
      setPreviewing(true)
      void api<Preview>('/api/v1/invoices/preview', {
        method: 'POST',
        body: {
          clientId,
          currency,
          issueDate: dayjs(issueDate).toISOString(),
          lines: payloadLines,
          discountBasisPoints: Math.round((Number(discountPercent) || 0) * 100),
        },
      })
        .then(setPreview)
        .catch(() => setPreview(null))
        .finally(() => setPreviewing(false))
    }, 350)

    return () => clearTimeout(timer)
  }, [clientId, currency, issueDate, payloadLines, discountPercent])

  const updateLine = (key: string, patch: Partial<LineDraft>) =>
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  const save = async (send: boolean) => {
    setSaving(true)
    setError('')
    try {
      const body = {
        clientId,
        currency,
        issueDate: dayjs(issueDate).toISOString(),
        dueDate: dayjs(dueDate).toISOString(),
        lines: payloadLines,
        discountBasisPoints: Math.round((Number(discountPercent) || 0) * 100),
        reference: reference || null,
        notes: notes || null,
      }

      // PATCH is idempotent by nature, so it carries no idempotency key; a
      // replayed key would make a deliberate second correction return the
      // first one's result instead of applying.
      const invoice = isEdit
        ? await api<{ _id: string }>(`/api/v1/invoices/${editingId}`, {
            method: 'PATCH',
            body,
          })
        : await api<{ _id: string }>('/api/v1/invoices', {
            method: 'POST',
            idempotencyKey: newIdempotencyKey(),
            body,
          })

      if (send) {
        await api(`/api/v1/invoices/${invoice._id}/send`, {
          method: 'POST',
          idempotencyKey: newIdempotencyKey(),
          body: { sendEmail: true },
        })
        toast.push(t('inv.sent'), 'success')
      } else {
        toast.push(isEdit ? t('inv.updated') : t('inv.draftSaved'), 'success')
      }

      navigate(`/app/invoices/${invoice._id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('inv.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const canSave = Boolean(clientId) && payloadLines.length > 0

  return (
    <div className="space-y-5">
      {/* Editing returns to the invoice; creating returns to the list. */}
      <BackLink
        to={isEdit ? `/app/invoices/${editingId}` : '/app/invoices'}
        label={isEdit ? t('inv.backToInvoice') : t('inv.allInvoices')}
      />

      <div>
        <h1 className="text-2xl font-bold text-ink-900">
          {isEdit ? t('inv.editTitle') : t('inv.builderTitle')}
        </h1>
        <p className="text-sm text-ink-500">{t('inv.builderSubtitle')}</p>
      </div>

      {error && <ErrorNotice message={error} />}

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-5">
          <Card>
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label={t('inv.client')}
                required
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              >
                <option value="">{t('inv.chooseClient')}</option>
                {clients?.data.map((client) => (
                  <option key={client._id} value={client._id}>
                    {client.name} ({client.country})
                  </option>
                ))}
              </Select>
              <Select
                label={t('auth.currency')}
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {(meta?.currencies ?? []).map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}, {c.name}
                  </option>
                ))}
              </Select>
              <Input
                label={t('inv.issueDate')}
                type="date"
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
              />
              <Input
                label={t('inv.dueDate')}
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </Card>

          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold text-ink-900">{t('inv.lines')}</h2>
              <Button
                size="sm"
                variant="secondary"
                icon={<Plus className="h-3.5 w-3.5" />}
                onClick={() => setLines((c) => [...c, emptyLine()])}
              >
                {t('inv.addLine')}
              </Button>
            </div>

            <div className="space-y-3">
              {lines.map((line, index) => (
                <div
                  key={line.key}
                  className="grid grid-cols-12 items-end gap-2 rounded-lg border border-ink-100 p-3"
                >
                  <div className="col-span-12 sm:col-span-5">
                    <Input
                      label={index === 0 ? t('inv.description') : undefined}
                      value={line.description}
                      onChange={(e) => updateLine(line.key, { description: e.target.value })}
                      placeholder={t('inv.descriptionPlaceholder')}
                    />
                  </div>
                  <div className="col-span-4 sm:col-span-2">
                    <Input
                      label={index === 0 ? t('inv.quantity') : undefined}
                      value={line.quantity}
                      mono
                      inputMode="decimal"
                      onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                    />
                  </div>
                  <div className="col-span-6 sm:col-span-3">
                    <Input
                      label={
                        index === 0 ? t('inv.unitPriceWithCurrency', { currency }) : undefined
                      }
                      value={line.unitAmount}
                      mono
                      inputMode="decimal"
                      placeholder="0.00"
                      onChange={(e) => updateLine(line.key, { unitAmount: e.target.value })}
                    />
                  </div>
                  <div className="col-span-2 flex justify-end pb-1">
                    <button
                      onClick={() =>
                        setLines((c) =>
                          c.length === 1 ? [emptyLine()] : c.filter((l) => l.key !== line.key),
                        )
                      }
                      aria-label={t('inv.removeLine')}
                      className="rounded-lg p-2 text-ink-400 hover:bg-rose-50 hover:text-rose"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label={t('inv.discountPercent')}
                value={discountPercent}
                mono
                inputMode="decimal"
                hint={t('inv.discountHint')}
                onChange={(e) => setDiscountPercent(e.target.value)}
              />
              <Input
                label={t('inv.reference')}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder={t('inv.referencePlaceholder')}
              />
            </div>
            <div className="mt-3">
              <Textarea
                label={t('inv.notes')}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t('inv.notesPlaceholder')}
              />
            </div>
          </Card>
        </div>

        {/* Live totals */}
        <div className="lg:sticky lg:top-6 lg:self-start">
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold text-ink-900">{t('inv.totals')}</h2>
              {previewing && <Loader2 className="h-4 w-4 animate-spin text-ink-400" />}
            </div>

            {!preview ? (
              <p className="py-8 text-center text-sm text-ink-500">{t('inv.previewHint')}</p>
            ) : (
              <div className="space-y-1.5">
                <Row label={t('inv.subtotal')} value={formatMoney(preview.subtotalMinor, currency)} />
                {preview.discountMinor > 0 && (
                  <Row
                    label={t('inv.discount')}
                    value={`−${formatMoney(preview.discountMinor, currency)}`}
                  />
                )}

                {preview.taxComponents.length > 0 ? (
                  preview.taxComponents.map((component) => (
                    <Row
                      key={component.code}
                      label={component.label}
                      value={formatMoney(component.amountMinor, currency)}
                    />
                  ))
                ) : (
                  <Row label={t('inv.tax')} value={formatMoney(0, currency)} />
                )}

                <div className="flex items-baseline justify-between border-t border-ink-200 pt-3">
                  <span className="text-sm font-semibold text-ink-900">{t('inv.total')}</span>
                  <span className="money text-xl font-bold text-ink-900">
                    {formatMoney(preview.totalMinor, currency)}
                  </span>
                </div>

                {preview.taxNotes.length > 0 && (
                  <div className="mt-3 rounded-lg bg-cobalt-50 px-3 py-2">
                    {preview.taxNotes.map((note) => (
                      <p key={note} className="text-xs leading-relaxed text-cobalt-700">
                        <ScrollText className="mr-1 inline h-3 w-3" />
                        {note}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="mt-5 space-y-2">
              <Button
                className="w-full"
                disabled={!canSave}
                loading={saving}
                onClick={() => save(true)}
              >
                {t('inv.sendInvoice')}
              </Button>
              <Button
                variant="secondary"
                className="w-full"
                disabled={!canSave}
                onClick={() => save(false)}
              >
                {isEdit ? t('inv.saveChanges') : t('inv.saveDraft')}
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-ink-500">{label}</span>
      <span className="money text-ink-800">{value}</span>
    </div>
  )
}
