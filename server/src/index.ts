import express from 'express'
import { configureApp } from './create-app'
import { connectDatabase, disconnectDatabase } from './config/db'
import { env, isServerless } from './config/env'
import { logger } from './core/logger'
import { startScheduler } from './jobs/scheduler'

/**
 * Process entry point.
 *
 * ============================================================================
 * THIS FILE RUNS ON BOTH A LONG-LIVED SERVER AND ON VERCEL
 * ============================================================================
 * Vercel's Express support detects an entry point BY FILENAME and captures the
 * server created by `app.listen()`, the port is never exposed publicly, it is
 * how the platform finds the app. The search order is
 * `app.* → index.* → server.* → src/app.* → src/index.* → src/server.*`, so
 * this file only wins because the factory next door is named `create-app.ts`
 * rather than `app.ts`. See the note at the top of that file.
 *
 * The detector then requires the chosen file to IMPORT EXPRESS ITSELF, * importing a factory that imports express is not enough, and fails with
 * "No entrypoint found which imports express". That is why the `express()`
 * call lives here and the configuration is applied by `configureApp`, rather
 * than this module calling a `createApp()` that hides both.
 *
 * Detection happens during MODULE STARTUP, which drives the two differences
 * from a conventional server:
 *
 *   1. The listener is bound synchronously. The previous version awaited the
 *      database first, so on a cold start nothing was listening until Atlas
 *      answered. Mongoose buffers commands until it connects, so binding first
 *      and connecting alongside loses nothing: an early request waits for the
 *      connection instead of being refused by a server that does not yet exist.
 *
 *   2. Signal handlers and `process.exit` are installed only off-serverless.
 *      A function instance is shared between invocations; tearing the process
 *      down from inside one request would abort the others in flight.
 *
 * `/health` deliberately does not touch the database, and `/ready` reports 503
 * until the connection is up, so the window before the database is ready is
 * visible rather than silent.
 */
const app = configureApp(express())

// Not awaited: see (1) above. A failure is logged and left to `/ready` to
// report, throwing here would take down an instance that can still serve the
// health endpoints and return honest 503s.
void connectDatabase().catch((error: unknown) => {
  logger.error(
    { err: error instanceof Error ? error.message : String(error) },
    'Database connection failed at startup',
  )
})

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV, appUrl: env.APP_URL, serverless: isServerless },
    'TaxPedestal API listening',
  )
})

/**
 * In-process cron. Disabled on serverless, where a schedule registered inside a
 * function instance either never fires or fires once per cold start. Vercel
 * drives the same jobs through HTTP instead, see `cron.routes.ts`.
 */
startScheduler()

if (!isServerless) {
  /**
   * Graceful shutdown. A platform that replaces instances sends SIGTERM first;
   * without this, in-flight requests are severed mid-response and a payment
   * write can be interrupted between the ledger insert and the status change.
   */
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down')
    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0))
    })
    // Do not hang forever if a connection refuses to close.
    setTimeout(() => {
      logger.error('Forced shutdown after timeout')
      process.exit(1)
    }, 15_000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error.message, stack: error.stack }, 'Uncaught exception, exiting')
    process.exit(1)
  })
}

// Logged on every platform: an unhandled rejection is a defect wherever it
// happens, but it must not exit a shared serverless instance.
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection')
})

/**
 * Also exported as a default, which is the other shape Vercel accepts. Harmless
 * on a conventional server, and it keeps the entry point working if the
 * platform ever prefers the export over the listener.
 */
export default app
