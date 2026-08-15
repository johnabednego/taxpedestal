/**
 * Error taxonomy.
 *
 * Every error crossing the HTTP boundary carries a machine-readable `code` in
 * addition to a status. Clients branch on codes, never on message strings,
 * so copy can be rewritten without breaking the frontend.
 */

export class AppError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly details?: unknown
  /** Expected errors are safe to show the user; unexpected ones are masked. */
  readonly isOperational: boolean

  constructor(
    message: string,
    statusCode = 500,
    code = 'INTERNAL_ERROR',
    details?: unknown,
    isOperational = true,
  ) {
    super(message)
    this.name = new.target.name
    this.statusCode = statusCode
    this.code = code
    this.details = details
    this.isOperational = isOperational
    Error.captureStackTrace?.(this, new.target)
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Request could not be processed', details?: unknown) {
    super(message, 400, 'BAD_REQUEST', details)
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Some fields need attention', details?: unknown) {
    super(message, 422, 'VALIDATION_FAILED', details)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Sign in to continue', code = 'UNAUTHORIZED') {
    super(message, 401, code)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Your role does not allow this action') {
    super(message, 403, 'FORBIDDEN')
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND')
  }
}

export class ConflictError extends AppError {
  constructor(message = 'That conflicts with something that already exists', details?: unknown) {
    super(message, 409, 'CONFLICT', details)
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests. Try again shortly.') {
    super(message, 429, 'RATE_LIMITED')
  }
}

/** A downstream provider (payment gateway, mail relay) failed. */
export class UpstreamError extends AppError {
  constructor(provider: string, message = 'Upstream provider request failed', details?: unknown) {
    super(message, 502, 'UPSTREAM_FAILED', { provider, ...(details as object) })
  }
}

export class PaymentError extends AppError {
  constructor(message = 'Payment could not be completed', details?: unknown) {
    super(message, 402, 'PAYMENT_FAILED', details)
  }
}
