import crypto from 'node:crypto'
import { NextFunction, Request, Response } from 'express'
import { Types } from 'mongoose'
import { ConflictError } from '../core/errors'
import { logger } from '../core/logger'
import { IdempotencyKey } from '../models/IdempotencyKey'

const TTL_HOURS = 24

/**
 * Stripe-compatible idempotency for mutating endpoints.
 *
 * Opt-in: a request without an `Idempotency-Key` header behaves normally, so
 * this cannot break existing callers. With the header, the response is captured
 * and replayed on retry.
 *
 * Replayed responses carry `Idempotency-Replayed: true` so clients can tell the
 * difference, something Stripe does not surface and which makes debugging a
 * retry loop far easier.
 */
export function idempotency(req: Request, res: Response, next: NextFunction): void {
  const key = req.header('idempotency-key')
  if (!key) {
    next()
    return
  }

  if (key.length < 8 || key.length > 255) {
    next(new ConflictError('Idempotency-Key must be between 8 and 255 characters'))
    return
  }

  void (async () => {
    try {
      const requestHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(req.body ?? {}))
        .digest('hex')

      const userId = req.auth?.userId ? new Types.ObjectId(req.auth.userId) : null

      const existing = await IdempotencyKey.findOne({ key, user: userId })

      if (existing) {
        if (existing.requestHash !== requestHash) {
          next(
            new ConflictError(
              'This Idempotency-Key was already used with a different request body',
              { key },
            ),
          )
          return
        }
        if (existing.status === 'IN_FLIGHT') {
          // The original is still running. Returning its (absent) result would
          // be a lie, so tell the client to retry.
          next(
            new ConflictError(
              'A request with this Idempotency-Key is still in progress. Retry shortly.',
              { key },
            ),
          )
          return
        }

        res.setHeader('Idempotency-Replayed', 'true')
        res.status(existing.responseStatus ?? 200).json(existing.responseBody)
        return
      }

      try {
        await IdempotencyKey.create({
          key,
          user: userId,
          org: req.org?.id ?? null,
          method: req.method,
          path: req.path,
          requestHash,
          status: 'IN_FLIGHT',
          expiresAt: new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000),
        })
      } catch (error) {
        // Lost the race against a concurrent identical request.
        if (isDuplicateKey(error)) {
          next(
            new ConflictError(
              'A request with this Idempotency-Key is already in progress. Retry shortly.',
              { key },
            ),
          )
          return
        }
        throw error
      }

      // Capture the response body by wrapping res.json, then persist it.
      const originalJson = res.json.bind(res)
      res.json = ((body: unknown) => {
        void IdempotencyKey.updateOne(
          { key, user: userId },
          {
            $set: {
              status: 'COMPLETED',
              responseStatus: res.statusCode,
              responseBody: body,
            },
          },
        ).catch((error: unknown) => {
          logger.warn(
            { err: error instanceof Error ? error.message : String(error), key },
            'Could not persist idempotent response',
          )
        })
        return originalJson(body)
      }) as Response['json']

      next()
    } catch (error) {
      next(error)
    }
  })()
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 11000
  )
}
