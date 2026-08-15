import mongoose from 'mongoose'
import { env, isProduction, isServerless, isTest } from './env'
import { logger } from '../core/logger'

/**
 * Database connection.
 *
 * Cached on the module so repeated calls reuse one pool. This matters on
 * serverless, where each invocation may re-enter the module and a fresh
 * connection per request exhausts Atlas's connection limit within minutes.
 */
let connectionPromise: Promise<typeof mongoose> | null = null

export async function connectDatabase(uri = env.MONGODB_URI): Promise<typeof mongoose> {
  if (connectionPromise) return connectionPromise

  // Drop filter conditions on undeclared paths rather than passing them to the
  // driver, so a typo'd field name cannot silently match every document.
  mongoose.set('strictQuery', true)

  // NOTE: `sanitizeFilter` is deliberately NOT enabled globally.
  //
  // It defends against query-selector injection by wrapping any nested object
  // holding a `$`-prefixed key in `$eq`, but it cannot distinguish an operator
  // injected by a caller from one written here. Enabled globally it rewrites
  // every legitimate query, so `{ _id: { $in: ids } }` becomes
  // `{ _id: { $eq: { $in: ids } } }` and throws CastError. That silently broke
  // /auth/me, the dashboard, invoice filters, client search and reminders.
  //
  // The injection it guards against is already closed one layer earlier:
  // `validate()` REPLACES each request segment with its Zod-parsed result, so a
  // caller sending `?search[$ne]=` fails schema validation before any query is
  // built. Ids are cast explicitly and search terms are regex-escaped.

  connectionPromise = mongoose.connect(uri, {
    /**
     * Pool size is per PROCESS, and serverless multiplies processes.
     *
     * A long-lived server keeps one pool, so ten is comfortable. A serverless
     * deployment can hold dozens of concurrent instances, each with its own
     * pool, at ten apiece that exhausts an Atlas free-tier connection limit
     * under very ordinary traffic. Instances there are also short-lived and
     * handle few simultaneous requests, so a small pool costs nothing.
     */
    maxPoolSize: isServerless ? 3 : isProduction ? 10 : 5,
    minPoolSize: 0,
    /**
     * Must stay well inside the function's invocation timeout, or a cold start
     * against an unreachable database burns the whole budget and the caller
     * gets a platform timeout instead of the API's own 503.
     */
    serverSelectionTimeoutMS: isServerless ? 5_000 : 10_000,
    socketTimeoutMS: 45_000,
    // Retry a transient write once before surfacing an error.
    retryWrites: true,
  })

  mongoose.connection.on('error', (err) => {
    logger.error({ err: err.message }, 'MongoDB connection error')
  })
  mongoose.connection.on('disconnected', () => {
    if (!isTest) logger.warn('MongoDB disconnected')
  })
  mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB reconnected')
  })

  const connection = await connectionPromise
  if (!isTest) {
    logger.info({ host: connection.connection.host, db: connection.connection.name }, 'MongoDB connected')
  }
  return connection
}

/**
 * Wait for the connection to be usable, up to `ms`.
 *
 * Readiness is a question about whether traffic can be served, and on
 * serverless the honest answer during a cold start is "yes, shortly" rather
 * than "no". Sampling `readyState` the instant a request arrives reported
 * `connecting` on every cold instance, so `/ready` returned 503 continuously
 * even while ordinary requests succeeded: Mongoose buffers queries until the
 * connection opens, so the login endpoint simply waited where the health check
 * did not.
 *
 * Bounded so a genuinely unreachable database still fails fast and visibly
 * rather than hanging until the platform's own invocation timeout.
 */
export async function waitForDatabase(ms = 4_000): Promise<void> {
  if (mongoose.connection.readyState === 1) return

  /*
   * Waits on an attempt ALREADY in flight; it never starts one.
   *
   * A readiness probe that opens its own connection would report "connecting"
   * on a deployment that has no database configured at all, turning a clear
   * "disconnected" into something more ambiguous. The entry point begins the
   * connection during module startup, so on a real instance there is always an
   * attempt to wait for.
   */
  if (!connectionPromise) return

  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })

  try {
    await Promise.race([
      // A failed connection resolves rather than rejects: the caller reports
      // the resulting state, it does not handle the error.
      connectionPromise.then(
        () => undefined,
        () => undefined,
      ),
      deadline,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function disconnectDatabase(): Promise<void> {
  connectionPromise = null
  await mongoose.disconnect()
}

export function databaseState(): string {
  // readyState can also be 99 ("uninitialized"), which is why this is a lookup
  // map rather than an array index.
  const states: Record<number, string> = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
    99: 'uninitialized',
  }
  return states[mongoose.connection.readyState] ?? 'unknown'
}
