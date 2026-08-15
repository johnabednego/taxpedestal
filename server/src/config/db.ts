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
