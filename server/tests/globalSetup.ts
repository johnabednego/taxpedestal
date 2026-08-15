/**
 * Jest globalSetup, resolve a MongoDB instance for integration tests.
 *
 * Resolution order:
 *   1. MONGODB_TEST_URI env var, an external mongod or a disposable Atlas
 *      database. Use this in CI and in sandboxes with no outbound access.
 *   2. mongodb-memory-server, which downloads a mongod binary on first run.
 *
 * If neither is available the integration suites SKIP rather than fail. A
 * red suite that only means "no database here" trains people to ignore red,
 * which is worse than an explicit skip. Unit tests are unaffected either way.
 */
import type { MongoMemoryReplSet } from 'mongodb-memory-server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const globalThis: any

export default async function globalSetup(): Promise<void> {
  const external = process.env.MONGODB_TEST_URI
  if (external) {
    process.env.__MONGO_URI__ = external
    process.env.__MONGO_AVAILABLE__ = 'true'
    process.env.__MONGO_SOURCE__ = 'external'
    return
  }

  try {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server')
    const replSet: MongoMemoryReplSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    })
    globalThis.__MONGO_REPLSET__ = replSet
    // getUri() with no argument yields ".../?replicaSet=...", a URI with no
    // database path at all. assertSafeTestDatabase then rejects it, because a
    // nameless URI would drop whatever the driver picks as its default. Naming
    // the database here is what lets the guard recognise it as disposable.
    process.env.__MONGO_URI__ = replSet.getUri('taxpedestal-test')
    process.env.__MONGO_AVAILABLE__ = 'true'
    process.env.__MONGO_SOURCE__ = 'memory-server'
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
    process.env.__MONGO_AVAILABLE__ = 'false'
    process.env.__MONGO_SKIP_REASON__ = reason ?? 'unknown'
    // eslint-disable-next-line no-console
    console.warn(
      `\n  Integration tests will be SKIPPED, no MongoDB available.\n  Reason: ${reason}\n  Set MONGODB_TEST_URI to run them (e.g. mongodb://127.0.0.1:27017/taxpedestal-test).\n`,
    )
  }
}
