import { Types } from 'mongoose'
import { logger } from '../../core/logger'
import { formatMoney } from '../../core/money'
import {
  Client,
  Invoice,
  Organisation,
  Payment,
  PaymentStatus,
  User,
  WebhookEvent,
  type IPayment,
} from '../../models'
import { sendEmail } from '../../services/email'
import { getProvider } from '../../services/payments'
import type { ProviderId, TransactionSnapshot } from '../../services/payments/types'
import { applyPayment, publicInvoiceUrl, recordAudit } from '../invoices/invoice.service'

/**
 * Webhook processing.
 *
 * The rules, in the order they are enforced:
 *
 *  1. VERIFY THE SIGNATURE against raw bytes before parsing anything.
 *  2. RECORD THE EVENT with a unique index on (provider, eventId). A duplicate
 *     insert is a caught error, not a second credit. This is the idempotency
 *     guarantee — providers deliver at-least-once, and Paystack retries for 72
 *     hours, so duplicates are certain, not hypothetical.
 *  3. RE-FETCH THE AUTHORITATIVE AMOUNT from the provider's API. The payload is
 *     never trusted for money. Paystack's signature has no timestamp, so a
 *     captured delivery is replayable indefinitely; only a live API check
 *     establishes current truth.
 *  4. CHECK THE AMOUNT AND CURRENCY MATCH what we asked for. A mismatch is
 *     recorded and the invoice is NOT credited automatically.
 *  5. APPLY exactly once, then acknowledge.
 *
 * The endpoint always responds 200 once the event is durably recorded, even if
 * business processing then fails. Returning 5xx would make the provider retry a
 * message we have already stored, and the retry storm is worse than a delayed
 * reconciliation that an operator can replay.
 */

export interface WebhookOutcome {
  status: 'processed' | 'duplicate' | 'ignored' | 'invalid' | 'failed'
  detail?: string
}

export async function handleWebhook(
  providerId: ProviderId,
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
): Promise<WebhookOutcome> {
  const provider = getProvider(providerId)

  // --- 1. Signature ---------------------------------------------------------
  const verification = provider.verifyWebhook(rawBody, headers)

  if (!verification.valid || !verification.eventId) {
    // Recorded even when invalid: a spike in failed verifications is the signal
    // that either a secret was rotated without a deploy, or someone is probing.
    await WebhookEvent.create({
      provider: providerId,
      eventId: `invalid:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
      eventType: 'signature.invalid',
      status: 'FAILED',
      signatureValid: false,
      error: verification.reason ?? 'Signature verification failed',
      payload: { bodyLength: rawBody.length },
    }).catch(() => undefined)

    return { status: 'invalid', detail: verification.reason }
  }

  // --- 2. Idempotent record -------------------------------------------------
  let event
  try {
    event = await WebhookEvent.create({
      provider: providerId,
      eventId: verification.eventId,
      eventType: verification.eventType ?? 'unknown',
      status: 'RECEIVED',
      signatureValid: true,
      payload: verification.payload,
      attempts: 1,
    })
  } catch (error) {
    if (isDuplicateKey(error)) {
      // Already seen. This is the normal, expected path for provider retries.
      logger.info(
        { provider: providerId, eventId: verification.eventId },
        'Duplicate webhook ignored',
      )
      await WebhookEvent.updateOne(
        { provider: providerId, eventId: verification.eventId },
        { $inc: { attempts: 1 } },
      ).catch(() => undefined)
      return { status: 'duplicate' }
    }
    throw error
  }

  try {
    const reference = provider.extractReference(verification.payload)

    if (!reference) {
      event.status = 'IGNORED'
      event.processedAt = new Date()
      await event.save()
      return { status: 'ignored', detail: `Event type ${verification.eventType} is not handled` }
    }

    const outcome = await processPaymentEvent(providerId, reference, verification.eventType ?? '')

    event.status = outcome.status === 'processed' ? 'PROCESSED' : 'IGNORED'
    event.processedAt = new Date()
    if (outcome.detail) event.error = outcome.detail
    await event.save()

    return outcome
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(
      { err: message, provider: providerId, eventId: verification.eventId },
      'Webhook processing failed after the event was recorded',
    )
    event.status = 'FAILED'
    event.error = message
    await event.save().catch(() => undefined)
    // Still a 200 to the provider: the event is stored and replayable.
    return { status: 'failed', detail: message }
  }
}

async function processPaymentEvent(
  providerId: ProviderId,
  reference: string,
  eventType: string,
): Promise<WebhookOutcome> {
  const payment = await Payment.findOne({ providerReference: reference })

  if (!payment) {
    // Not necessarily an error: could be a payment created outside TaxPedestal on
    // the same provider account. Logged so it is visible, not silently dropped.
    logger.warn({ providerId, reference, eventType }, 'Webhook for an unknown payment reference')
    return { status: 'ignored', detail: 'No matching payment record' }
  }

  // Terminal states are never revisited. Without this, a late duplicate that
  // slipped past the event dedupe (different event id, same transaction) would
  // credit the invoice a second time.
  if (payment.status === PaymentStatus.SUCCEEDED && eventType !== 'charge.refunded' && eventType !== 'refund.processed') {
    return { status: 'duplicate', detail: 'Payment already succeeded' }
  }

  // --- 3. Authoritative state ----------------------------------------------
  const provider = getProvider(providerId)
  const snapshot = await provider.fetchTransaction(reference)

  if (snapshot.status === 'refunded') {
    return handleRefund(payment, snapshot)
  }

  if (snapshot.status === 'failed' || snapshot.status === 'abandoned') {
    payment.status =
      snapshot.status === 'failed' ? PaymentStatus.FAILED : PaymentStatus.ABANDONED
    payment.failureCode = snapshot.failureCode ?? null
    payment.failureMessage = snapshot.failureMessage ?? null
    await payment.save()

    await recordAudit({
      org: payment.org,
      actor: null,
      actorLabel: `${providerId} webhook`,
      action: 'payment.failed',
      entityType: 'Payment',
      entityId: payment._id.toString(),
      changes: { reference, reason: snapshot.failureMessage },
    })

    return { status: 'processed', detail: `Payment marked ${payment.status}` }
  }

  if (snapshot.status !== 'succeeded') {
    // Mobile money sits in `pending` until the customer approves the prompt.
    payment.status = PaymentStatus.AWAITING_CUSTOMER
    await payment.save()
    return { status: 'processed', detail: 'Payment still pending customer action' }
  }

  // --- 4. Amount and currency must match -----------------------------------
  const amountMatches = snapshot.amountMinor === payment.amountMinor
  const currencyMatches = snapshot.currency.toUpperCase() === payment.currency.toUpperCase()

  if (!amountMatches || !currencyMatches) {
    // Do NOT credit the invoice. Either the provider settled a different amount
    // (partial capture, FX conversion) or this is a tampered replay. Both need
    // a human, and quietly crediting the wrong figure is unrecoverable.
    logger.error(
      {
        paymentId: payment._id.toString(),
        expected: { amount: payment.amountMinor, currency: payment.currency },
        received: { amount: snapshot.amountMinor, currency: snapshot.currency },
      },
      'Payment amount or currency mismatch — invoice NOT credited',
    )

    payment.status = PaymentStatus.FAILED
    payment.failureCode = 'AMOUNT_MISMATCH'
    payment.failureMessage = `Provider reported ${snapshot.amountMinor} ${snapshot.currency}, expected ${payment.amountMinor} ${payment.currency}`
    await payment.save()

    await recordAudit({
      org: payment.org,
      actor: null,
      actorLabel: `${providerId} webhook`,
      action: 'payment.amount_mismatch',
      entityType: 'Payment',
      entityId: payment._id.toString(),
      changes: {
        expectedAmountMinor: payment.amountMinor,
        receivedAmountMinor: snapshot.amountMinor,
        expectedCurrency: payment.currency,
        receivedCurrency: snapshot.currency,
      },
    })

    return { status: 'failed', detail: 'Amount or currency mismatch' }
  }

  // --- 5. Apply exactly once -----------------------------------------------
  payment.status = PaymentStatus.SUCCEEDED
  payment.paidAt = snapshot.paidAt ?? new Date()
  payment.providerFeeMinor = snapshot.feeMinor
  payment.channelDetail = snapshot.channelDetail
  await payment.save()

  const invoice = await Invoice.findById(payment.invoice)
  if (!invoice) {
    logger.error(
      { paymentId: payment._id.toString() },
      'Payment succeeded but its invoice no longer exists',
    )
    return { status: 'failed', detail: 'Invoice missing' }
  }

  await applyPayment(invoice, payment.amountMinor, {
    actor: null,
    actorLabel: `${providerId} webhook`,
    source: `${providerId}-webhook`,
    paymentId: payment._id,
    // Stable per payment, so a webhook and a reconciliation sweep racing on the
    // same payment produce exactly one credit.
    idempotencyKey: `payment:${payment._id.toString()}`,
  })

  await recordAudit({
    org: payment.org,
    actor: null,
    actorLabel: `${providerId} webhook`,
    action: 'payment.succeeded',
    entityType: 'Payment',
    entityId: payment._id.toString(),
    changes: {
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      invoiceNumber: invoice.number,
      feeMinor: snapshot.feeMinor,
    },
  })

  await notifyPaymentReceived(payment, invoice._id)

  return { status: 'processed' }
}

async function handleRefund(
  payment: IPayment,
  snapshot: TransactionSnapshot,
): Promise<WebhookOutcome> {
  if (payment.refundedAt) {
    return { status: 'duplicate', detail: 'Refund already recorded' }
  }

  payment.status = PaymentStatus.REFUNDED
  payment.refundedAt = new Date()
  payment.refundedAmountMinor = snapshot.amountMinor
  await payment.save()

  // The invoice balance is deliberately NOT reversed automatically. A refund can
  // be partial, disputed, or a chargeback that will itself be reversed, and each
  // needs a different accounting treatment. It is surfaced for review instead.
  await recordAudit({
    org: payment.org,
    actor: null,
    actorLabel: 'provider webhook',
    action: 'payment.refunded',
    entityType: 'Payment',
    entityId: payment._id.toString(),
    changes: { refundedAmountMinor: snapshot.amountMinor, needsReview: true },
  })

  logger.warn(
    { paymentId: payment._id.toString() },
    'Refund recorded — invoice balance needs manual review',
  )

  return { status: 'processed', detail: 'Refund recorded for review' }
}

/** Tell the invoice owner money arrived. Failure here never fails the webhook. */
async function notifyPaymentReceived(
  payment: IPayment,
  invoiceId: Types.ObjectId,
): Promise<void> {
  try {
    const invoice = await Invoice.findById(invoiceId)
    if (!invoice) return

    const [org, client, owner] = await Promise.all([
      Organisation.findById(payment.org),
      Client.findById(invoice.client),
      User.findById(invoice.createdBy),
    ])
    if (!owner?.email) return

    const settled = invoice.amountDueMinor === 0
    await sendEmail({
      to: owner.email,
      subject: `Payment received — ${formatMoney(payment.amountMinor, payment.currency)}`,
      template: 'payment-received',
      data: {
        recipientName: owner.fullName,
        amount: formatMoney(payment.amountMinor, payment.currency),
        invoiceNumber: invoice.number,
        clientName: client?.name ?? null,
        statusLine: settled
          ? `Invoice ${invoice.number} is now paid in full.`
          : `${formatMoney(invoice.amountDueMinor, invoice.currency)} still outstanding.`,
        url: publicInvoiceUrl(invoice.publicToken),
        orgName: org?.name ?? 'your workspace',
      },
    })
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'Could not send payment notification',
    )
  }
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 11000
  )
}
