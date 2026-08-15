import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../../core/asyncHandler'
import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors'
import { actorId, param } from '../../core/params'
import { requireAuth } from '../../middleware/auth'
import { publicLimiter, sensitiveLimiter } from '../../middleware/rateLimit'
import { validate } from '../../middleware/validate'
import { Membership, MembershipStatus, Organisation, User } from '../../models'
import { recordAudit } from '../invoices/invoice.service'
import { hashToken } from '../auth/token.service'

/**
 * Team invitations.
 *
 * These endpoints close a journey that was previously broken: an invitation
 * email was sent containing a link, the token was hashed and stored, and
 * nothing ever read it back. The invitee clicked through to a page that did not
 * exist. The backend looked complete because every piece existed except the one
 * that made them a sequence.
 *
 * The flow:
 *   1. GET  /:token, preview, unauthenticated. Shows who invited you
 *                              and to what, so the invitee knows whether to
 *                              sign in or create an account.
 *   2. POST /:token/accept, authenticated. Binds the pending membership to
 *                              the signed-in user.
 */
const router = Router()

/**
 * Preview an invitation without signing in.
 *
 * Returns only what the invitee needs to decide: the workspace name, the role
 * and the address it was sent to. No member list, no financial data, the token
 * is in a URL and URLs leak.
 */
router.get(
  '/:token',
  publicLimiter,
  asyncHandler(async (req, res) => {
    const token = param(req, 'token')

    const membership = await Membership.findOne({
      invitationTokenHash: hashToken(token),
      status: MembershipStatus.INVITED,
    }).select('+invitationTokenHash')

    if (!membership) {
      throw new NotFoundError('Invitation')
    }

    const expired =
      membership.invitationExpiresAt !== null &&
      membership.invitationExpiresAt.getTime() < Date.now()

    const [org, inviter] = await Promise.all([
      Organisation.findById(membership.org).select('name slug brandColor'),
      membership.invitedBy ? User.findById(membership.invitedBy).select('fullName') : null,
    ])

    if (!org) throw new NotFoundError('Invitation')

    // The address it was sent to, so the invitee knows which account to use.
    const invitedEmail =
      membership.invitedEmail ??
      (membership.user
        ? (await User.findById(membership.user).select('email'))?.email ?? null
        : null)

    res.json({
      organisation: { name: org.name, slug: org.slug, brandColor: org.brandColor },
      role: membership.role,
      invitedEmail,
      invitedBy: inviter?.fullName ?? null,
      expired,
      expiresAt: membership.invitationExpiresAt,
    })
  }),
)

router.post(
  '/:token/accept',
  sensitiveLimiter,
  requireAuth,
  validate(z.object({})),
  asyncHandler(async (req, res) => {
    const token = param(req, 'token')

    const membership = await Membership.findOne({
      invitationTokenHash: hashToken(token),
      status: MembershipStatus.INVITED,
    }).select('+invitationTokenHash')

    if (!membership) throw new NotFoundError('Invitation')

    if (
      membership.invitationExpiresAt !== null &&
      membership.invitationExpiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestError('That invitation has expired. Ask for a new one.')
    }

    const user = await User.findById(req.auth!.userId)
    if (!user) throw new NotFoundError('User')

    /**
     * The invitation must be claimed by the person it was addressed to.
     *
     * Without this check, anyone holding the link could join a workspace using
     * their own account, and invitation links travel through email, get
     * forwarded, and end up in logs. The token proves possession, not identity.
     */
    if (membership.invitedEmail && membership.invitedEmail !== user.email) {
      throw new ConflictError(
        `This invitation was sent to ${membership.invitedEmail}. Sign in with that address to accept it.`,
        { invitedEmail: membership.invitedEmail },
      )
    }
    if (membership.user && membership.user.toString() !== user._id.toString()) {
      throw new ConflictError('This invitation belongs to a different account.')
    }

    // Already a member of this workspace through another route.
    const existing = await Membership.findOne({
      org: membership.org,
      user: user._id,
      status: MembershipStatus.ACTIVE,
    })
    if (existing) {
      // Retire the redundant invitation rather than leaving it pending forever.
      membership.status = MembershipStatus.REVOKED
      membership.invitationTokenHash = null
      await membership.save()

      const org = await Organisation.findById(membership.org).select('name slug')
      res.json({
        accepted: true,
        alreadyMember: true,
        organisation: { id: membership.org.toString(), name: org?.name, slug: org?.slug },
        role: existing.role,
      })
      return
    }

    membership.user = user._id
    membership.invitedEmail = null
    membership.status = MembershipStatus.ACTIVE
    membership.acceptedAt = new Date()
    // Single-use: burn the token so a forwarded link cannot be replayed.
    membership.invitationTokenHash = null
    membership.invitationExpiresAt = null
    await membership.save()

    const org = await Organisation.findById(membership.org).select('name slug')

    await recordAudit({
      org: membership.org,
      actor: actorId(req),
      action: 'membership.accepted',
      entityType: 'Membership',
      entityId: membership._id.toString(),
      changes: { role: membership.role },
      ip: req.ip,
      requestId: req.requestId,
    })

    res.json({
      accepted: true,
      alreadyMember: false,
      organisation: { id: membership.org.toString(), name: org?.name, slug: org?.slug },
      role: membership.role,
    })
  }),
)

export default router
