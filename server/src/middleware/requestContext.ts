import crypto from 'node:crypto'
import { NextFunction, Request, Response } from 'express'

/**
 * Attaches a request id and echoes it back in a header.
 *
 * Every log line and every error response carries this id, so a user reporting
 * "it failed at 14:32" can be traced to exact log lines without guessing.
 * An inbound x-request-id is honoured so ids survive across a proxy.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header('x-request-id')
  const id = inbound && /^[\w-]{8,64}$/.test(inbound) ? inbound : crypto.randomUUID()
  req.requestId = id
  res.setHeader('x-request-id', id)
  next()
}
