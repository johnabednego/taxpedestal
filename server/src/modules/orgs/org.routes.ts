import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../../core/asyncHandler'
import { NotFoundError } from '../../core/errors'
import { isValidCountry } from '../../core/countries'
import { SUPPORTED_CURRENCY_CODES } from '../../core/money'
import { actorId, objectIdParam } from '../../core/params'
import { requireAuth, requireOrg, requireRole } from '../../middleware/auth'
import { validate } from '../../middleware/validate'
import {
  Membership,
  MembershipStatus,
  OrgRole,
  Organisation,
  ROLE_RANK,
  User,
} from '../../models'
import { recordAudit } from '../invoices/invoice.service'
import { generateOpaqueToken, hashToken } from '../auth/token.service'
import { sendEmail } from '../../services/email'
import { env, paymentCapabilities } from '../../config/env'
import { paymentCapabilityFor } from '../../services/payments/coverage'
import { probeAll } from '../../services/payments/health'
import { supportedDocumentLocales } from '../../services/documents/templates'

const router = Router()
router.use(requireAuth, requireOrg)

const settingsSchema = z.object({
  name: z.string().trim().min(2).max(140).optional(),
  legalName: z.string().trim().max(180).nullish(),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .length(2)
    .refine(isValidCountry, 'Unknown country code')
    .optional(),
  region: z.string().trim().toUpperCase().max(10).nullish(),
  city: z.string().trim().max(120).nullish(),
  addressLine1: z.string().trim().max(200).nullish(),
  addressLine2: z.string().trim().max(200).nullish(),
  postalCode: z.string().trim().max(30).nullish(),
  email: z.string().trim().toLowerCase().email().nullish(),
  phone: z.string().trim().max(40).nullish(),
  website: z.string().trim().url().nullish(),
  logoUrl: z.string().trim().url().nullish(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #2B59FF').optional(),
  baseCurrency: z.string().trim().toUpperCase().refine((c) => SUPPORTED_CURRENCY_CODES.includes(c)).optional(),
  taxRegistered: z.boolean().optional(),
  taxId: z.string().trim().max(60).nullish(),
  taxLabel: z.string().trim().max(40).nullish(),
  // The organisation's own tax definition. Rates are basis points so the input
  // space stays integral — 1750 is 17.50%, with no float anywhere.
  customTaxProfile: z
    .object({
      enabled: z.boolean(),
      overrideBuiltIn: z.boolean().default(false),
      components: z
        .array(
          z.object({
            code: z.string().trim().min(1).max(30),
            label: z.string().trim().min(1).max(60),
            basisPoints: z.number().int().min(0).max(10_000),
          }),
        )
        .max(6),
      zeroRateExports: z.boolean().default(true),
      notes: z.array(z.string().trim().max(300)).max(4).default([]),
    })
    .optional(),
  // The universal payment rail. Free-form because account identifiers differ
  // enormously worldwide and a rigid schema would exclude the markets this
  // exists to serve.
  paymentInstructions: z
    .object({
      enabled: z.boolean(),
      accountName: z.string().trim().max(140).nullish(),
      bankName: z.string().trim().max(140).nullish(),
      accountNumber: z.string().trim().max(60).nullish(),
      routingCode: z.string().trim().max(60).nullish(),
      swiftBic: z.string().trim().max(30).nullish(),
      mobileMoneyNumber: z.string().trim().max(40).nullish(),
      mobileMoneyProvider: z.string().trim().max(60).nullish(),
      additionalDetails: z.string().trim().max(1000).nullish(),
    })
    .optional(),
  // Presentation only. Legally required content is not configurable — see
  // services/documents/requirements.ts.
  invoiceTemplate: z
    .object({
      preset: z.enum(['classic', 'modern', 'compact']).default('classic'),
      accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2B59FF'),
      documentLocale: z.string().trim().max(10).nullish(),
      showLogo: z.boolean().default(true),
      showPaymentInstructions: z.boolean().default(true),
      showTaxSummary: z.boolean().default(true),
      customFields: z
        .array(z.object({ label: z.string().trim().max(40), value: z.string().trim().max(120) }))
        .max(6)
        .default([]),
      documentTitleOverride: z.string().trim().max(40).nullish(),
    })
    .optional(),
  invoicePrefix: z.string().trim().toUpperCase().max(10).optional(),
  invoiceNumberPadding: z.number().int().min(1).max(10).optional(),
  defaultPaymentTermsDays: z.number().int().min(0).max(365).optional(),
  defaultNotes: z.string().max(4000).nullish(),
  defaultFooter: z.string().max(1000).nullish(),
})

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const org = await Organisation.findById(req.org!.id)
    if (!org) throw new NotFoundError('Workspace')
    res.json({ organisation: org, role: req.org!.role })
  }),
)

router.patch(
  '/',
  requireRole(OrgRole.ADMIN),
  validate(settingsSchema),
  asyncHandler(async (req, res) => {
    const org = await Organisation.findByIdAndUpdate(
      req.org!.id,
      { $set: req.body },
      { new: true, runValidators: true },
    )
    if (!org) throw new NotFoundError('Workspace')

    await recordAudit({
      org: org._id,
      actor: actorId(req),
      action: 'organisation.updated',
      entityType: 'Organisation',
      entityId: org._id.toString(),
      changes: req.body,
      requestId: req.requestId,
    })

    res.json(org)
  }),
)

/**
 * What this workspace can use to get paid, and why.
 *
 * Drives the Settings page so the user is never left guessing whether online
 * payments are available to them.
 */
/** Document languages and layout presets the invoice renderer supports. */
router.get(
  '/document-options',
  asyncHandler(async (_req, res) => {
    res.json({
      locales: supportedDocumentLocales(),
      presets: ['classic', 'modern', 'compact'],
    })
  }),
)

router.get(
  '/payment-capability',
  asyncHandler(async (req, res) => {
    const org = await Organisation.findById(req.org!.id)
    if (!org) throw new NotFoundError('Workspace')

    // Ask the providers directly. Their answer overrides our reference table,
    // which is why a newly supported country works without a redeploy.
    const { stripe, paystack, all } = await probeAll()

    const capability = paymentCapabilityFor(org.country, paymentCapabilities, {
      stripe: {
        reachable: stripe.reachable,
        chargesEnabled: stripe.chargesEnabled,
        accountCountry: stripe.accountCountry,
      },
      paystack: { reachable: paystack.reachable, chargesEnabled: paystack.chargesEnabled },
    })

    res.json({
      ...capability,
      bankTransferConfigured: Boolean(org.paymentInstructions?.enabled),
      providers: all.map((health) => ({
        provider: health.provider,
        configured: health.configured,
        reachable: health.reachable,
        chargesEnabled: health.chargesEnabled,
        accountCountry: health.accountCountry,
        checkedAt: health.checkedAt,
        error: health.error,
      })),
    })
  }),
)

router.post(
  '/complete-onboarding',
  requireRole(OrgRole.ADMIN),
  asyncHandler(async (req, res) => {
    const org = await Organisation.findByIdAndUpdate(
      req.org!.id,
      { $set: { onboardingCompletedAt: new Date() } },
      { new: true },
    )
    res.json(org)
  }),
)

/* -------------------------------------------------------------------------- */
/* Team                                                                        */
/* -------------------------------------------------------------------------- */

router.get(
  '/members',
  asyncHandler(async (req, res) => {
    const members = await Membership.find({
      org: req.org!.id,
      status: { $ne: MembershipStatus.REVOKED },
    }).populate('user', 'fullName email avatarColor lastLoginAt')

    res.json(
      members.map((m) => ({
        id: m._id.toString(),
        role: m.role,
        status: m.status,
        invitedEmail: m.invitedEmail,
        acceptedAt: m.acceptedAt,
        user: m.user,
      })),
    )
  }),
)

router.post(
  '/members/invite',
  requireRole(OrgRole.ADMIN),
  validate(
    z.object({
      email: z.string().trim().toLowerCase().email(),
      role: z.nativeEnum(OrgRole).default(OrgRole.MEMBER),
    }),
  ),
  asyncHandler(async (req, res) => {
    // Nobody may grant a role above their own — otherwise an ADMIN could mint
    // an OWNER and escalate laterally.
    if (ROLE_RANK[req.body.role as OrgRole] > ROLE_RANK[req.org!.role]) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'You cannot invite someone at a higher role than your own',
        },
      })
      return
    }

    const token = generateOpaqueToken()
    const existingUser = await User.findOne({ email: req.body.email })

    const membership = await Membership.create({
      org: req.org!.id,
      user: existingUser?._id ?? null,
      invitedEmail: existingUser ? null : req.body.email,
      role: req.body.role,
      status: MembershipStatus.INVITED,
      invitationTokenHash: hashToken(token),
      invitationExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedBy: actorId(req),
    })

    const inviter = await User.findById(req.auth!.userId)
    await sendEmail({
      to: req.body.email,
      subject: `${inviter?.fullName ?? 'A colleague'} invited you to ${req.org!.name}`,
      template: 'team-invitation',
      data: {
        inviterName: inviter?.fullName ?? 'A colleague',
        orgName: req.org!.name,
        role: req.body.role.toLowerCase(),
        url: `${env.APP_URL}/accept-invite?token=${token}`,
        expiresInDays: 7,
      },
    })

    res.status(201).json({ id: membership._id.toString(), email: req.body.email, role: membership.role })
  }),
)

router.post(
  '/members/:id/role',
  requireRole(OrgRole.ADMIN),
  validate(z.object({ role: z.nativeEnum(OrgRole) })),
  asyncHandler(async (req, res) => {
    const membership = await Membership.findOne({
      _id: objectIdParam(req, 'id', 'Member'),
      org: req.org!.id,
    })
    if (!membership) throw new NotFoundError('Member')

    if (ROLE_RANK[req.body.role as OrgRole] > ROLE_RANK[req.org!.role]) {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'You cannot grant a role above your own' },
      })
      return
    }

    // The last owner cannot be demoted, or the workspace becomes unadministrable.
    if (membership.role === OrgRole.OWNER && req.body.role !== OrgRole.OWNER) {
      const owners = await Membership.countDocuments({
        org: req.org!.id,
        role: OrgRole.OWNER,
        status: MembershipStatus.ACTIVE,
      })
      if (owners <= 1) {
        res.status(409).json({
          error: {
            code: 'CONFLICT',
            message: 'Promote another owner before changing the last owner\u2019s role',
          },
        })
        return
      }
    }

    membership.role = req.body.role
    await membership.save()
    res.json({ id: membership._id.toString(), role: membership.role })
  }),
)

router.delete(
  '/members/:id',
  requireRole(OrgRole.ADMIN),
  asyncHandler(async (req, res) => {
    const membership = await Membership.findOne({
      _id: objectIdParam(req, 'id', 'Member'),
      org: req.org!.id,
    })
    if (!membership) throw new NotFoundError('Member')

    if (membership.role === OrgRole.OWNER) {
      const owners = await Membership.countDocuments({
        org: req.org!.id,
        role: OrgRole.OWNER,
        status: MembershipStatus.ACTIVE,
      })
      if (owners <= 1) {
        res.status(409).json({
          error: { code: 'CONFLICT', message: 'A workspace must keep at least one owner' },
        })
        return
      }
    }

    membership.status = MembershipStatus.REVOKED
    await membership.save()
    res.status(204).send()
  }),
)

export default router
