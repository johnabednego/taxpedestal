import { NextFunction, Request, RequestHandler, Response } from 'express'

/**
 * Wraps an async route handler so a rejected promise reaches Express's error
 * middleware.
 *
 * Express 4 does not await handlers, so an unhandled rejection inside one
 * becomes a request that hangs until the client times out and a process-level
 * warning that never surfaces to the user. Every async handler must be wrapped.
 */
export function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req as T, res, next).catch(next)
  }
}
