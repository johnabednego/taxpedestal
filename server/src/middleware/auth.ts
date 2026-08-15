import { NextFunction, Request, Response } from 'express'
import { Types } from 'mongoose'
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../core/errors'
import {
  Membership,
  MembershipStatus,
  OrgRole,
  Organisation,
  PlatformRole,
  ROLE_RANK,
  User,
} from '../models'
import { verifyAccessToken } from '../modules/auth/token.service'

/**
 * Request augmentation.
 *
 * `auth` is set by requireAuth, `org` by requireOrg. Both are optional on the
 * type so a handler that forgets the middleware fails to compile rather than
 * dereferencing undefined at runtime.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string
      auth?: {
        userId: string
        email: string
        platformRole: PlatformRole
      }
      org?: {
        id: Types.ObjectId
        role: OrgRole
        name: string
        slug: string
        country: string
        baseCurrency: string
        taxRegistered: boolean
      }
    }
  }
}

function extractBearer(req: Request): string | null {
  const header = req.header('authorization')
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice(7).trim()
  return token.length > 0 ? token : null
}

/**
 * Verifies the access token and confirms the user is still valid.
 *
 * The token's `tv` claim is compared against the stored tokenVersion, which is
 * what makes "sign out everywhere" and forced revocation take effect
 * immediately rather than after the access token's TTL. It costs one indexed
 * read per request; the alternative is a window where a revoked session still
 * works, which is unacceptable for a financial product.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractBearer(req)
    if (!token) throw new UnauthorizedError('Sign in to continue', 'NO_TOKEN')

    const claims = verifyAccessToken(token)

    const user = await User.findById(claims.sub).select(
      'email platformRole tokenVersion suspendedAt',
    )
    if (!user) throw new UnauthorizedError('Account no longer exists', 'ACCOUNT_MISSING')
    if (user.suspendedAt) throw new ForbiddenError('This account has been suspended')
    if (user.tokenVersion !== claims.tv) {
      throw new UnauthorizedError('Session was revoked', 'TOKEN_REVOKED')
    }

    req.auth = {
      userId: user._id.toString(),
      email: user.email,
      platformRole: user.platformRole,
    }
    next()
  } catch (error) {
    next(error)
  }
}

/**
 * Resolves the active organisation and the caller's role within it.
 *
 * THE TENANT BOUNDARY. The organisation id is taken from a header or param and
 * then verified against an ACTIVE membership — it is never trusted as supplied.
 * Handlers downstream filter by `req.org.id`, so a caller cannot reach another
 * tenant's data by changing a header.
 */
export async function requireOrg(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw new UnauthorizedError('Sign in to continue', 'NO_TOKEN')

    const supplied =
      (req.params.orgId as string | undefined) ??
      req.header('x-organisation-id') ??
      undefined

    const membershipQuery: Record<string, unknown> = {
      user: new Types.ObjectId(req.auth.userId),
      status: MembershipStatus.ACTIVE,
    }

    if (supplied) {
      if (!Types.ObjectId.isValid(supplied)) {
        throw new NotFoundError('Workspace')
      }
      membershipQuery.org = new Types.ObjectId(supplied)
    }

    const membership = await Membership.findOne(membershipQuery).sort({ createdAt: 1 })

    // Deliberately 404, not 403: confirming a workspace exists but is
    // inaccessible tells an attacker their guessed id was real.
    if (!membership) throw new NotFoundError('Workspace')

    const organisation = await Organisation.findById(membership.org).select(
      'name slug country baseCurrency taxRegistered suspendedAt',
    )
    if (!organisation) throw new NotFoundError('Workspace')
    if (organisation.suspendedAt) {
      throw new ForbiddenError('This workspace has been suspended. Contact support.')
    }

    req.org = {
      id: organisation._id,
      role: membership.role,
      name: organisation.name,
      slug: organisation.slug,
      country: organisation.country,
      baseCurrency: organisation.baseCurrency,
      taxRegistered: organisation.taxRegistered,
    }
    next()
  } catch (error) {
    next(error)
  }
}

/**
 * Requires at least the given role. Uses the numeric rank so OWNER
 * automatically satisfies every check without listing roles at each call site.
 */
export function requireRole(minimum: OrgRole) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.org) {
      next(new UnauthorizedError('Workspace context is missing', 'NO_ORG'))
      return
    }
    if (ROLE_RANK[req.org.role] < ROLE_RANK[minimum]) {
      next(
        new ForbiddenError(
          `This action needs the ${minimum.toLowerCase()} role or higher. Yours is ${req.org.role.toLowerCase()}.`,
        ),
      )
      return
    }
    next()
  }
}

/** Platform staff only. Guards the admin console. */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.auth?.platformRole !== PlatformRole.SUPERADMIN) {
    // 404 rather than 403 so the admin surface is not discoverable.
    next(new NotFoundError('Route'))
    return
  }
  next()
}

/** Convenience: the tenant filter every scoped query must include. */
export function scoped(req: Request): { org: Types.ObjectId } {
  if (!req.org) throw new UnauthorizedError('Workspace context is missing', 'NO_ORG')
  return { org: req.org.id }
}
