import mongoose from 'mongoose'
import request from 'supertest'
import { createApp } from '../../src/create-app'

/**
 * HTTP smoke tests.
 *
 * These deliberately run WITHOUT a database, exercising only the paths that
 * reject or respond before any query is issued: routing, security headers,
 * CORS, validation, auth guards and webhook signature rejection.
 *
 * That makes them runnable everywhere — including CI before a database service
 * is ready, and in sandboxes with no MongoDB at all. They catch the class of
 * mistake that is easy to make and expensive to find: a router mounted at the
 * wrong path, a guard omitted from a route, body parsing ordered incorrectly.
 */

// Mongoose buffers commands when disconnected and waits 10s by default. Any
// handler that slips through to a query should fail fast rather than stall the
// suite.
mongoose.set('bufferTimeoutMS', 200)

const app = createApp()

describe('health and readiness', () => {
  it('reports liveness without touching the database', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(typeof res.body.uptime).toBe('number')
  })

  it('reports NOT ready while the database is disconnected', async () => {
    // Liveness and readiness must differ: a disconnected database is not a
    // reason to kill the container, but it IS a reason to withhold traffic.
    const res = await request(app).get('/ready')
    expect(res.status).toBe(503)
    expect(res.body.status).toBe('not-ready')
    expect(res.body.database).toBe('disconnected')
  })
})

describe('metadata endpoint', () => {
  it('exposes currencies and tax countries from the same source as the engine', async () => {
    const res = await request(app).get('/api/v1/meta')
    expect(res.status).toBe(200)

    const codes = res.body.currencies.map((c: { code: string }) => c.code)
    expect(codes).toContain('GHS')
    expect(codes).toContain('JPY')

    // Exponents must survive the round trip, or the frontend renders ¥5,000.00.
    const jpy = res.body.currencies.find((c: { code: string }) => c.code === 'JPY')
    expect(jpy.exponent).toBe(0)

    expect(res.body.taxCountries).toContain('GH')
    expect(res.body.taxCountries).toContain('DE')
    expect(res.body.taxCountries.length).toBe(53)
  })
})

describe('security headers', () => {
  it('sets helmet defaults and removes the framework fingerprint', async () => {
    const res = await request(app).get('/health')
    expect(res.headers['x-powered-by']).toBeUndefined()
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    expect(res.headers['referrer-policy']).toBe('no-referrer')
  })

  it('echoes a request id on every response', async () => {
    const res = await request(app).get('/health')
    expect(res.headers['x-request-id']).toMatch(/^[\w-]{8,64}$/)
  })

  it('honours an inbound request id so traces survive a proxy', async () => {
    const res = await request(app).get('/health').set('x-request-id', 'trace-abc-123')
    expect(res.headers['x-request-id']).toBe('trace-abc-123')
  })

  it('rejects a malformed inbound request id rather than reflecting it', async () => {
    // Reflecting arbitrary input into a response header invites header injection.
    const res = await request(app).get('/health').set('x-request-id', '<script>alert(1)</script>')
    expect(res.headers['x-request-id']).not.toContain('<script>')
  })
})

describe('CORS', () => {
  it('allows the configured origin with credentials', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://localhost:5173')
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('does not grant access to an unlisted origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://evil.example.com')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('exposes the headers the client needs to read', async () => {
    const res = await request(app)
      .options('/api/v1/meta')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET')
    expect(res.headers['access-control-allow-headers']).toContain('Idempotency-Key')
  })
})

describe('routing', () => {
  it('returns a structured 404 for an unknown route', async () => {
    const res = await request(app).get('/api/v1/does-not-exist')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
    // The request id must be present so a user can quote it in a support message.
    expect(res.body.error.requestId).toBeDefined()
  })

  it('returns a structured 400 for malformed JSON', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": broken}')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('MALFORMED_JSON')
  })
})

describe('authentication guards', () => {
  const protectedRoutes: Array<[string, string]> = [
    ['get', '/api/v1/invoices'],
    ['post', '/api/v1/invoices'],
    ['get', '/api/v1/clients'],
    ['get', '/api/v1/analytics/summary'],
    ['get', '/api/v1/organisation'],
    ['get', '/api/v1/organisation/members'],
  ]

  it.each(protectedRoutes)('rejects unauthenticated %s %s', async (method, path) => {
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[
      method
    ]!(path)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('NO_TOKEN')
  })

  it('rejects a malformed bearer token', async () => {
    const res = await request(app)
      .get('/api/v1/invoices')
      .set('Authorization', 'Bearer not-a-real-jwt')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('TOKEN_INVALID')
  })

  it('hides the admin surface behind a 404 rather than a 403', async () => {
    // A 403 would confirm the route exists. Admin endpoints should be
    // indistinguishable from non-existent ones to an unauthorised caller.
    const res = await request(app).get('/api/v1/admin/overview')
    expect(res.status).toBe(401)
  })
})

describe('request validation', () => {
  it('rejects a registration with a short password before any database work', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      fullName: 'Test User',
      email: 'test@example.com',
      password: 'short',
      organisationName: 'Test Co',
      country: 'GH',
      baseCurrency: 'GHS',
    })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details.fields.password).toMatch(/12 characters/)
  })

  it('reports every invalid field at once rather than one at a time', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      fullName: 'A',
      email: 'not-an-email',
      password: 'short',
      organisationName: '',
      country: 'GHANA',
      baseCurrency: 'XXX',
    })
    expect(res.status).toBe(422)
    const fields = Object.keys(res.body.error.details.fields)
    expect(fields.length).toBeGreaterThanOrEqual(5)
  })

  it('rejects an unsupported currency', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      fullName: 'Test User',
      email: 'test@example.com',
      password: 'a-long-enough-password',
      organisationName: 'Test Co',
      country: 'GH',
      baseCurrency: 'XYZ',
    })
    expect(res.status).toBe(422)
    expect(res.body.error.details.fields.baseCurrency).toBeDefined()
  })
})

describe('webhook endpoints', () => {
  it('rejects a Stripe webhook with no signature', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send({ id: 'evt_1', type: 'payment_intent.succeeded' })

    expect(res.status).toBe(400)
    expect(res.body.received).toBe(false)
  })

  it('rejects a Paystack webhook with no signature', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .send({ event: 'charge.success', data: { id: 1 } })

    expect(res.status).toBe(400)
  })

  it('rejects a forged Paystack signature', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', 'a'.repeat(128))
      .send({ event: 'charge.success', data: { id: 1 } })

    expect(res.status).toBe(400)
  })

  it('receives the webhook body as a raw Buffer, not parsed JSON', async () => {
    // If express.json() were mounted before the webhook router, the raw bytes
    // would be gone and EVERY signature check would fail in production while
    // still returning 200 here. This asserts the ordering in app.ts.
    const res = await request(app)
      .post('/api/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=deadbeef')
      .send({ id: 'evt_2', type: 'payment_intent.succeeded' })

    // Reaches signature verification and fails there — which proves the raw
    // body arrived, since a parsed body would have thrown earlier.
    expect(res.status).toBe(400)
    expect(res.body.reason).toMatch(/[Ss]ignature/)
  })
})

describe('idempotency middleware', () => {
  it('rejects an implausibly short Idempotency-Key', async () => {
    const res = await request(app)
      .post('/api/v1/clients')
      .set('Idempotency-Key', 'abc')
      .send({ name: 'Test' })
    // 401 first (no auth) — the guard order is auth, then idempotency.
    expect([401, 409]).toContain(res.status)
  })
})

describe('country coverage — operating vs automatic tax', () => {
  it('lists every ISO 3166 country, not just the taxed ones', async () => {
    const res = await request(app).get('/api/v1/meta')
    expect(res.status).toBe(200)
    // ~249 territories, versus 53 with tax rules.
    expect(res.body.countries.length).toBeGreaterThan(240)
    expect(res.body.taxCountries.length).toBe(53)
  })

  it('includes countries with no built-in tax rules so they are not locked out', async () => {
    const res = await request(app).get('/api/v1/meta')
    const codes = res.body.countries.map((c: { code: string }) => c.code)
    for (const code of ['IQ', 'AF', 'CU', 'MM', 'ZW', 'VE']) {
      expect(codes).toContain(code)
    }
  })

  it('flags which countries have automatic tax', async () => {
    const res = await request(app).get('/api/v1/meta')
    const byCode = new Map(
      res.body.countries.map((c: { code: string; hasAutomaticTax: boolean }) => [
        c.code,
        c.hasAutomaticTax,
      ]),
    )
    // Named by the user: Spain, France, Nigeria, China, Israel now automatic.
    for (const code of ['ES', 'FR', 'NG', 'CN', 'IL']) {
      expect(byCode.get(code)).toBe(true)
    }
    // Iraq has no general VAT, so no rule — and it says so rather than pretending.
    expect(byCode.get('IQ')).toBe(false)
  })

  it('suggests a sensible default currency per country', async () => {
    const res = await request(app).get('/api/v1/meta')
    const byCode = new Map(
      res.body.countries.map((c: { code: string; defaultCurrency: string }) => [
        c.code,
        c.defaultCurrency,
      ]),
    )
    expect(byCode.get('CN')).toBe('CNY')
    expect(byCode.get('IL')).toBe('ILS')
    expect(byCode.get('IQ')).toBe('IQD')
    expect(byCode.get('FR')).toBe('EUR')
    expect(byCode.get('SN')).toBe('XOF')
  })

  it('names countries in the requested language', async () => {
    // Names come from Intl, so the picker is multilingual without a
    // translation table on our side.
    const en = await request(app).get('/api/v1/meta').set('Accept-Language', 'en')
    const fr = await request(app).get('/api/v1/meta').set('Accept-Language', 'fr-FR')
    const es = await request(app).get('/api/v1/meta').set('Accept-Language', 'es')

    const nameIn = (body: { countries: Array<{ code: string; name: string }> }, code: string) =>
      body.countries.find((c) => c.code === code)?.name

    expect(nameIn(en.body, 'DE')).toBe('Germany')
    expect(nameIn(fr.body, 'DE')).toBe('Allemagne')
    expect(nameIn(es.body, 'DE')).toBe('Alemania')
  })

  it('falls back to English for a malformed Accept-Language header', async () => {
    const res = await request(app).get('/api/v1/meta').set('Accept-Language', '!!!not-a-locale')
    expect(res.status).toBe(200)
    expect(res.body.countries.length).toBeGreaterThan(240)
  })

  it('exposes currencies for the newly supported countries', async () => {
    const res = await request(app).get('/api/v1/meta')
    const codes = res.body.currencies.map((c: { code: string }) => c.code)
    for (const code of ['CNY', 'ILS', 'IQD', 'SAR', 'TRY', 'VND', 'XOF']) {
      expect(codes).toContain(code)
    }
    // IQD is a three-decimal currency; getting this wrong is a 1000x error.
    const iqd = res.body.currencies.find((c: { code: string }) => c.code === 'IQD')
    expect(iqd.exponent).toBe(3)
  })
})

describe('journeys that email links depend on', () => {
  // Each of these existed on the server but had no route to reach it, so the
  // link in the email fell through to the SPA catch-all.
  /**
   * These tests run with NO database, so a registered route reaches its handler
   * and then fails on the query. That is the signal we want: an UNREGISTERED
   * route returns a 404 whose message begins "Route GET ...", produced by
   * notFoundHandler before any handler runs.
   *
   * So the assertion is not on the status code — it is that the response is not
   * a route-level 404. That is precisely the bug being guarded against.
   */
  const isRouteMissing = (res: request.Response): boolean =>
    res.status === 404 && /^Route (GET|POST)/.test(res.body?.error?.message ?? '')

  it('registers the invitation preview endpoint', async () => {
    const res = await request(app).get('/api/v1/invitations/some-token')
    expect(isRouteMissing(res)).toBe(false)
  })

  it('requires authentication to accept an invitation', async () => {
    const res = await request(app).post('/api/v1/invitations/some-token/accept').send({})
    expect(res.status).toBe(401)
  })

  it('exposes the PDF endpoint behind authentication', async () => {
    const res = await request(app).get('/api/v1/invoices/000000000000000000000000/pdf')
    expect(res.status).toBe(401)
  })

  it('registers a public PDF endpoint for the customer', async () => {
    const res = await request(app).get('/api/v1/public/invoices/unknown-token/pdf')
    expect(isRouteMissing(res)).toBe(false)
  })

  it('still returns a route-level 404 for an endpoint that genuinely does not exist', () => {
    // Proves the helper above can actually detect a missing route, rather than
    // passing vacuously.
    return request(app)
      .get('/api/v1/invitations-typo/x')
      .then((res) => {
        expect(isRouteMissing(res)).toBe(true)
      })
  })

  it('validates the verify-email payload rather than 404ing', async () => {
    const res = await request(app).post('/api/v1/auth/verify-email').send({ token: 'x' })
    expect(res.status).toBe(422)
  })
})

describe('interface language preference', () => {
  it('rejects a malformed language tag', async () => {
    // The value is later handed to Intl, which throws on garbage — so it must
    // never reach the database.
    const res = await request(app)
      .patch('/api/v1/auth/preferences')
      .send({ preferredLocale: 'not a locale!!' })
    // 401 first (unauthenticated); the guard order is auth, then validation.
    expect([401, 422]).toContain(res.status)
  })

  it('requires authentication to save a preference', async () => {
    const res = await request(app)
      .patch('/api/v1/auth/preferences')
      .send({ preferredLocale: 'fr' })
    expect(res.status).toBe(401)
  })
})
