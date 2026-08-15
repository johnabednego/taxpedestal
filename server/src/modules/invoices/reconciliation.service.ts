import dayjs from 'dayjs'
import { logger } from '../../core/logger'
import { Invoice, InvoiceStatus, Payment, PaymentStatus, type IPayment } from '../../models'
import { getProvider } from '../../services/payments'
import type { ProviderId } from '../../services/payments/types'
import { applyPayment, recordAudit } from './invoice.service'
import { auditInvoiceBalance } from './ledger.service'

/**
 * Reconciliation.
 *
 * ============================================================================
 * WHY THIS EXISTS, the gap neither Stripe nor Paystack closes for you
 * ============================================================================
 * Both providers position webhooks as the mechanism for granting value.
 * Paystack states it as a maxim: "don't call us, we will call you." Their
 * reasoning is sound, polling every transaction is wasteful and the callback
 * URL is unreliable.
 *
 * But webhooks are a SINGLE POINT OF FAILURE, and the failure modes are mundane
 * rather than exotic:
 *
 *   - The webhook URL was never configured, or was configured for test mode
 *     only. Live payments then produce no events at all.
 *   - A deploy window drops deliveries. Paystack retries for 72 hours, Stripe
 *     for up to 3 days, but only for endpoints that return non-2xx. A handler
 *     that returns 200 while failing internally is marked delivered, forever.
 *   - A bug in the handler consumed the event and then threw.
 *   - The provider marked delivery successful against a stale endpoint after a
 *     domain change.
 *
 * In every case the customer's money has moved and the invoice still says
 * unpaid. This is the "paid but no value" problem, and the customer experiences
 * it as being charged twice when they retry.
 *
 * The fix is not to abandon webhooks, they remain the fast path. It is to add a
 * SAFETY NET: periodically ask the provider about payments we believe are still
 * pending, and settle any that actually succeeded. Webhook-first, poll-to-verify.
 *
 * This costs a handful of API calls per sweep because only PENDING payments are
 * examined, and only those old enough that a webhook should already have
 * arrived. It converts a silent revenue-losing bug into a self-healing one.
 * ============================================================================
 */

/**
 * A payment younger than this is left alone: the customer may still be on the
 * checkout page, or approving a mobile money prompt on their handset.
 */
const SETTLE_GRACE_MINUTES = 10

/** Beyond this, an unpaid attempt is treated as abandoned rather than pending. */
const ABANDON_AFTER_HOURS = 24

export interface ReconciliationReport {
  scanned: number
  settled: number
  failed: number
  abandoned: number
  stillPending: number
  /** Cached balances that disagreed with the ledger. Should always be zero. */
  driftFound: number
  driftRepaired: number
  errors: Array<{ paymentId: string; message: string }>
  startedAt: Date
  finishedAt: Date
}

/**
 * Sweep payments that never reached a terminal state.
 *
 * Idempotent and safe to run concurrently with webhook processing: settlement
 * goes through the ledger's unique (invoice, idempotencyKey) constraint, so a
 * webhook and a sweep racing on the same payment produce ONE credit.
 */
export async function reconcilePendingPayments(
  options: { limit?: number; graceMinutes?: number } = {},
): Promise<ReconciliationReport> {
  const startedAt = new Date()
  const grace = options.graceMinutes ?? SETTLE_GRACE_MINUTES
  const cutoff = dayjs().subtract(grace, 'minute').toDate()
  const abandonCutoff = dayjs().subtract(ABANDON_AFTER_HOURS, 'hour').toDate()

  const report: ReconciliationReport = {
    scanned: 0,
    settled: 0,
    failed: 0,
    abandoned: 0,
    stillPending: 0,
    driftFound: 0,
    driftRepaired: 0,
    errors: [],
    startedAt,
    finishedAt: startedAt,
  }

  const pending = await Payment.find({
    status: { $in: [PaymentStatus.PENDING, PaymentStatus.AWAITING_CUSTOMER] },
    createdAt: { $lte: cutoff },
    // MANUAL payments have no provider to ask.
    provider: { $ne: 'MANUAL' },
    providerReference: { $ne: null },
  })
    .sort({ createdAt: 1 })
    .limit(options.limit ?? 200)

  report.scanned = pending.length

  for (const payment of pending) {
    try {
      const outcome = await reconcileOne(payment, abandonCutoff)
      if (outcome === 'settled') report.settled += 1
      else if (outcome === 'failed') report.failed += 1
      else if (outcome === 'abandoned') report.abandoned += 1
      else report.stillPending += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      report.errors.push({ paymentId: payment._id.toString(), message })
      logger.warn(
        { err: message, paymentId: payment._id.toString() },
        'Reconciliation could not resolve a payment',
      )
    }
  }

  report.finishedAt = new Date()

  if (report.settled > 0) {
    // Deliberately warn, not info: any settlement here means a webhook was
    // missed, which is a defect worth investigating even though it self-healed.
    logger.warn(
      { settled: report.settled, scanned: report.scanned },
      'Reconciliation settled payments that webhooks did not, investigate webhook delivery',
    )
  }

  return report
}

type Outcome = 'settled' | 'failed' | 'abandoned' | 'pending'

async function reconcileOne(payment: IPayment, abandonCutoff: Date): Promise<Outcome> {
  const provider = getProvider(payment.provider as ProviderId)
  if (!provider.isConfigured()) return 'pending'

  const snapshot = await provider.fetchTransaction(payment.providerReference as string)

  if (snapshot.status === 'succeeded') {
    // Apply the SAME amount and currency checks the webhook path applies. A
    // sweep must not be a way to bypass the tampering guard.
    const amountMatches = snapshot.amountMinor === payment.amountMinor
    const currencyMatches = snapshot.currency.toUpperCase() === payment.currency.toUpperCase()

    if (!amountMatches || !currencyMatches) {
      payment.status = PaymentStatus.FAILED
      payment.failureCode = 'AMOUNT_MISMATCH'
      payment.failureMessage = `Provider reported ${snapshot.amountMinor} ${snapshot.currency}, expected ${payment.amountMinor} ${payment.currency}`
      await payment.save()

      await recordAudit({
        org: payment.org,
        actor: null,
        actorLabel: 'reconciliation',
        action: 'payment.amount_mismatch',
        entityType: 'Payment',
        entityId: payment._id.toString(),
        changes: {
          expectedAmountMinor: payment.amountMinor,
          receivedAmountMinor: snapshot.amountMinor,
          source: 'reconciliation',
        },
      })
      return 'failed'
    }

    payment.status = PaymentStatus.SUCCEEDED
    payment.paidAt = snapshot.paidAt ?? new Date()
    payment.providerFeeMinor = snapshot.feeMinor
    payment.channelDetail = snapshot.channelDetail
    await payment.save()

    const invoice = await Invoice.findById(payment.invoice)
    if (!invoice) return 'failed'

    // One shared idempotent path with the webhook handler. If a webhook already
    // credited this payment, `created` comes back false and nothing changes.
    const { created } = await applyPayment(invoice, payment.amountMinor, {
      actor: null,
      actorLabel: 'reconciliation',
      source: 'reconciliation',
      paymentId: payment._id,
      idempotencyKey: `payment:${payment._id.toString()}`,
      description: `Payment via ${payment.provider} (recovered by reconciliation)`,
    })

    if (created) {
      await recordAudit({
        org: payment.org,
        actor: null,
        actorLabel: 'reconciliation',
        action: 'payment.recovered',
        entityType: 'Payment',
        entityId: payment._id.toString(),
        changes: {
          amountMinor: payment.amountMinor,
          invoiceNumber: invoice.number,
          note: 'Settled by reconciliation, webhook was missed',
        },
      })
    }

    return 'settled'
  }

  if (snapshot.status === 'failed') {
    payment.status = PaymentStatus.FAILED
    payment.failureCode = snapshot.failureCode ?? 'provider_failed'
    payment.failureMessage = snapshot.failureMessage ?? null
    await payment.save()
    return 'failed'
  }

  if (snapshot.status === 'abandoned' || payment.createdAt <= abandonCutoff) {
    payment.status = PaymentStatus.ABANDONED
    await payment.save()
    return 'abandoned'
  }

  return 'pending'
}

/**
 * Verify cached invoice balances against the ledger and repair any drift.
 *
 * This audit is only possible because balances are derived. A counter-based
 * design has no independent source to compare against, so corruption there is
 * undetectable by construction.
 */
export async function reconcileBalances(
  options: { limit?: number; repair?: boolean } = {},
): Promise<{ checked: number; drifted: number; repaired: number; details: string[] }> {
  const invoices = await Invoice.find({
    status: { $ne: InvoiceStatus.DRAFT },
  })
    .sort({ updatedAt: -1 })
    .limit(options.limit ?? 500)

  let drifted = 0
  let repaired = 0
  const details: string[] = []

  for (const invoice of invoices) {
    const audit = await auditInvoiceBalance(invoice)
    if (!audit.drifted) continue

    drifted += 1
    const detail =
      `${audit.invoiceNumber}: cached paid ${audit.cachedPaidMinor} / due ${audit.cachedOutstandingMinor}, ` +
      `ledger paid ${audit.ledgerPaidMinor} / due ${audit.ledgerOutstandingMinor} ` +
      `(${audit.entryCount} entries)`
    details.push(detail)

    logger.error(
      { invoiceId: audit.invoiceId, audit },
      'Invoice cached balance disagrees with the ledger',
    )

    if (options.repair !== false) {
      // The ledger wins. Always.
      await Invoice.updateOne(
        { _id: invoice._id },
        {
          $set: {
            amountPaidMinor: audit.ledgerPaidMinor,
            amountDueMinor: audit.ledgerOutstandingMinor,
          },
        },
      )
      repaired += 1

      await recordAudit({
        org: invoice.org,
        actor: null,
        actorLabel: 'reconciliation',
        action: 'invoice.balance_repaired',
        entityType: 'Invoice',
        entityId: invoice._id.toString(),
        changes: audit,
      })
    }
  }

  return { checked: invoices.length, drifted, repaired, details }
}

/**
 * Invoices past their due date that are still open.
 *
 * Kept here rather than in the invoice service because it is the same class of
 * operation: a periodic sweep that brings stored state in line with reality.
 */
export async function markOverdueInvoices(): Promise<number> {
  const now = new Date()
  const candidates = await Invoice.find({
    status: { $in: [InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.PARTIALLY_PAID] },
    dueDate: { $lt: now },
  }).limit(1000)

  let updated = 0
  for (const invoice of candidates) {
    // Guard against a race with a payment that just settled.
    if (invoice.amountDueMinor <= 0) continue
    invoice.status = InvoiceStatus.OVERDUE
    await invoice.save()
    updated += 1
  }

  if (updated > 0) logger.info({ updated }, 'Marked invoices overdue')
  return updated
}
