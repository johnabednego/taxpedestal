import mongoose from 'mongoose'

/**
 * Integration test harness.
 *
 * Uses a real MongoDB rather than mocking Mongoose. Mocked models cannot
 * exercise the mechanisms this codebase depends on for correctness — unique
 * indexes, atomic $inc counters, partial filter expressions, the ledger's
 * immutability guards. Those are precisely what make double-crediting
 * impossible, so they must be tested against a real server.
 *
 * ==========================================================================
 * SAFETY GUARDS — READ BEFORE CHANGING
 * ==========================================================================
 * This harness DROPS THE DATABASE in teardown. Pointing it at a real database
 * destroys that data. That is not hypothetical: the natural thing a developer
 * does is paste their existing Atlas URI into MONGODB_TEST_URI, and that
 * connection string almost always ends in the production database name.
 *
 * Two guards run before any destructive call:
 *
 *   1. The database NAME must look disposable (must contain "test", or start
 *      with "taxpedestal-ci"). A URI ending in /taxpedestal is REFUSED.
 *   2. A REMOTE host must additionally set ALLOW_REMOTE_TEST_DB=yes.
 *      Localhost and in-memory servers are exempt; dropping those is harmless.
 *
 * The guards fail the run loudly rather than skipping, because a
 * misconfiguration here is dangerous and must be seen.
 */

/**
 * The database name must identify itself as disposable.
 *
 * The boundary characters matter. An earlier version used /test([-_]|$)/, which
 * matched "latest", "contest" and "greatest" — all of which END with the
 * literal string "test". A database called `latest` would have been silently
 * accepted and dropped. Caught by tests/unit/database-guard.test.ts.
 *
 * So "test" must be delimited on BOTH sides by a non-alphanumeric character or
 * a string boundary.
 */
const TEST_NAME_PATTERN = /(^|[^a-z0-9])test([^a-z0-9]|$)/i

/** Continuous integration databases are disposable by construction. */
const CI_NAME_PATTERN = /^taxpedestal-ci/i

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '0.0.0.0', '::1']

interface UriFacts {
  databaseName: string
  hosts: string[]
  isLocal: boolean
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator)
  if (index === -1) return [value, '']
  return [value.slice(0, index), value.slice(index + 1)]
}

/** Parse without a driver dependency; handles mongodb:// and mongodb+srv://. */
export function inspectUri(uri: string): UriFacts {
  const withoutScheme = uri.replace(/^mongodb(\+srv)?:\/\//, '')
  const afterCredentials = withoutScheme.includes('@')
    ? withoutScheme.slice(withoutScheme.indexOf('@') + 1)
    : withoutScheme

  const [hostPart = '', rest = ''] = splitOnce(afterCredentials, '/')
  const databaseName = (rest.split('?')[0] ?? '').trim()
  const hosts = hostPart.split(',').map((h) => h.split(':')[0] ?? '')
  const isLocal = hosts.length > 0 && hosts.every((h) => LOCAL_HOSTS.includes(h))

  return { databaseName, hosts, isLocal }
}

/**
 * Throws unless it is safe to run destructive tests against this URI.
 * Exported so it can be unit-tested — a guard nobody tests is not a guard.
 */
export function assertSafeTestDatabase(uri: string): void {
  const { databaseName, hosts, isLocal } = inspectUri(uri)

  if (!databaseName) {
    throw new Error(
      'Refusing to run integration tests: the connection string has no database name, ' +
        'so tests would run against the driver default. Append /taxpedestal-test to the URI.',
    )
  }

  if (!TEST_NAME_PATTERN.test(databaseName) && !CI_NAME_PATTERN.test(databaseName)) {
    throw new Error(
      'Refusing to run integration tests against database "' + databaseName + '".\n' +
        'These tests DROP THE DATABASE in teardown, so its name must identify it as\n' +
        'disposable: it must contain "test".\n\n' +
        '  Point the URI at /' + databaseName + '-test instead. That is a DIFFERENT\n' +
        '  database, created automatically on first write. Your existing data is untouched.\n\n' +
        '  MONGODB_TEST_URI="mongodb+srv://.../' + databaseName + '-test?retryWrites=true&w=majority"',
    )
  }

  if (!isLocal && process.env.ALLOW_REMOTE_TEST_DB !== 'yes') {
    throw new Error(
      'Refusing to run destructive tests against the remote host ' + hosts.join(', ') +
        ' without explicit consent.\n' +
        'If that database really is disposable, set ALLOW_REMOTE_TEST_DB=yes.\n' +
        'Safer: run a local MongoDB with  docker run -d -p 27017:27017 mongo:7',
    )
  }
}

export const mongoAvailable = (): boolean => process.env.__MONGO_AVAILABLE__ === 'true'

export const skipReason = (): string =>
  process.env.__MONGO_SKIP_REASON__ ?? 'no MongoDB instance available'

/**
 * `describe` when a database is reachable, `describe.skip` when not, so the
 * suite reports honestly instead of failing for an environmental reason.
 */
export const describeIntegration = mongoAvailable() ? describe : describe.skip

export async function connectTestDatabase(): Promise<void> {
  const uri = process.env.__MONGO_URI__
  if (!uri) throw new Error('No test database URI was provisioned')

  // Guard on connect as well as teardown: fail BEFORE writing fixtures into
  // someone's real database, not after.
  assertSafeTestDatabase(uri)

  if (mongoose.connection.readyState === 1) return
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20_000 })
}

export async function disconnectTestDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 0) return

  const uri = process.env.__MONGO_URI__
  if (uri) assertSafeTestDatabase(uri)

  await mongoose.connection.dropDatabase().catch(() => undefined)
  await mongoose.disconnect()
}

/** Wipe all collections between tests without rebuilding indexes each time. */
export async function clearCollections(): Promise<void> {
  const collections = mongoose.connection.collections
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})))
}

/**
 * Force index creation. Mongoose builds indexes lazily, and these tests depend
 * on unique constraints being active before the first insert.
 */
export async function syncIndexes(): Promise<void> {
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()))
}
