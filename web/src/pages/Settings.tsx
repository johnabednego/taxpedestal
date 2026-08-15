import { FormEvent, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useQuery as useCapabilityQuery } from '@tanstack/react-query'
import { ApiError, api } from '../lib/api'
import { useAuth, useCan } from '../lib/auth'
import { CountrySelect } from '../components/CountrySelect'
import {
  Button,
  Card,
  Checkbox,
  ErrorNotice,
  Input,
  SectionHeading,
  Select,
  Textarea,
  Skeleton,
  useToast,
} from '../components/ui'

interface OrgSettings {
  name: string
  legalName: string | null
  country: string
  region: string | null
  city: string | null
  addressLine1: string | null
  email: string | null
  phone: string | null
  website: string | null
  brandColor: string
  baseCurrency: string
  taxRegistered: boolean
  taxId: string | null
  customTaxProfile: {
    enabled: boolean
    overrideBuiltIn: boolean
    components: Array<{ code: string; label: string; basisPoints: number }>
    zeroRateExports: boolean
    notes: string[]
  }
  paymentInstructions: {
    enabled: boolean
    accountName: string | null
    bankName: string | null
    accountNumber: string | null
    routingCode: string | null
    swiftBic: string | null
    mobileMoneyNumber: string | null
    mobileMoneyProvider: string | null
    additionalDetails: string | null
  }
  invoicePrefix: string
  defaultPaymentTermsDays: number
  defaultNotes: string | null
  defaultFooter: string | null
}

export default function Settings() {
  const { org, meta, refreshUser } = useAuth()
  const canEdit = useCan('ADMIN')
  const toast = useToast()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<Partial<OrgSettings>>({})
  const [error, setError] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})

  const { data, isLoading } = useQuery({
    queryKey: ['organisation', org?.id],
    queryFn: () => api<{ organisation: OrgSettings }>('/api/v1/organisation'),
    enabled: Boolean(org),
  })

  useEffect(() => {
    if (data) setForm(data.organisation)
  }, [data])

  const save = useMutation({
    mutationFn: (body: Partial<OrgSettings>) =>
      api('/api/v1/organisation', { method: 'PATCH', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['organisation'] })
      await refreshUser()
      toast.push('Settings saved', 'success')
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setError(err.message)
        setFields(err.fieldErrors)
      }
    },
  })

  const set = (key: keyof OrgSettings, value: unknown) =>
    setForm((current) => ({ ...current, [key]: value }))

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setFields({})
    save.mutate({
      name: form.name,
      legalName: form.legalName || null,
      country: form.country,
      region: form.region || null,
      city: form.city || null,
      addressLine1: form.addressLine1 || null,
      email: form.email || null,
      phone: form.phone || null,
      brandColor: form.brandColor,
      baseCurrency: form.baseCurrency,
      taxRegistered: form.taxRegistered,
      taxId: form.taxId || null,
      customTaxProfile: form.customTaxProfile,
      paymentInstructions: form.paymentInstructions,
      invoicePrefix: form.invoicePrefix,
      defaultPaymentTermsDays: Number(form.defaultPaymentTermsDays) || 14,
      defaultNotes: form.defaultNotes || null,
      defaultFooter: form.defaultFooter || null,
    })
  }

  if (isLoading) return <Skeleton className="h-96" />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-ink-900">Settings</h1>
        <p className="text-sm text-ink-500">
          Your country and tax registration decide what you charge.
        </p>
      </div>

      {error && <ErrorNotice message={error} />}

      <form onSubmit={submit} className="space-y-5">
        <Card>
          <SectionHeading title="Business details" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Trading name"
              value={form.name ?? ''}
              error={fields.name}
              disabled={!canEdit}
              onChange={(e) => set('name', e.target.value)}
            />
            <Input
              label="Legal name"
              value={form.legalName ?? ''}
              disabled={!canEdit}
              onChange={(e) => set('legalName', e.target.value)}
            />
            <CountrySelect
              value={form.country ?? 'GH'}
              disabled={!canEdit}
              onChange={(code) => set('country', code)}
            />
            <Select
              label="Base currency"
              value={form.baseCurrency ?? 'USD'}
              disabled={!canEdit}
              onChange={(e) => set('baseCurrency', e.target.value)}
            >
              {(meta?.currencies ?? []).map((c) => (
                <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
              ))}
            </Select>
            <Input
              label="Billing email"
              type="email"
              value={form.email ?? ''}
              disabled={!canEdit}
              onChange={(e) => set('email', e.target.value)}
            />
            <Input
              label="City"
              value={form.city ?? ''}
              disabled={!canEdit}
              onChange={(e) => set('city', e.target.value)}
            />
          </div>
        </Card>

        <Card>
          <SectionHeading
            title="Tax"
            description="If you are not registered, TaxPedestal charges no tax at all."
          />
          <div className="space-y-3">
            <Checkbox
              label="Registered for VAT / GST / sales tax"
              description="Turn this on only once you actually hold a registration"
              checked={form.taxRegistered ?? false}
              disabled={!canEdit}
              onChange={(e) => set('taxRegistered', e.target.checked)}
            />
            <Input
              label="Tax registration number"
              value={form.taxId ?? ''}
              mono
              disabled={!canEdit}
              onChange={(e) => set('taxId', e.target.value)}
              placeholder="C0012345678"
            />
          </div>
        </Card>

        <CustomTaxCard
          country={form.country ?? ''}
          profile={
            form.customTaxProfile ?? {
              enabled: false,
              overrideBuiltIn: false,
              components: [],
              zeroRateExports: true,
              notes: [],
            }
          }
          hasAutomaticTax={Boolean(
            meta?.countries.find((c) => c.code === form.country)?.hasAutomaticTax,
          )}
          disabled={!canEdit}
          onChange={(profile) => set('customTaxProfile', profile)}
        />

        <PaymentCard
          instructions={
            form.paymentInstructions ?? {
              enabled: false,
              accountName: null,
              bankName: null,
              accountNumber: null,
              routingCode: null,
              swiftBic: null,
              mobileMoneyNumber: null,
              mobileMoneyProvider: null,
              additionalDetails: null,
            }
          }
          disabled={!canEdit}
          onChange={(instructions) => set('paymentInstructions', instructions)}
        />

        <Card>
          <SectionHeading title="Invoice defaults" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Number prefix"
              value={form.invoicePrefix ?? 'INV'}
              mono
              disabled={!canEdit}
              hint="Invoices look like PREFIX-0001"
              onChange={(e) => set('invoicePrefix', e.target.value.toUpperCase())}
            />
            <Input
              label="Payment terms (days)"
              type="number"
              value={String(form.defaultPaymentTermsDays ?? 14)}
              mono
              disabled={!canEdit}
              onChange={(e) => set('defaultPaymentTermsDays', e.target.value)}
            />
          </div>
          <div className="mt-3 space-y-3">
            <Textarea
              label="Default notes"
              value={form.defaultNotes ?? ''}
              disabled={!canEdit}
              onChange={(e) => set('defaultNotes', e.target.value)}
            />
            <Input
              label="Brand colour"
              type="color"
              value={form.brandColor ?? '#2B59FF'}
              disabled={!canEdit}
              className="h-10 w-24 p-1"
              onChange={(e) => set('brandColor', e.target.value)}
            />
          </div>
        </Card>

        {canEdit && (
          <div className="flex justify-end">
            <Button type="submit" loading={save.isPending}>Save settings</Button>
          </div>
        )}
      </form>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Custom tax rates                                                            */
/* -------------------------------------------------------------------------- */

interface CustomProfile {
  enabled: boolean
  overrideBuiltIn: boolean
  components: Array<{ code: string; label: string; basisPoints: number }>
  zeroRateExports: boolean
  notes: string[]
}

/**
 * Lets an organisation define its own tax components.
 *
 * This is what makes TaxPedestal usable from anywhere rather than only the ~50
 * countries we ship rules for. Iraq, for example, has no general VAT at all —
 * only a narrow sales tax on particular services — so no built-in rule could
 * ever be right for every Iraqi business. The user states their own.
 *
 * It also serves businesses in covered countries who are on a special scheme:
 * a flat-rate scheme, a regional exemption, a reduced sectoral rate.
 */
function CustomTaxCard({
  country,
  profile,
  hasAutomaticTax,
  disabled,
  onChange,
}: {
  country: string
  profile: CustomProfile
  hasAutomaticTax: boolean
  disabled: boolean
  onChange: (profile: CustomProfile) => void
}) {
  const patch = (changes: Partial<CustomProfile>) => onChange({ ...profile, ...changes })

  const setComponent = (index: number, changes: Partial<CustomProfile['components'][number]>) =>
    patch({
      components: profile.components.map((c, i) => (i === index ? { ...c, ...changes } : c)),
    })

  return (
    <Card>
      <SectionHeading
        title="Your own tax rates"
        description={
          hasAutomaticTax
            ? 'TaxPedestal calculates tax for your country automatically. Define your own only if you are on a special scheme.'
            : 'TaxPedestal has no built-in rules for your country yet. Define your rates here and invoices will calculate correctly.'
        }
      />

      {!hasAutomaticTax && country && !profile.enabled && (
        <div className="mb-4 rounded-lg border border-amber-100 bg-amber-50 px-4 py-3">
          <p className="text-sm text-amber-700">
            Invoices are currently issued with no tax. Turn this on to charge tax.
          </p>
        </div>
      )}

      <div className="space-y-4">
        <Checkbox
          label="Use my own tax rates"
          description="Applied to every invoice this workspace issues"
          checked={profile.enabled}
          disabled={disabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />

        {profile.enabled && (
          <>
            {hasAutomaticTax && (
              <Checkbox
                label="Override the built-in rules for my country"
                description="Only if your situation genuinely differs from the standard rate"
                checked={profile.overrideBuiltIn}
                disabled={disabled}
                onChange={(e) => patch({ overrideBuiltIn: e.target.checked })}
              />
            )}

            <div className="space-y-2">
              {profile.components.map((component, index) => (
                <div key={index} className="grid grid-cols-12 items-end gap-2">
                  <div className="col-span-7">
                    <Input
                      label={index === 0 ? 'Shown on the invoice as' : undefined}
                      value={component.label}
                      disabled={disabled}
                      placeholder="VAT (15%)"
                      onChange={(e) => setComponent(index, { label: e.target.value })}
                    />
                  </div>
                  <div className="col-span-3">
                    <Input
                      label={index === 0 ? 'Rate %' : undefined}
                      value={String(component.basisPoints / 100)}
                      mono
                      inputMode="decimal"
                      disabled={disabled}
                      onChange={(e) =>
                        setComponent(index, {
                          // Stored as basis points so the value stays integral.
                          basisPoints: Math.round((Number(e.target.value) || 0) * 100),
                        })
                      }
                    />
                  </div>
                  <div className="col-span-2 pb-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      onClick={() =>
                        patch({ components: profile.components.filter((_, i) => i !== index) })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))}

              {profile.components.length < 6 && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={disabled}
                  onClick={() =>
                    patch({
                      components: [
                        ...profile.components,
                        {
                          code: `CUSTOM_${profile.components.length + 1}`,
                          label: '',
                          basisPoints: 0,
                        },
                      ],
                    })
                  }
                >
                  Add a tax line
                </Button>
              )}
            </div>

            <Checkbox
              label="Zero-rate exports"
              description="Most tax systems do not charge tax on supplies to another country"
              checked={profile.zeroRateExports}
              disabled={disabled}
              onChange={(e) => patch({ zeroRateExports: e.target.checked })}
            />

            <Textarea
              label="Note printed on the invoice"
              value={profile.notes[0] ?? ''}
              disabled={disabled}
              placeholder="Sales tax charged under ..."
              onChange={(e) => patch({ notes: e.target.value ? [e.target.value] : [] })}
            />

            <div className="rounded-lg bg-ink-50 px-3 py-2">
              <p className="text-xs text-ink-600">
                Total rate applied:{' '}
                <span className="money font-semibold">
                  {(profile.components.reduce((sum, c) => sum + c.basisPoints, 0) / 100).toFixed(2)}%
                </span>
              </p>
            </div>
          </>
        )}
      </div>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* Getting paid                                                                */
/* -------------------------------------------------------------------------- */

interface PaymentInstructions {
  enabled: boolean
  accountName: string | null
  bankName: string | null
  accountNumber: string | null
  routingCode: string | null
  swiftBic: string | null
  mobileMoneyNumber: string | null
  mobileMoneyProvider: string | null
  additionalDetails: string | null
}

interface Capability {
  country: string
  canCollect: boolean
  hasAutomaticRail: boolean
  restricted: boolean
  summary: string
  rails: Array<{
    id: string
    name: string
    description: string
    available: boolean
    reason?: string
    automatic: boolean
    allowAttempt: boolean
    source: 'live' | 'reference' | 'always'
  }>
  provenance: {
    referenceReviewedAt: string
    referenceAgeDays: number
    referenceStale: boolean
    liveProbeUsed: boolean
  }
}

/**
 * Getting paid.
 *
 * Shows the honest picture: which rails this business can actually use, and
 * why any are unavailable. Card gateways onboard merchants in roughly fifty
 * countries; the rest of the world gets paid by bank transfer, so those details
 * are treated as a primary feature rather than an afterthought.
 */
function PaymentCard({
  instructions,
  disabled,
  onChange,
}: {
  instructions: PaymentInstructions
  disabled: boolean
  onChange: (next: PaymentInstructions) => void
}) {
  const { data: capability } = useCapabilityQuery({
    queryKey: ['payment-capability'],
    queryFn: () => api<Capability>('/api/v1/organisation/payment-capability'),
  })

  const patch = (changes: Partial<PaymentInstructions>) =>
    onChange({ ...instructions, ...changes })

  return (
    <Card>
      <SectionHeading
        title="Getting paid"
        description={capability?.summary}
      />

      {capability?.provenance.referenceStale && !capability.provenance.liveProbeUsed && (
        <div className="mb-4 rounded-lg border border-amber-100 bg-amber-50 px-4 py-3">
          <p className="text-sm text-amber-700">
            Our provider coverage data was last reviewed{' '}
            {capability.provenance.referenceAgeDays} days ago and may understate what is
            available. Connecting a provider key checks with them directly.
          </p>
        </div>
      )}

      {capability && (
        <div className="mb-5 space-y-2">
          {capability.rails.map((rail) => (
            <div
              key={rail.id}
              className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 ${
                rail.available ? 'border-ink-200 bg-white' : 'border-ink-100 bg-ink-50'
              }`}
            >
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                  rail.available ? 'bg-jade' : 'bg-ink-300'
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p
                    className={`text-sm font-medium ${
                      rail.available ? 'text-ink-900' : 'text-ink-500'
                    }`}
                  >
                    {rail.name}
                  </p>
                  {/* Say where the answer came from. "Checked with Stripe just
                      now" and "our records suggest" deserve different trust. */}
                  {rail.source === 'live' && (
                    <span className="rounded bg-jade-50 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-jade-700">
                      Verified
                    </span>
                  )}
                </div>
                <p className="text-xs text-ink-500">
                  {rail.available ? rail.description : rail.reason}
                </p>
                {!rail.available && rail.allowAttempt && rail.automatic && (
                  <p className="mt-1 text-xs text-cobalt">
                    Add your API key in the environment and we will check with them directly.
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-4 border-t border-ink-100 pt-4">
        <Checkbox
          label="Show my bank details on invoices"
          description="Works in every country — your customer transfers directly to you"
          checked={instructions.enabled}
          disabled={disabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />

        {instructions.enabled && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Account name"
              value={instructions.accountName ?? ''}
              disabled={disabled}
              onChange={(e) => patch({ accountName: e.target.value })}
            />
            <Input
              label="Bank name"
              value={instructions.bankName ?? ''}
              disabled={disabled}
              onChange={(e) => patch({ bankName: e.target.value })}
            />
            <Input
              label="Account number"
              value={instructions.accountNumber ?? ''}
              mono
              disabled={disabled}
              onChange={(e) => patch({ accountNumber: e.target.value })}
            />
            <Input
              label="IBAN, sort code, routing or IFSC"
              value={instructions.routingCode ?? ''}
              mono
              disabled={disabled}
              hint="Whichever your country uses"
              onChange={(e) => patch({ routingCode: e.target.value })}
            />
            <Input
              label="SWIFT / BIC"
              value={instructions.swiftBic ?? ''}
              mono
              disabled={disabled}
              hint="For international transfers"
              onChange={(e) => patch({ swiftBic: e.target.value })}
            />
            <Input
              label="Mobile money number"
              value={instructions.mobileMoneyNumber ?? ''}
              mono
              disabled={disabled}
              onChange={(e) => patch({ mobileMoneyNumber: e.target.value })}
            />
            <div className="sm:col-span-2">
              <Textarea
                label="Anything else the payer needs"
                value={instructions.additionalDetails ?? ''}
                disabled={disabled}
                placeholder="Intermediary bank, branch address, reference format…"
                onChange={(e) => patch({ additionalDetails: e.target.value })}
              />
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
