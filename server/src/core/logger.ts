import pino from 'pino'
import { env, isDevelopment, isTest } from '../config/env'

/**
 * Structured logging. JSON in production so log aggregators can index it,
 * pretty-printed in development, silent in tests.
 *
 * Redaction is allow-list-adjacent on purpose: secrets leak through logs more
 * often than through code, and a forgotten `req.body` log containing a password
 * is a breach.
 */
export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-paystack-signature"]',
      'req.headers["stripe-signature"]',
      'req.body.password',
      'req.body.currentPassword',
      'req.body.newPassword',
      'req.body.token',
      'req.body.refreshToken',
      '*.password',
      '*.passwordHash',
      '*.secret',
      '*.apiKey',
      '*.accessToken',
      '*.refreshToken',
    ],
    censor: '[redacted]',
  },
  ...(isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
})

export type Logger = typeof logger
