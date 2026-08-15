import dayjs from 'dayjs'
import { logger } from '../core/logger'
import { formatMoney } from '../core/money'
import { Client, Invoice, InvoiceStatus, Organisation, type IInvoice } from '../models'
import { sendEmail } from '../services/email'
import { publicInvoiceUrl } from '../modules/invoices/invoice.service'

/**
 * Payment reminders.
 *
 * Cadence is deliberately restrained: 3 days before due, on the due date, then
 * 3, 7 and 14 days after. Chasing harder trains recipients to filter the sender,
 * which costs the user more than the extra nudge gains.
 *
 * MIN_INTERVAL_HOURS is a hard floor regardless of schedule, so a retried job
 * or a clock change cannot produce two emails in a day.
 */
const OFFSETS_DAYS = [-3, 0, 3, 7, 14]
const MIN_INTERVAL_HOURS = 20
const MAX_REMINDERS = 6

export async function sendReminder(
  invoice: IInvoice,
  trigger: 'scheduled' | 'manual',
): Promise<boolean> {
  if (trigger === 'scheduled') {
    if (invoice.reminderCount >= MAX_REMINDERS) return false
    if (
      invoice.lastReminderSentAt &&
      dayjs().diff(dayjs(invoice.lastReminderSentAt), 'hour') < MIN_INTERVAL_HOURS
    ) {
      return false
    }
  }

  const [org, client] = await Promise.all([
    Organisation.findById(invoice.org),
    Client.findById(invoice.client),
  ])
  if (!org || !client?.email) return false

  const daysLate = dayjs().diff(dayjs(invoice.dueDate), 'day')
  const statusLine =
    daysLate > 0
      ? `is now ${daysLate} day${daysLate === 1 ? '' : 's'} overdue`
      : daysLate === 0
        ? 'is due today'
        : `is due in ${Math.abs(daysLate)} day${Math.abs(daysLate) === 1 ? '' : 's'}`

  const result = await sendEmail({
    to: client.email,
    subject: `Reminder: invoice ${invoice.number} — ${formatMoney(invoice.amountDueMinor, invoice.currency)}`,
    template: 'invoice-reminder',
    data: {
      clientName: client.contactName ?? client.name,
      orgName: org.name,
      invoiceNumber: invoice.number,
      amount: formatMoney(invoice.amountDueMinor, invoice.currency),
      statusLine,
      url: publicInvoiceUrl(invoice.publicToken),
    },
    replyTo: org.email ?? undefined,
  })

  if (!result.delivered) return false

  invoice.lastReminderSentAt = new Date()
  invoice.reminderCount += 1
  await invoice.save()
  return true
}

/** Sweep invoices whose due date lands on one of the reminder offsets. */
export async function runReminderSweep(): Promise<{ considered: number; sent: number }> {
  const targetDates = OFFSETS_DAYS.map((offset) =>
    // A reminder at offset -3 means "due in 3 days", i.e. dueDate = today + 3.
    dayjs().subtract(offset, 'day').startOf('day'),
  )

  const ranges = targetDates.map((d) => ({
    $gte: d.toDate(),
    $lte: d.endOf('day').toDate(),
  }))

  const invoices = await Invoice.find({
    status: { $in: [InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.OVERDUE] },
    amountDueMinor: { $gt: 0 },
    $or: ranges.map((r) => ({ dueDate: r })),
  }).limit(500)

  let sent = 0
  for (const invoice of invoices) {
    try {
      if (await sendReminder(invoice, 'scheduled')) sent += 1
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error), invoiceId: invoice._id.toString() },
        'Reminder failed',
      )
    }
  }

  return { considered: invoices.length, sent }
}
