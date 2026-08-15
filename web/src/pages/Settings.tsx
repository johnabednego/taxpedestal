import { FormEvent, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useQuery as useCapabilityQuery } from '@tanstack/react-query'
import { ApiError, api } from '../lib/api'
import { useAuth, useCan } from '../lib/auth'
import { useI18n, type TranslationKey } from '../i18n'
import { CountrySelect } from '../components/CountrySelect'
import { Trash2 } from 'lucide-react'
import {
  Button,
  Card,
  Checkbox,
  ErrorNotice,
  Input,
  Modal,
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
  const { t } = useI18n()
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
      toast.push(t('settings.saved'), 'success')
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
        <h1 className="text-2xl font-bold text-ink-900">{t('settings.title')}</h1>
        <p className="text-sm text-ink-500">{t('settings.subtitle')}</p>
      </div>

      {error && <ErrorNotice message={error} />}

      <form onSubmit={submit} className="space-y-5">
        <Card>
          <SectionHeading title={t('settings.business')} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label={t('settings.tradingName')}
              value={form.name ?? ''}
              error={fields.name}
              disabled={!canEdit}
              onChange={(e) => set('name', e.target.value)}
            />
            <Input
              label={t('settings.legalName')}
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
              label={t('settings.baseCurrency')}
              value={form.baseCurrency ?? 'USD'}
              disabled={!canEdit}
              onChange={(e) => set('baseCurrency', e.target.value)}
            >
              {(meta?.currencies ?? []).map((c) => (
                <option key={c.code} value={c.code}>{c.code}, {c.name}</option>
              ))}
            </Select>
            <Input
              label={t('settings.billingEmail')}
              type="email"
              value={form.email ?? ''}
              disabled={!canEdit}
              onChange={(e) => set('email', e.target.value)}
            />
            <Input
              label={t('settings.city')}
              value={form.city ?? ''}
              disabled={!canEdit}
              onChange={(e) => set('city', e.target.value)}
            />
          </div>
        </Card>

        <Card>
          <SectionHeading title={t('settings.tax')} description={t('settings.taxHelp')} />
          <div className="space-y-3">
            <Checkbox
              label={t('settings.taxRegisteredLabel')}
              description={t('settings.taxRegisteredHelp')}
              checked={form.taxRegistered ?? false}
              disabled={!canEdit}
              onChange={(e) => set('taxRegistered', e.target.checked)}
            />
            <Input
              label={t('settings.taxNumber')}
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
          <SectionHeading title={t('settings.invoiceDefaults')} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label={t('settings.numberPrefix')}
              value={form.invoicePrefix ?? 'INV'}
              mono
              disabled={!canEdit}
              hint={t('settings.numberPrefixHint')}
              onChange={(e) => set('invoicePrefix', e.target.value.toUpperCase())}
            />
            <Input
              label={t('settings.paymentTerms')}
              type="number"
              value={String(form.defaultPaymentTermsDays ?? 14)}
              mono
              disabled={!canEdit}
              onChange={(e) => set('defaultPaymentTermsDays', e.target.value)}
            />
          </div>
          <div className="mt-3 space-y-3">
            <Textarea
              label={t('settings.defaultNotes')}
              value={form.defaultNotes ?? ''}
              disabled={!canEdit}
              onChange={(e) => set('defaultNotes', e.target.value)}
            />
            <Input
              label={t('settings.brandColour')}
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
            <Button type="submit" loading={save.isPending}>{t('settings.save')}</Button>
          </div>
        )}
      </form>

      {/* Outside the settings <form>: these are their own actions and must not
          be submitted along with the workspace details. */}
      <TeamCard />
      <AccountCard />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Account                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The signed-in user's own credentials.
 *
 * `change-password` and `logout-all` existed on the server from the start with
 * nothing calling them, so a signed-in user could only change their password by
 * signing out and using the forgotten-password email, and had no way at all to
 * end a session on a device they no longer control.
 *
 * Changing the password bumps the token version server-side, which revokes
 * every other session as a side effect. That is stated here rather than left
 * as a surprise.
 */
function AccountCard() {
  const { t } = useI18n()
  const { user } = useAuth()
  const toast = useToast()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})

  const change = useMutation({
    mutationFn: () =>
      api('/api/v1/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      }),
    onSuccess: () => {
      setCurrentPassword('')
      setNewPassword('')
      setError('')
      setFields({})
      toast.push(t('account.passwordChanged'), 'success')
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setError(err.message)
        setFields(err.fieldErrors)
      } else setError(t('account.changeFailed'))
    },
  })

  const signOutEverywhere = useMutation({
    mutationFn: () => api('/api/v1/auth/logout-all', { method: 'POST' }),
    onSuccess: () => toast.push(t('account.signedOutAll'), 'success'),
    onError: (e) => toast.push(e instanceof ApiError ? e.message : t('error.generic'), 'danger'),
  })

  return (
    <Card>
      <SectionHeading title={t('account.title')} description={t('account.subtitle')} />

      <p className="mb-4 text-sm text-ink-600">{user?.email}</p>

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          change.mutate()
        }}
      >
        {error && <ErrorNotice message={error} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label={t('account.currentPassword')}
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            error={fields.currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
          <Input
            label={t('account.newPassword')}
            type="password"
            autoComplete="new-password"
            value={newPassword}
            error={fields.newPassword}
            hint={t('auth.passwordHint')}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </div>
        <div className="flex justify-end">
          <Button
            type="submit"
            loading={change.isPending}
            disabled={!currentPassword || !newPassword}
          >
            {t('account.changePassword')}
          </Button>
        </div>
      </form>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-ink-100 pt-4">
        <p className="text-xs text-ink-500">{t('account.signOutAllHelp')}</p>
        <Button
          variant="secondary"
          size="sm"
          loading={signOutEverywhere.isPending}
          onClick={() => {
            if (window.confirm(t('account.signOutAllConfirm'))) signOutEverywhere.mutate()
          }}
        >
          {t('account.signOutAll')}
        </Button>
      </div>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/* Team                                                                        */
/* -------------------------------------------------------------------------- */

interface Member {
  id: string
  role: OrgRole
  status: 'INVITED' | 'ACTIVE' | 'REVOKED'
  invitedEmail: string | null
  acceptedAt: string | null
  user: { _id: string; fullName: string; email: string; avatarColor: string } | null
}

type OrgRole = 'VIEWER' | 'MEMBER' | 'ADMIN' | 'OWNER'

const ROLE_RANK: Record<OrgRole, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 }
const ROLE_KEY: Record<OrgRole, TranslationKey> = {
  VIEWER: 'team.roleVIEWER',
  MEMBER: 'team.roleMEMBER',
  ADMIN: 'team.roleADMIN',
  OWNER: 'team.roleOWNER',
}

/**
 * Team management.
 *
 * The API has supported invitations, role changes and removal from the start,
 * and the accept-invitation page existed, but nothing in the interface could
 * SEND an invitation, so the whole journey was unreachable.
 *
 * Two server rules are mirrored here so the UI never offers what the API would
 * reject: nobody may grant a role above their own, and the last owner cannot be
 * demoted or removed. The server still enforces both; this only avoids showing
 * a control that would fail.
 */
function TeamCard() {
  const { t } = useI18n()
  const { user, org } = useAuth()
  const canManage = useCan('ADMIN')
  const toast = useToast()
  const queryClient = useQueryClient()
  const [inviteOpen, setInviteOpen] = useState(false)

  const { data: members } = useQuery({
    queryKey: ['members', org?.id],
    queryFn: () => api<Member[]>('/api/v1/organisation/members'),
    enabled: Boolean(org),
  })

  const myRank = org ? ROLE_RANK[org.role as OrgRole] : 0
  const ownerCount = (members ?? []).filter(
    (m) => m.role === 'OWNER' && m.status === 'ACTIVE',
  ).length

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: OrgRole }) =>
      api(`/api/v1/organisation/members/${id}/role`, { method: 'POST', body: { role } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['members'] })
      toast.push(t('team.roleChanged'), 'success')
    },
    onError: (e) => toast.push(e instanceof ApiError ? e.message : t('error.generic'), 'danger'),
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/organisation/members/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['members'] })
      toast.push(t('team.removed'), 'success')
    },
    onError: (e) => toast.push(e instanceof ApiError ? e.message : t('error.generic'), 'danger'),
  })

  return (
    <Card>
      <SectionHeading
        title={t('team.title')}
        description={t('team.subtitle')}
        action={
          canManage ? (
            <Button size="sm" variant="secondary" onClick={() => setInviteOpen(true)}>
              {t('team.invite')}
            </Button>
          ) : undefined
        }
      />

      <ul className="divide-y divide-ink-100">
        {(members ?? []).map((member) => {
          const name = member.user?.fullName ?? member.invitedEmail ?? '-'
          const isSelf = member.user?._id === user?._id
          // The last owner is load-bearing: removing them would orphan the
          // workspace, so the server refuses and the UI does not offer it.
          const isLastOwner = member.role === 'OWNER' && ownerCount <= 1
          const canTouch =
            canManage && !isSelf && !isLastOwner && ROLE_RANK[member.role] <= myRank

          return (
            <li key={member.id} className="flex items-center justify-between gap-3 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
                  style={{ backgroundColor: member.user?.avatarColor ?? '#8494BA' }}
                  aria-hidden
                >
                  {name.slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink-900">
                    {name}
                    {isSelf && <span className="ms-1 text-xs text-ink-400">({t('team.you')})</span>}
                  </p>
                  <p className="truncate text-xs text-ink-500">
                    {member.user?.email ?? member.invitedEmail}
                    {member.status === 'INVITED' && ` · ${t('team.pending')}`}
                  </p>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {canTouch ? (
                  <Select
                    value={member.role}
                    aria-label={t('team.role')}
                    onChange={(e) =>
                      changeRole.mutate({ id: member.id, role: e.target.value as OrgRole })
                    }
                    className="h-8 py-0 text-xs"
                  >
                    {(Object.keys(ROLE_RANK) as OrgRole[])
                      // Never offer a role above your own.
                      .filter((role) => ROLE_RANK[role] <= myRank)
                      .map((role) => (
                        <option key={role} value={role}>
                          {t(ROLE_KEY[role])}
                        </option>
                      ))}
                  </Select>
                ) : (
                  <span className="text-xs font-medium text-ink-500">
                    {t(ROLE_KEY[member.role])}
                  </span>
                )}
                {canTouch && (
                  <button
                    onClick={() => {
                      if (window.confirm(t('team.confirmRemove', { name }))) {
                        remove.mutate(member.id)
                      }
                    }}
                    aria-label={t('team.removeAria', { name })}
                    className="rounded-lg p-1.5 text-ink-400 hover:bg-rose-50 hover:text-rose"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {ownerCount <= 1 && (
        <p className="mt-3 border-t border-ink-100 pt-2 text-xs text-ink-400">
          {t('team.lastOwner')}
        </p>
      )}

      <InviteModal
        open={inviteOpen}
        maxRank={myRank}
        onClose={() => setInviteOpen(false)}
        onSent={() => {
          void queryClient.invalidateQueries({ queryKey: ['members'] })
          toast.push(t('team.inviteSent'), 'success')
          setInviteOpen(false)
        }}
      />
    </Card>
  )
}

function InviteModal({
  open,
  maxRank,
  onClose,
  onSent,
}: {
  open: boolean
  maxRank: number
  onClose: () => void
  onSent: () => void
}) {
  const { t } = useI18n()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OrgRole>('MEMBER')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)

  const ROLE_HELP: Record<OrgRole, TranslationKey> = {
    VIEWER: 'team.roleViewerHelp',
    MEMBER: 'team.roleMemberHelp',
    ADMIN: 'team.roleAdminHelp',
    OWNER: 'team.roleOwnerHelp',
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSending(true)
    setError('')
    try {
      await api('/api/v1/organisation/members/invite', {
        method: 'POST',
        body: { email, role },
      })
      setEmail('')
      onSent()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('team.inviteFailed'))
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('team.inviteTitle')}
      description={t('team.inviteDescription')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button onClick={submit} loading={sending} disabled={!email.trim()}>
            {t('team.sendInvite')}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorNotice message={error} />}
        <Input
          label={t('team.emailLabel')}
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="colleague@company.com"
        />
        <Select
          label={t('team.role')}
          value={role}
          hint={t(ROLE_HELP[role])}
          onChange={(e) => setRole(e.target.value as OrgRole)}
        >
          {(Object.keys(ROLE_RANK) as OrgRole[])
            .filter((r) => ROLE_RANK[r] <= maxRank)
            .map((r) => (
              <option key={r} value={r}>
                {t(ROLE_KEY[r])}
              </option>
            ))}
        </Select>
      </form>
    </Modal>
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
 * countries we ship rules for. Iraq, for example, has no general VAT at all, * only a narrow sales tax on particular services, so no built-in rule could
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
  const { t } = useI18n()
  const patch = (changes: Partial<CustomProfile>) => onChange({ ...profile, ...changes })

  const setComponent = (index: number, changes: Partial<CustomProfile['components'][number]>) =>
    patch({
      components: profile.components.map((c, i) => (i === index ? { ...c, ...changes } : c)),
    })

  return (
    <Card>
      <SectionHeading
        title={t('customTax.title')}
        description={
          hasAutomaticTax ? t('customTax.hasAutomatic') : t('customTax.noAutomatic')
        }
      />

      {!hasAutomaticTax && country && !profile.enabled && (
        <div className="mb-4 rounded-lg border border-amber-100 bg-amber-50 px-4 py-3">
          <p className="text-sm text-amber-700">{t('customTax.noTaxWarning')}</p>
        </div>
      )}

      <div className="space-y-4">
        <Checkbox
          label={t('customTax.enable')}
          description={t('customTax.enableHelp')}
          checked={profile.enabled}
          disabled={disabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />

        {profile.enabled && (
          <>
            {hasAutomaticTax && (
              <Checkbox
                label={t('customTax.override')}
                description={t('customTax.overrideHelp')}
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
                      label={index === 0 ? t('customTax.labelOnInvoice') : undefined}
                      value={component.label}
                      disabled={disabled}
                      placeholder="VAT (15%)"
                      onChange={(e) => setComponent(index, { label: e.target.value })}
                    />
                  </div>
                  <div className="col-span-3">
                    <Input
                      label={index === 0 ? t('customTax.ratePercent') : undefined}
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
                      {t('action.remove')}
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
                  {t('customTax.addLine')}
                </Button>
              )}
            </div>

            <Checkbox
              label={t('customTax.zeroRateExports')}
              description={t('customTax.zeroRateExportsHelp')}
              checked={profile.zeroRateExports}
              disabled={disabled}
              onChange={(e) => patch({ zeroRateExports: e.target.checked })}
            />

            <Textarea
              label={t('customTax.note')}
              value={profile.notes[0] ?? ''}
              disabled={disabled}
              placeholder={t('customTax.notePlaceholder')}
              onChange={(e) => patch({ notes: e.target.value ? [e.target.value] : [] })}
            />

            <div className="rounded-lg bg-ink-50 px-3 py-2">
              <p className="text-xs text-ink-600">
                {t('customTax.totalRate')}{' '}
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
  /** Stable code for `summary`; the prose is the fallback. */
  summaryCode: string
  rails: Array<{
    id: string
    name: string
    description: string
    available: boolean
    reason?: string
    /** Stable code for `reason`; the prose is the fallback. */
    reasonCode?: string
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
  const { t, tOr } = useI18n()
  const { data: capability } = useCapabilityQuery({
    queryKey: ['payment-capability'],
    queryFn: () => api<Capability>('/api/v1/organisation/payment-capability'),
  })

  const patch = (changes: Partial<PaymentInstructions>) =>
    onChange({ ...instructions, ...changes })

  return (
    <Card>
      <SectionHeading
        title={t('settings.gettingPaid')}
        description={
          capability
            ? tOr(`paySummary.${capability.summaryCode}`, capability.summary)
            : undefined
        }
      />

      {capability?.provenance.referenceStale && !capability.provenance.liveProbeUsed && (
        <div className="mb-4 rounded-lg border border-amber-100 bg-amber-50 px-4 py-3">
          <p className="text-sm text-amber-700">
            {t('paid.staleCoverage', { days: capability.provenance.referenceAgeDays })}
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
                    {tOr(`rail.${rail.id}`, rail.name)}
                  </p>
                  {/* Say where the answer came from. "Checked with Stripe just
                      now" and "our records suggest" deserve different trust. */}
                  {rail.source === 'live' && (
                    <span className="rounded bg-jade-50 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-jade-700">
                      {t('paid.verified')}
                    </span>
                  )}
                </div>
                <p className="text-xs text-ink-500">
                  {rail.available
                    ? tOr(`rail.${rail.id}.desc`, rail.description)
                    : rail.reasonCode
                      ? tOr(`railReason.${rail.reasonCode}`, rail.reason ?? '')
                      : rail.reason}
                </p>
                {!rail.available && rail.allowAttempt && rail.automatic && (
                  <p className="mt-1 text-xs text-cobalt">{t('paid.addKeyHint')}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-4 border-t border-ink-100 pt-4">
        <Checkbox
          label={t('paid.bankDetails')}
          description={t('paid.bankDetailsHelp')}
          checked={instructions.enabled}
          disabled={disabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />

        {instructions.enabled && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label={t('paid.accountName')}
              value={instructions.accountName ?? ''}
              disabled={disabled}
              onChange={(e) => patch({ accountName: e.target.value })}
            />
            <Input
              label={t('paid.bankName')}
              value={instructions.bankName ?? ''}
              disabled={disabled}
              onChange={(e) => patch({ bankName: e.target.value })}
            />
            <Input
              label={t('paid.accountNumber')}
              value={instructions.accountNumber ?? ''}
              mono
              disabled={disabled}
              onChange={(e) => patch({ accountNumber: e.target.value })}
            />
            <Input
              label={t('paid.routingCode')}
              value={instructions.routingCode ?? ''}
              mono
              disabled={disabled}
              hint={t('paid.routingCodeHint')}
              onChange={(e) => patch({ routingCode: e.target.value })}
            />
            <Input
              label={t('paid.swift')}
              value={instructions.swiftBic ?? ''}
              mono
              disabled={disabled}
              hint={t('paid.swiftHint')}
              onChange={(e) => patch({ swiftBic: e.target.value })}
            />
            <Input
              label={t('paid.mobileMoneyNumber')}
              value={instructions.mobileMoneyNumber ?? ''}
              mono
              disabled={disabled}
              onChange={(e) => patch({ mobileMoneyNumber: e.target.value })}
            />
            <div className="sm:col-span-2">
              <Textarea
                label={t('paid.additionalDetails')}
                value={instructions.additionalDetails ?? ''}
                disabled={disabled}
                placeholder={t('paid.additionalPlaceholder')}
                onChange={(e) => patch({ additionalDetails: e.target.value })}
              />
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
