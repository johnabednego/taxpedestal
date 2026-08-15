import { AlertTriangle, CheckCircle2, FileWarning } from 'lucide-react'
import { useI18n } from '../i18n'
import { Card } from './ui'

/**
 * Compliance notice.
 *
 * Tells the user, before they send, what their jurisdiction requires and what
 * the product cannot do for them. The second part matters most: several countries
 * mandate structured e-invoicing where a PDF has no legal standing at all, and
 * quietly producing a good-looking PDF there implies a validity it does not
 * have.
 *
 * Every message cites its source, and the panel says when the rules were last
 * reviewed — so a user can see the information is dated rather than assuming it
 * is current. Tax law moves; a product that presents stale rules with
 * unchanging confidence is worse than one that admits its age.
 */

export interface ComplianceData {
  jurisdiction: string
  documentTitle: string
  hasRequiredIssues: boolean
  rulesReviewedAt: string
  rulesAgeDays: number
  rulesStale: boolean
  issues: Array<{
    field: string
    label: string
    severity: 'required' | 'recommended'
    reason: string
  }>
  statements: string[]
  eInvoicingRegime?: { name: string; note: string }
}

export function ComplianceNotice({ compliance }: { compliance: ComplianceData | null }) {
  const { t, formatDate } = useI18n()
  if (!compliance) return null

  const required = compliance.issues.filter((i) => i.severity === 'required')
  const recommended = compliance.issues.filter((i) => i.severity === 'recommended')
  const nothingToSay =
    required.length === 0 && recommended.length === 0 && !compliance.eInvoicingRegime

  if (nothingToSay) {
    return (
      <Card>
        <div className="flex items-start gap-2.5">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-jade" />
          <p className="text-sm text-ink-600">
            {t('compliance.allGood', { country: compliance.jurisdiction })}
          </p>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber" />
        <h2 className="text-base font-semibold text-ink-900">{t('compliance.title')}</h2>
      </div>

      {/* The most important message first: a PDF may not be a valid invoice. */}
      {compliance.eInvoicingRegime && (
        <div className="mb-4 rounded-lg border border-amber-100 bg-amber-50 px-4 py-3">
          <div className="flex items-start gap-2.5">
            <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
            <div>
              <p className="text-sm font-semibold text-amber-700">
                {t('compliance.eInvoicing')} — {compliance.eInvoicingRegime.name}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-amber-700">
                {compliance.eInvoicingRegime.note}
              </p>
              <p className="mt-2 text-xs text-amber-700">{t('compliance.eInvoicingHelp')}</p>
            </div>
          </div>
        </div>
      )}

      {required.length > 0 && (
        <div className="mb-3">
          <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-rose">
            {t('compliance.required')}
          </p>
          <ul className="space-y-2">
            {required.map((issue) => (
              <li key={issue.field} className="text-sm">
                <span className="font-medium text-ink-900">{issue.label}</span>
                {/* The reason cites the rule, so the user can verify rather
                    than take our word for it. */}
                <p className="text-xs leading-relaxed text-ink-500">{issue.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {recommended.length > 0 && (
        <div className="mb-3">
          <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-400">
            {t('compliance.recommended')}
          </p>
          <ul className="space-y-2">
            {recommended.map((issue) => (
              <li key={issue.field} className="text-sm">
                <span className="font-medium text-ink-800">{issue.label}</span>
                <p className="text-xs leading-relaxed text-ink-500">{issue.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {compliance.statements.length > 0 && (
        <div className="rounded-lg bg-ink-50 px-3 py-2">
          {compliance.statements.map((statement) => (
            <p key={statement} className="text-xs leading-relaxed text-ink-600">
              {statement}
            </p>
          ))}
        </div>
      )}

      {/* Provenance. Rules have a date, and the user is told it. */}
      <p className="mt-3 border-t border-ink-100 pt-2 text-xs text-ink-400">
        {compliance.rulesStale
          ? t('compliance.mayBeOutdated', { days: compliance.rulesAgeDays })
          : t('compliance.reviewedOn', { date: formatDate(compliance.rulesReviewedAt, 'medium') })}
      </p>
    </Card>
  )
}
