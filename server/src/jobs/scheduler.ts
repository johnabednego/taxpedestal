import cron from 'node-cron'
import { env } from '../config/env'
import { logger } from '../core/logger'
import {
  markOverdueInvoices,
  reconcileBalances,
  reconcilePendingPayments,
} from '../modules/invoices/reconciliation.service'
import { runReminderSweep } from './reminders'

/**
 * Background schedule.
 *
 * Disabled when ENABLE_SCHEDULER=false, which is required on serverless: a
 * cron registered inside a function instance either never fires or fires once
 * per cold start. On Render (a long-lived process) it works as expected.
 *
 * Every job is guarded by `running` so a slow run cannot overlap itself.
 */
const running = new Set<string>()

async function runExclusive(name: string, fn: () => Promise<unknown>): Promise<void> {
  if (running.has(name)) {
    logger.warn({ job: name }, 'Skipping scheduled run, previous run still in progress')
    return
  }
  running.add(name)
  const startedAt = Date.now()
  try {
    const result = await fn()
    logger.info({ job: name, ms: Date.now() - startedAt, result }, 'Scheduled job finished')
  } catch (error) {
    logger.error(
      { job: name, err: error instanceof Error ? error.message : String(error) },
      'Scheduled job failed',
    )
  } finally {
    running.delete(name)
  }
}

export function startScheduler(): void {
  if (!env.ENABLE_SCHEDULER) {
    logger.info('Scheduler disabled (ENABLE_SCHEDULER=false)')
    return
  }

  // Every 10 minutes: recover payments whose webhook never arrived. This is the
  // safety net for the "paid but no value" failure mode.
  cron.schedule('*/10 * * * *', () => {
    void runExclusive('reconcile-payments', () => reconcilePendingPayments({ limit: 200 }))
  })

  // Hourly: move past-due invoices to OVERDUE.
  cron.schedule('7 * * * *', () => {
    void runExclusive('mark-overdue', () => markOverdueInvoices())
  })

  // Daily 09:00 UTC: reminder sweep. A fixed hour avoids sending at 3am.
  cron.schedule('0 9 * * *', () => {
    void runExclusive('reminders', () => runReminderSweep())
  })

  // Daily 02:30 UTC: verify cached balances against the ledger.
  cron.schedule('30 2 * * *', () => {
    void runExclusive('reconcile-balances', () => reconcileBalances({ limit: 1000, repair: true }))
  })

  logger.info('Scheduler started')
}
