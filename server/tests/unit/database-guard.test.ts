import { assertSafeTestDatabase, inspectUri } from '../helpers/database'

/**
 * Tests for the safety guard.
 *
 * A guard nobody tests is not a guard. These run in the unit suite (no database
 * required) so they execute everywhere, including in sandboxes with no Mongo.
 */

const ORIGINAL_ALLOW = process.env.ALLOW_REMOTE_TEST_DB

afterEach(() => {
  if (ORIGINAL_ALLOW === undefined) delete process.env.ALLOW_REMOTE_TEST_DB
  else process.env.ALLOW_REMOTE_TEST_DB = ORIGINAL_ALLOW
})

describe('inspectUri', () => {
  it('extracts the database name from a standard URI', () => {
    expect(inspectUri('mongodb://127.0.0.1:27017/taxpedestal-test').databaseName).toBe('taxpedestal-test')
  })

  it('extracts the database name from an SRV URI with credentials and options', () => {
    const facts = inspectUri(
      'mongodb+srv://user:p%40ss@cluster0.abcde.mongodb.net/taxpedestal?retryWrites=true&w=majority',
    )
    expect(facts.databaseName).toBe('taxpedestal')
    expect(facts.hosts).toEqual(['cluster0.abcde.mongodb.net'])
    expect(facts.isLocal).toBe(false)
  })

  it('does not mistake a password containing @ or / for the host', () => {
    const facts = inspectUri('mongodb+srv://admin:pa%2Fss@word@cluster.mongodb.net/x-test')
    expect(facts.databaseName).toBe('x-test')
  })

  it('recognises local hosts', () => {
    expect(inspectUri('mongodb://localhost:27017/taxpedestal-test').isLocal).toBe(true)
    expect(inspectUri('mongodb://127.0.0.1:27017/taxpedestal-test').isLocal).toBe(true)
  })

  it('handles a replica set host list', () => {
    const facts = inspectUri('mongodb://127.0.0.1:27017,127.0.0.1:27018/taxpedestal-test')
    expect(facts.hosts).toHaveLength(2)
    expect(facts.isLocal).toBe(true)
  })

  it('reports an empty database name when none is given', () => {
    expect(inspectUri('mongodb://127.0.0.1:27017').databaseName).toBe('')
  })
})

describe('assertSafeTestDatabase, refuses to destroy real data', () => {
  it('REFUSES a production-looking Atlas database', () => {
    // This is the exact shape of a connection string a developer pastes in.
    // Teardown drops the database, so this must never be allowed through.
    expect(() =>
      assertSafeTestDatabase(
        'mongodb+srv://user:pass@cluster0.yn9ml.mongodb.net/taxpedestal?retryWrites=true&w=majority',
      ),
    ).toThrow(/Refusing to run integration tests against database "taxpedestal"/)
  })

  it('names the safe alternative in the error message', () => {
    // An error that only says "no" makes people disable the guard. It must say
    // exactly what to do instead.
    expect(() =>
      assertSafeTestDatabase('mongodb+srv://u:p@host.mongodb.net/billing'),
    ).toThrow(/billing-test/)
  })

  it('REFUSES a URI with no database name', () => {
    expect(() => assertSafeTestDatabase('mongodb://127.0.0.1:27017')).toThrow(
      /no database name/,
    )
  })

  it('allows a local test database', () => {
    expect(() =>
      assertSafeTestDatabase('mongodb://127.0.0.1:27017/taxpedestal-test'),
    ).not.toThrow()
  })

  it('allows the in-memory replica set naming used by mongodb-memory-server', () => {
    expect(() =>
      assertSafeTestDatabase('mongodb://127.0.0.1:41253/jest-test?replicaSet=testset'),
    ).not.toThrow()
  })

  it('REFUSES a remote test database without explicit consent', () => {
    delete process.env.ALLOW_REMOTE_TEST_DB
    expect(() =>
      assertSafeTestDatabase('mongodb+srv://u:p@cluster0.yn9ml.mongodb.net/taxpedestal-test'),
    ).toThrow(/without explicit consent/)
  })

  it('allows a remote test database once consent is given', () => {
    process.env.ALLOW_REMOTE_TEST_DB = 'yes'
    expect(() =>
      assertSafeTestDatabase('mongodb+srv://u:p@cluster0.yn9ml.mongodb.net/taxpedestal-test'),
    ).not.toThrow()
  })

  it('still refuses a remote PRODUCTION database even with consent given', () => {
    // Consent covers "this remote host is fine", not "drop anything".
    // The name check is not overridable.
    process.env.ALLOW_REMOTE_TEST_DB = 'yes'
    expect(() =>
      assertSafeTestDatabase('mongodb+srv://u:p@cluster0.yn9ml.mongodb.net/taxpedestal'),
    ).toThrow(/Refusing to run integration tests against database/)
  })

  it('accepts several conventional test database names', () => {
    for (const name of ['taxpedestal-test', 'test', 'taxpedestal_test', 'test_db', 'taxpedestal-ci-42']) {
      expect(() => assertSafeTestDatabase(`mongodb://127.0.0.1:27017/${name}`)).not.toThrow()
    }
  })

  it('rejects names that merely resemble test names', () => {
    // "latest" and "contest" contain "test" as a substring but are not test
    // databases. The pattern requires a word boundary.
    for (const name of ['latest', 'contest', 'greatest']) {
      expect(() => assertSafeTestDatabase(`mongodb://127.0.0.1:27017/${name}`)).toThrow()
    }
  })
})
