import dayjs from 'dayjs'
import mongoose from 'mongoose'
import { connectDatabase, disconnectDatabase } from '../config/db'
import { env } from '../config/env'
import { logger } from '../core/logger'
import {
  Client,
  Invoice,
  Membership,
  MembershipStatus,
  OrgRole,
  Organisation,
  PlatformRole,
  User,
} from '../models'
import { hashPassword } from '../modules/auth/auth.service'
import { createDraft, issueAndSend, applyPayment } from '../modules/invoices/invoice.service'

/**
 * Seed script.
 *
 * Creates a demo workspace with data that EXERCISES THE TAX ENGINE rather than
 * just filling the screen: a domestic Ghanaian invoice at 20%, an intra-EU B2B
 * supply that reverse-charges to zero, a zero-rated export, and a US invoice.
 * A demo where every invoice is identical proves nothing about the product.
 *
 * Idempotent: re-running updates rather than duplicating, so it is safe to run
 * against an existing environment.
 *
 * Usage:  npm run seed
 */

const DEMO_EMAIL = 'demo@taxpedestal.app'
const DEMO_PASSWORD = 'taxpedestal-demo-2026'

async function seed(): Promise<void> {
  await connectDatabase()
  logger.info('Seeding…')

  /* --- Platform administrator ------------------------------------------- */
  if (env.PLATFORM_ADMIN_EMAIL && env.PLATFORM_ADMIN_PASSWORD) {
    const existing = await User.findOne({ email: env.PLATFORM_ADMIN_EMAIL.toLowerCase() })
    if (existing) {
      existing.platformRole = PlatformRole.SUPERADMIN
      existing.passwordHash = await hashPassword(env.PLATFORM_ADMIN_PASSWORD)
      existing.emailVerifiedAt = new Date()
      await existing.save()
      logger.info({ email: env.PLATFORM_ADMIN_EMAIL }, 'Platform admin updated')
    } else {
      await User.create({
        email: env.PLATFORM_ADMIN_EMAIL.toLowerCase(),
        passwordHash: await hashPassword(env.PLATFORM_ADMIN_PASSWORD),
        fullName: 'Platform Administrator',
        platformRole: PlatformRole.SUPERADMIN,
        emailVerifiedAt: new Date(),
      })
      logger.info({ email: env.PLATFORM_ADMIN_EMAIL }, 'Platform admin created')
    }
  } else {
    logger.warn('PLATFORM_ADMIN_EMAIL/PASSWORD not set, skipping admin creation')
  }

  /* --- Demo user and workspace ------------------------------------------ */
  let demoUser = await User.findOne({ email: DEMO_EMAIL })
  if (!demoUser) {
    demoUser = await User.create({
      email: DEMO_EMAIL,
      passwordHash: await hashPassword(DEMO_PASSWORD),
      fullName: 'Ama Mensah',
      emailVerifiedAt: new Date(),
      avatarColor: '#2B59FF',
    })
  } else {
    demoUser.passwordHash = await hashPassword(DEMO_PASSWORD)
    await demoUser.save()
  }

  let org = await Organisation.findOne({ slug: 'northwind-studio' })
  if (!org) {
    org = await Organisation.create({
      name: 'Northwind Studio',
      slug: 'northwind-studio',
      legalName: 'Northwind Studio Ltd',
      country: 'GH',
      city: 'Accra',
      addressLine1: '14 Independence Avenue',
      email: 'billing@northwind.studio',
      phone: '+233 30 123 4567',
      website: 'https://northwind.studio',
      brandColor: '#2B59FF',
      baseCurrency: 'GHS',
      // Registered, so the Ghana rules actually engage.
      taxRegistered: true,
      taxId: 'C0012345678',
      invoicePrefix: 'NWS',
      defaultPaymentTermsDays: 14,
      defaultNotes: 'Thank you for your business.',
      defaultFooter: 'Northwind Studio Ltd. VAT registered in Ghana',
      onboardingCompletedAt: new Date(),
      createdBy: demoUser._id,
    })
  }

  const existingMembership = await Membership.findOne({ org: org._id, user: demoUser._id })
  if (!existingMembership) {
    await Membership.create({
      org: org._id,
      user: demoUser._id,
      role: OrgRole.OWNER,
      status: MembershipStatus.ACTIVE,
      acceptedAt: new Date(),
    })
  }

  /* --- Clients spanning tax regimes -------------------------------------- */
  const clientSpecs = [
    {
      name: 'Kwame Foods Ltd',
      email: 'accounts@kwamefoods.gh',
      contactName: 'Kwame Boateng',
      country: 'GH',
      city: 'Kumasi',
      isBusiness: true,
      taxId: 'C0098765432',
      taxRegistered: true,
      defaultCurrency: 'GHS',
      tags: ['retail'],
    },
    {
      name: 'Berlin Design Collective GmbH',
      email: 'invoices@bdc.de',
      contactName: 'Lena Fischer',
      country: 'DE',
      city: 'Berlin',
      isBusiness: true,
      // A valid VAT ID is what triggers reverse charge.
      taxId: 'DE811234567',
      taxRegistered: true,
      defaultCurrency: 'EUR',
      tags: ['agency', 'eu'],
    },
    {
      name: 'TaxPedestal Labs Inc',
      email: 'ap@taxpedestallabs.com',
      contactName: 'Dana Reyes',
      country: 'US',
      region: 'CA',
      city: 'San Francisco',
      isBusiness: true,
      taxId: '87-1234567',
      taxRegistered: true,
      defaultCurrency: 'USD',
      tags: ['tech'],
    },
    {
      name: 'Adjoa Owusu',
      email: 'adjoa.owusu@example.com',
      country: 'GH',
      city: 'Accra',
      isBusiness: false,
      taxRegistered: false,
      defaultCurrency: 'GHS',
      tags: ['individual'],
    },
  ]

  const clients = []
  for (const spec of clientSpecs) {
    let client = await Client.findOne({ org: org._id, name: spec.name })
    if (!client) {
      client = await Client.create({ ...spec, org: org._id, createdBy: demoUser._id })
    }
    clients.push(client)
  }

  /* --- Invoices ---------------------------------------------------------- */
  const alreadySeeded = await Invoice.countDocuments({ org: org._id })
  if (alreadySeeded > 0) {
    logger.info({ count: alreadySeeded }, 'Invoices already present, skipping invoice seed')
    await summarise(org._id)
    await disconnectDatabase()
    return
  }

  const [ghBusiness, euBusiness, usBusiness, ghConsumer] = clients

  // 1. Domestic Ghana, 20% under Act 1151, paid in full.
  const inv1 = await createDraft(org._id, demoUser._id, {
    clientId: ghBusiness!._id.toString(),
    currency: 'GHS',
    issueDate: dayjs().subtract(40, 'day').toISOString(),
    dueDate: dayjs().subtract(26, 'day').toISOString(),
    lines: [
      { description: 'Brand identity design', quantityMilli: 1000, unitAmountMinor: 1_800_000 },
      { description: 'Packaging artwork (6 SKUs)', quantityMilli: 6000, unitAmountMinor: 250_000 },
    ],
    reference: 'Project Sunrise',
  })
  await issueAndSend(org._id, demoUser._id, inv1._id.toString(), { sendEmail: false })
  const inv1Fresh = await Invoice.findById(inv1._id)
  await applyPayment(inv1Fresh!, inv1Fresh!.totalMinor, {
    actor: demoUser._id,
    source: 'seed',
    idempotencyKey: `payment:seed-${inv1._id.toString()}`,
    description: 'Bank transfer received',
  })

  // 2. Intra-EU B2B, reverse charge, tax must come out as zero.
  const inv2 = await createDraft(org._id, demoUser._id, {
    clientId: euBusiness!._id.toString(),
    currency: 'EUR',
    issueDate: dayjs().subtract(12, 'day').toISOString(),
    dueDate: dayjs().add(2, 'day').toISOString(),
    lines: [
      { description: 'UX consulting retainer. March', quantityMilli: 1000, unitAmountMinor: 420_000 },
    ],
    reference: 'BDC-RET-03',
  })
  await issueAndSend(org._id, demoUser._id, inv2._id.toString(), { sendEmail: false })

  // 3. US client, export of services from Ghana, zero-rated. Partially paid.
  const inv3 = await createDraft(org._id, demoUser._id, {
    clientId: usBusiness!._id.toString(),
    currency: 'USD',
    issueDate: dayjs().subtract(30, 'day').toISOString(),
    dueDate: dayjs().subtract(2, 'day').toISOString(),
    lines: [
      { description: 'Design system build', quantityMilli: 1000, unitAmountMinor: 950_000 },
      { description: 'Component documentation', quantityMilli: 1000, unitAmountMinor: 180_000 },
    ],
  })
  await issueAndSend(org._id, demoUser._id, inv3._id.toString(), { sendEmail: false })
  const inv3Fresh = await Invoice.findById(inv3._id)
  await applyPayment(inv3Fresh!, 400_000, {
    actor: demoUser._id,
    source: 'seed',
    idempotencyKey: `payment:seed-partial-${inv3._id.toString()}`,
    description: 'Part payment received',
  })

  // 4. Ghana consumer, overdue, so the aging report has something in it.
  const inv4 = await createDraft(org._id, demoUser._id, {
    clientId: ghConsumer!._id.toString(),
    currency: 'GHS',
    issueDate: dayjs().subtract(75, 'day').toISOString(),
    dueDate: dayjs().subtract(61, 'day').toISOString(),
    lines: [{ description: 'Portrait photography session', quantityMilli: 1000, unitAmountMinor: 320_000 }],
  })
  await issueAndSend(org._id, demoUser._id, inv4._id.toString(), { sendEmail: false })

  // 5. A draft, so the dashboard shows a non-zero draft count.
  await createDraft(org._id, demoUser._id, {
    clientId: ghBusiness!._id.toString(),
    currency: 'GHS',
    lines: [{ description: 'Q3 campaign concepts', quantityMilli: 1000, unitAmountMinor: 750_000 }],
  })

  await summarise(org._id)
  await disconnectDatabase()
}

async function summarise(orgId: mongoose.Types.ObjectId): Promise<void> {
  const invoices = await Invoice.find({ org: orgId }).sort({ sequence: 1 })
  logger.info('--- Seeded invoices ---')
  for (const inv of invoices) {
    logger.info(
      {
        number: inv.number,
        status: inv.status,
        currency: inv.currency,
        total: inv.totalMinor,
        tax: inv.taxMinor,
        due: inv.amountDueMinor,
        treatments: inv.taxSnapshot?.treatments,
      },
      inv.number,
    )
  }

  // eslint-disable-next-line no-console
  console.log(`
================================================================
  Seed complete.

  Demo user      ${DEMO_EMAIL}
  Password       ${DEMO_PASSWORD}

  Platform admin ${env.PLATFORM_ADMIN_EMAIL ?? '(not configured)'}

  Public invoice links (no login needed):
${invoices
  .filter((i) => i.status !== 'DRAFT')
  .map((i) => `    ${i.number.padEnd(10)} ${env.APP_URL}/pay/${i.publicToken}`)
  .join('\n')}
================================================================
`)
}

void seed().catch((error: unknown) => {
  logger.fatal(
    { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined },
    'Seed failed',
  )
  process.exit(1)
})
