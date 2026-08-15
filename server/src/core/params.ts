import { Request } from 'express'
import { Types } from 'mongoose'
import { NotFoundError } from './errors'

/**
 * Extract a required route parameter.
 *
 * `noUncheckedIndexedAccess` correctly types req.params.x as possibly
 * undefined. Rather than cast that away at every call site (which defeats the
 * setting), these helpers turn a missing or malformed parameter into the 404
 * the client should get anyway.
 */
export function param(req: Request, name: string): string {
  const value = req.params[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new NotFoundError('Route')
  }
  return value
}

/** Validates the shape too, so a malformed id 404s instead of throwing a CastError. */
export function objectIdParam(req: Request, name: string, resource = 'Resource'): Types.ObjectId {
  const value = param(req, name)
  if (!Types.ObjectId.isValid(value)) throw new NotFoundError(resource)
  return new Types.ObjectId(value)
}

/** The authenticated user's id. Requires requireAuth to have run. */
export function actorId(req: Request): Types.ObjectId {
  if (!req.auth?.userId) throw new NotFoundError('Route')
  return new Types.ObjectId(req.auth.userId)
}
