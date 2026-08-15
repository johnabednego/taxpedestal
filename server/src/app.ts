import compression from 'compression'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { Express } from 'express'
import helmet from 'helmet'
import hpp from 'hpp'
import { corsOrigins, env, isProduction, paymentCapabilities } from './config/env'
import { databaseState } from './config/db'
import { logger } from './core/logger'
import { errorHandler, notFoundHandler } from './middleware/errorHandler'
import { globalLimiter } from './middleware/rateLimit'
import { requestContext } from './middleware/requestContext'
import { listCountries, defaultCurrencyFor } from './core/countries'
import { SUPPORTED_CURRENCY_CODES, CURRENCIES } from './core/money'
import { supportedTaxCountries } from './services/tax/engine'

import adminRoutes from './modules/admin/admin.routes'
import analyticsRoutes from './modules/analytics/analytics.routes'
import authRoutes from './modules/auth/auth.routes'
import clientRoutes from './modules/clients/client.routes'
import invoiceRoutes from './modules/invoices/invoice.routes'
import invitationRoutes from './modules/orgs/invitation.routes'
import orgRoutes from './modules/orgs/org.routes'
import previewRoutes from './modules/public/preview.routes'
import publicRoutes from './modules/public/public.routes'
import webhookRoutes from './modules/payments/webhook.routes'

/**
 * Application assembly.
 *
 * MIDDLEWARE ORDER IS LOAD-BEARING. Two placements in particular:
 *
 *  1. WEBHOOKS ARE MOUNTED BEFORE express.json(). Signature verification hashes
 *     the exact bytes the provider sent. Once express.json() has parsed the
 *     body those bytes are gone, and re-serialising produces a different digest
 *     whenever key order or whitespace differs. Mounting after the JSON parser
 *     breaks every webhook — silently, since the endpoint still returns 200.
 *
 *  2. requestContext runs first, so even a body-parser failure is logged with a
 *     request id the user can quote.
 */
export function createApp(): Express {
  const app = express()

  // Render and Vercel sit behind a proxy. Without this, req.ip is the proxy's
  // address and every rate limit becomes global rather than per-client.
  app.set('trust proxy', 1)
  app.disable('x-powered-by')

  app.use(requestContext)

  app.use(
    helmet({
      // The API serves JSON, never HTML, so a restrictive CSP costs nothing.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // HSTS only in production; on localhost it would pin http://localhost to
      // https for the developer's whole browser.
      hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  )

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and server-to-server requests send no Origin header.
        if (!origin) return callback(null, true)
        if (corsOrigins.includes(origin)) return callback(null, true)
        logger.warn({ origin }, 'Blocked a cross-origin request')
        // Reject by refusing the header rather than throwing, which would
        // surface as an opaque 500 to the browser.
        return callback(null, false)
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Organisation-Id',
        'X-Request-Id',
        'Idempotency-Key',
        // The interface language the user CHOSE. Accept-Language cannot serve
        // here: it is a forbidden header name, so a browser client cannot set
        // it, and it reports the browser's configuration rather than the
        // in-app selection. The two differ whenever someone picks a language.
        'X-Locale',
      ],
      exposedHeaders: ['X-Request-Id', 'Idempotency-Replayed'],
      maxAge: 86_400,
    }),
  )

  app.use(compression())

  /* --- Webhooks: BEFORE the JSON parser. See note above. ----------------- */
  app.use('/api/v1/webhooks', webhookRoutes)

  /* --- Body parsing ------------------------------------------------------ */
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: false, limit: '1mb' }))
  app.use(cookieParser())
  // Collapses duplicated query parameters, which otherwise arrive as arrays and
  // bypass string validators.
  app.use(hpp())

  app.use('/api/v1', globalLimiter)

  /* --- Health ------------------------------------------------------------ */
  // Liveness: is the process up? Must not touch the database, or a brief DB
  // blip causes the platform to kill an otherwise healthy container.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() })
  })

  // Readiness: can we actually serve traffic?
  app.get('/ready', (_req, res) => {
    const db = databaseState()
    const ready = db === 'connected'
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not-ready',
      database: db,
      providers: paymentCapabilities,
    })
  })

  /* --- Public metadata --------------------------------------------------- */
  /**
   * Reference data for the client.
   *
   * TWO SEPARATE COUNTRY LISTS, and the distinction is the point:
   *   `countries`    — every ISO 3166 territory. Anyone can operate anywhere.
   *   `taxCountries` — where TaxPedestal computes tax automatically.
   *
   * The UI shows all countries and marks which have automatic tax, so a
   * business in an uncovered country sees an honest capability note rather than
   * an absent option.
   *
   * Country NAMES are resolved per-locale via Intl, so the picker reads in the
   * user's language without us shipping a translation table.
   */
  app.get('/api/v1/meta', (req, res) => {
    // An explicit in-app choice wins over the browser's configured languages.
    const locale = parseLocale(req.header('x-locale') ?? req.header('accept-language'))

    res.json({
      locale,
      countries: listCountries(locale).map((country) => ({
        ...country,
        defaultCurrency: defaultCurrencyFor(country.code),
        hasAutomaticTax: supportedTaxCountries().includes(country.code),
      })),
      currencies: SUPPORTED_CURRENCY_CODES.map((code) => ({
        code,
        ...CURRENCIES[code],
      })),
      taxCountries: supportedTaxCountries(),
      providers: paymentCapabilities,
      appUrl: env.APP_URL,
    })
  })

  /* --- Routes ------------------------------------------------------------ */
  app.use('/api/v1/auth', authRoutes)
  app.use('/api/v1/organisation', orgRoutes)
  // Invitation preview is unauthenticated; acceptance is guarded inside.
  app.use('/api/v1/invitations', invitationRoutes)
  app.use('/api/v1/clients', clientRoutes)
  // Mounted BEFORE the authenticated invoice router so the anonymous preview
  // path bypasses the auth guard while every other /invoices route does not.
  app.use('/api/v1/invoices', previewRoutes)
  app.use('/api/v1/invoices', invoiceRoutes)
  app.use('/api/v1/analytics', analyticsRoutes)
  app.use('/api/v1/admin', adminRoutes)
  // Unauthenticated customer-facing pages.
  app.use('/api/v1/public/invoices', publicRoutes)

  /* --- Errors: always last ----------------------------------------------- */
  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}

/**
 * Pick a usable locale from an Accept-Language header.
 *
 * Only the primary tag is taken, and it is validated against Intl rather than
 * trusted — an arbitrary header value reaching Intl.DisplayNames throws, and a
 * malformed one must not 500 a reference endpoint.
 */
function parseLocale(header: string | undefined): string {
  const candidate = header?.split(',')[0]?.split(';')[0]?.trim()
  if (!candidate) return 'en'
  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? 'en'
  } catch {
    return 'en'
  }
}
