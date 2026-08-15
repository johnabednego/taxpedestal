import { NextFunction, Request, Response } from 'express'
import mongoose from 'mongoose'
import { AppError, NotFoundError } from '../core/errors'
import { logger } from '../core/logger'
import { isProduction } from '../config/env'

/** 404 for unmatched routes. Registered after all routers. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Route ${req.method} ${req.path}`))
}

interface ErrorBody {
  error: {
    code: string
    message: string
    requestId?: string
    details?: unknown
    stack?: string
  }
}

/**
 * Terminal error middleware.
 *
 * Translates known error shapes into a stable envelope and — critically —
 * refuses to leak internals. An unexpected error returns a generic message in
 * production while the real cause goes to the logs with the request id, so
 * support can correlate without the stack trace reaching the client.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  let statusCode = 500
  let code = 'INTERNAL_ERROR'
  let message = 'Something went wrong on our side'
  let details: unknown

  if (err instanceof AppError) {
    statusCode = err.statusCode
    code = err.code
    message = err.message
    details = err.details
  } else if (err instanceof mongoose.Error.ValidationError) {
    statusCode = 422
    code = 'VALIDATION_FAILED'
    message = 'Some fields need attention'
    details = {
      fields: Object.fromEntries(
        Object.entries(err.errors).map(([field, e]) => [field, e.message]),
      ),
    }
  } else if (err instanceof mongoose.Error.CastError) {
    statusCode = 400
    code = 'INVALID_IDENTIFIER'
    message = 'That identifier is not valid'
  } else if (isDuplicateKeyError(err)) {
    statusCode = 409
    code = 'CONFLICT'
    const field = Object.keys(err.keyPattern ?? {})[0]
    message = field
      ? `That ${field} is already in use`
      : 'That conflicts with something that already exists'
    details = field ? { field } : undefined
  } else if (err instanceof SyntaxError && 'body' in err) {
    statusCode = 400
    code = 'MALFORMED_JSON'
    message = 'Request body is not valid JSON'
  }

  const logPayload = {
    err: err instanceof Error ? { message: err.message, stack: err.stack } : err,
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    statusCode,
    code,
    userId: req.auth?.userId,
  }

  // 5xx is our fault and gets logged as an error; 4xx is expected traffic.
  if (statusCode >= 500) logger.error(logPayload, 'Unhandled request error')
  else logger.warn(logPayload, 'Request rejected')

  const body: ErrorBody = {
    error: {
      code,
      message,
      requestId: req.requestId,
      ...(details === undefined ? {} : { details }),
    },
  }

  // Stack traces only outside production, and only for genuine 500s.
  if (!isProduction && statusCode >= 500 && err instanceof Error) {
    body.error.stack = err.stack
  }

  res.status(statusCode).json(body)
}

function isDuplicateKeyError(
  err: unknown,
): err is { code: number; keyPattern?: Record<string, unknown> } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 11000
  )
}
