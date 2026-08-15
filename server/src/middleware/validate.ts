import { NextFunction, Request, Response } from 'express'
import { ZodError, ZodSchema } from 'zod'
import { ValidationError } from '../core/errors'

type Source = 'body' | 'query' | 'params'

/**
 * Validates and REPLACES the request segment with the parsed result.
 *
 * Replacing rather than merely checking is the important part: downstream
 * handlers then receive coerced, stripped, correctly typed data, and any field
 * the schema does not declare is gone. That removes mass-assignment as a class
 * of bug, a client cannot set `platformRole` by adding it to a JSON body.
 */
export function validate(schema: ZodSchema, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      req[source] = schema.parse(req[source]) as never
      next()
    } catch (error) {
      if (error instanceof ZodError) {
        // Flatten to field -> message so the frontend can attach errors to inputs.
        const fields: Record<string, string> = {}
        for (const issue of error.issues) {
          const path = issue.path.join('.') || '_'
          fields[path] ??= issue.message
        }
        next(new ValidationError('Some fields need attention', { fields }))
        return
      }
      next(error)
    }
  }
}
