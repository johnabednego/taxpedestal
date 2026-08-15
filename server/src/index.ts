import { createApp } from './app'
import { connectDatabase, disconnectDatabase } from './config/db'
import { env } from './config/env'
import { logger } from './core/logger'
import { startScheduler } from './jobs/scheduler'

/**
 * Process entry point.
 *
 * The database connects BEFORE the port is bound, so the platform's health
 * check cannot mark an instance healthy while it is still unable to serve.
 */
async function bootstrap(): Promise<void> {
  await connectDatabase()

  const app = createApp()
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, appUrl: env.APP_URL },
      'TaxPedestal API listening',
    )
  })

  startScheduler()

  /**
   * Graceful shutdown. Render sends SIGTERM before replacing an instance; without
   * this, in-flight requests are severed mid-response and a payment write can be
   * interrupted between the ledger insert and the status transition.
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

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection')
  })
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error.message, stack: error.stack }, 'Uncaught exception — exiting')
    process.exit(1)
  })
}

void bootstrap().catch((error: unknown) => {
  logger.fatal(
    { err: error instanceof Error ? error.message : String(error) },
    'Failed to start',
  )
  process.exit(1)
})
