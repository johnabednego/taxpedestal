import path from 'node:path'
import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config({ path: path.resolve(process.cwd(), '.env') })

/**
 * Environment schema.
 *
 * DESIGN DECISION: the process refuses to boot on invalid configuration.
 *
 * The alternative — reading `process.env.X` at each call site — fails at 3am on
 * the first request that touches the missing variable, in production, with a
 * useless stack trace. Validating once at boot converts a runtime incident into
 * a deploy-time error, which is the cheapest place to find it.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // --- Database -----------------------------------------------------------
    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

    // --- Auth ---------------------------------------------------------------
    // Enforced length: a short secret makes HS256 brute-forceable offline.
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

    // --- URLs ---------------------------------------------------------------
    APP_URL: z.string().url().default('http://localhost:5173'),
    API_URL: z.string().url().default('http://localhost:4000'),
    /** Comma-separated allow-list. Wildcards are not supported by design. */
    CORS_ORIGINS: z.string().default('http://localhost:5173'),

    // --- Payments: Stripe (global cards, wallets, bank debits) --------------
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_PUBLISHABLE_KEY: z.string().optional(),

    // --- Payments: Paystack (African mobile money + cards) -----------------
    PAYSTACK_SECRET_KEY: z.string().optional(),
    PAYSTACK_PUBLIC_KEY: z.string().optional(),

    // --- Email --------------------------------------------------------------
    EMAIL_PROVIDER: z.enum(['console', 'smtp', 'resend']).default('console'),
    EMAIL_FROM: z.string().default('TaxPedestal <billing@taxpedestal.app>'),
    RESEND_API_KEY: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),

    // --- Platform -----------------------------------------------------------
    /** Bootstrap superadmin, created by the seed script only. */
    PLATFORM_ADMIN_EMAIL: z.string().email().optional(),
    PLATFORM_ADMIN_PASSWORD: z.string().optional(),

    /** Toggles the cron scheduler. Disable on serverless deployments. */
    ENABLE_SCHEDULER: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  })
  .superRefine((val, ctx) => {
    // Cross-field rules. A provider selected without its credentials would
    // otherwise fail at first send, long after deploy.
    if (val.EMAIL_PROVIDER === 'resend' && !val.RESEND_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RESEND_API_KEY'],
        message: 'RESEND_API_KEY is required when EMAIL_PROVIDER=resend',
      })
    }
    if (val.EMAIL_PROVIDER === 'smtp' && (!val.SMTP_HOST || !val.SMTP_PORT)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_HOST'],
        message: 'SMTP_HOST and SMTP_PORT are required when EMAIL_PROVIDER=smtp',
      })
    }
    if (val.NODE_ENV === 'production') {
      if (val.JWT_ACCESS_SECRET === val.JWT_REFRESH_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_REFRESH_SECRET'],
          message: 'Access and refresh secrets must differ in production',
        })
      }
      if (!val.STRIPE_SECRET_KEY && !val.PAYSTACK_SECRET_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STRIPE_SECRET_KEY'],
          message: 'At least one payment provider must be configured in production',
        })
      }
    }
  })

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n')
  // Intentionally console.error, not the logger: the logger depends on env.
  console.error(`\nConfiguration is invalid. Fix these and restart:\n${issues}\n`)
  process.exit(1)
}

export const env = parsed.data

export const isProduction = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'
export const isDevelopment = env.NODE_ENV === 'development'

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean)

/** Which payment providers are usable given current configuration. */
export const paymentCapabilities = {
  stripe: Boolean(env.STRIPE_SECRET_KEY),
  paystack: Boolean(env.PAYSTACK_SECRET_KEY),
  manual: true,
}
