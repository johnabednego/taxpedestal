import crypto from 'node:crypto'
import { Types } from 'mongoose'
import {
  clearCollections,
  connectTestDatabase,
  describeIntegration,
  disconnectTestDatabase,
  syncIndexes,
} from '../helpers/database'

// Credentials must exist before the modules under test read env at import time.
process.env.PAYSTACK_SECRET_KEY = 'sk_test_paystack_integration_secret'

import { env } from '../../src/config/env'
import {
  Client,
  Invoice,
  InvoiceStatus,
  Organisation,
  Payment,
  PaymentMethod,
  PaymentProviderName,
  PaymentStatus,
  User,
  WebhookEvent,
  nextSequence,
} from '../../src/models'
import { handleWebhook } from '../../src/modules/payments/webhook.service'
import { paystackProvider } from '../../src/services/payments/providers/paystack'

jest.setTimeout(120_000)

/** Build a genuine Paystack signature so the real verification path runs. */
function signPaystack(body: unknown): { raw: Buffer; headers: Record<string, string> } {
  const raw = Buffer.from(JSON.stringify(body), 'utf8')
  const signature = crypto
    .createHmac('sha512', env.PAYSTACK_SECRET_KEY as string)
    .update(raw)
    .digest('hex')
  return { raw, headers: { 'x-paystack-signature': signature } }
}

interface Fixture {
  orgId: Types.ObjectId
  invoiceId: Types.ObjectId
  paymentId: Types.ObjectId
  reference: string
}

async function seedPayableInvoice(amountMinor = 120_000): Promise<Fixture> {
  const user = await User.create({
    email: `owner-${crypto.randomUUID()}@example.com`,
    passwordHash: 'x'.repeat(20),
    fullName: 'Test Owner',
  })

  const org = await Organisation.create({
    name: 'Test Studio',
    slug: `test-studio-${crypto.randomUUID().slice(0, 8)}`,
    country: 'GH',
    baseCurrency: 'GHS',
    taxRegistered: true,
    createdBy: user._id,
  })

  const client = await Client.create({
    org: org._id,
    name: 'Acme Ltd',
    email: 'ap@acme.example',
    country: 'GH',
    isBusiness: true,
    defaultCurrency: 'GHS',
    createdBy: user._id,
  })

  const sequence = await nextSequence(org._id, 'invoice')
  const invoice = await Invoice.create({
    org: org._id,
    client: client._id,
    number: `INV-${String(sequence).padStart(4, '0')}`,
    sequence,
    status: InvoiceStatus.SENT,
    currency: 'GHS',
    issueDate: new Date(),
    dueDate: new Date(Date.now() + 14 * 86_400_000),
    lines: [
      {
        description: 'Consulting',
        quantityMilli: 1000,
        unitAmountMinor: 100_000,
        discountBasisPoints: 0,
        supplyType: 'services',
        taxTreatmentOverride: null,
        netMinor: 100_000,
        taxMinor: 20_000,
        totalMinor: 120_000,
        taxComponents: [],
      },
    ],
    subtotalMinor: 100_000,
    taxMinor: 20_000,
    totalMinor: amountMinor,
    amountDueMinor: amountMinor,
    publicToken: crypto.randomBytes(32).toString('base64url'),
    createdBy: user._id,
    sentAt: new Date(),
  })

  const reference = `mrd_${crypto.randomUUID()}`
  const payment = await Payment.create({
    org: org._id,
    invoice: invoice._id,
    provider: PaymentProviderName.PAYSTACK,
    status: PaymentStatus.PENDING,
    method: PaymentMethod.MOBILE_MONEY,
    amountMinor,
    currency: 'GHS',
    idempotencyKey: crypto.randomUUID(),
    providerReference: reference,
  })

  return { orgId: org._id, invoiceId: invoice._id, paymentId: payment._id, reference }
}

beforeAll(async () => {
  await connectTestDatabase()
  await syncIndexes()
})

afterAll(async () => {
  await disconnectTestDatabase()
})

beforeEach(async () => {
  await clearCollections()
  jest.restoreAllMocks()
})

describeIntegration('webhook signature verification', () => {
  it('rejects a request with no signature header', async () => {
    const outcome = await handleWebhook('PAYSTACK', Buffer.from('{}'), {})
    expect(outcome.status).toBe('invalid')
    expect(outcome.detail).toMatch(/Missing x-paystack-signature/)
  })

  it('rejects a tampered body', async () => {
    const { headers } = signPaystack({ event: 'charge.success', data: { id: 1, amount: 100 } })
    // Same signature, different body, exactly what an attacker would send.
    const tampered = Buffer.from(
      JSON.stringify({ event: 'charge.success', data: { id: 1, amount: 999_999 } }),
    )

    const outcome = await handleWebhook('PAYSTACK', tampered, headers)
    expect(outcome.status).toBe('invalid')
  })

  it('records failed verifications for monitoring', async () => {
    await handleWebhook('PAYSTACK', Buffer.from('{}'), { 'x-paystack-signature': 'deadbeef' })
    const events = await WebhookEvent.find({ status: 'FAILED' })
    expect(events).toHaveLength(1)
    expect(events[0]!.signatureValid).toBe(false)
  })

  it('accepts a correctly signed body', async () => {
    const fixture = await seedPayableInvoice()
    jest.spyOn(paystackProvider, 'fetchTransaction').mockResolvedValue({
      providerReference: fixture.reference,
      status: 'succeeded',
      amountMinor: 120_000,
      currency: 'GHS',
      feeMinor: 2_400,
      channelDetail: 'MTN 024••••1234',
      paidAt: new Date(),
    })

    const { raw, headers } = signPaystack({
      event: 'charge.success',
      data: { id: 998877, reference: fixture.reference, amount: 120_000, currency: 'GHS' },
    })

    const outcome = await handleWebhook('PAYSTACK', raw, headers)
    expect(outcome.status).toBe('processed')
  })
})

describeIntegration('webhook idempotency, the double-credit guarantee', () => {
  it('credits an invoice exactly once when the same event is delivered twice', async () => {
    const fixture = await seedPayableInvoice()
    const spy = jest.spyOn(paystackProvider, 'fetchTransaction').mockResolvedValue({
      providerReference: fixture.reference,
      status: 'succeeded',
      amountMinor: 120_000,
      currency: 'GHS',
      feeMinor: 2_400,
      channelDetail: 'MTN',
      paidAt: new Date(),
    })

    const body = {
      event: 'charge.success',
      data: { id: 555000, reference: fixture.reference, amount: 120_000, currency: 'GHS' },
    }
    const { raw, headers } = signPaystack(body)

    const first = await handleWebhook('PAYSTACK', raw, headers)
    const second = await handleWebhook('PAYSTACK', raw, headers)

    expect(first.status).toBe('processed')
    // The duplicate must be recognised, not reprocessed.
    expect(second.status).toBe('duplicate')

    const invoice = await Invoice.findById(fixture.invoiceId)
    // 120,000. NOT 240,000.
    expect(invoice!.amountPaidMinor).toBe(120_000)
    expect(invoice!.amountDueMinor).toBe(0)
    expect(invoice!.status).toBe(InvoiceStatus.PAID)

    // The provider API was queried once; the second call short-circuited.
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('survives concurrent delivery of the same event', async () => {
    // Providers can and do deliver retries in parallel. The unique index on
    // (provider, eventId) is what makes this safe, not application locking.
    const fixture = await seedPayableInvoice()
    jest.spyOn(paystackProvider, 'fetchTransaction').mockResolvedValue({
      providerReference: fixture.reference,
      status: 'succeeded',
      amountMinor: 120_000,
      currency: 'GHS',
      feeMinor: 0,
      channelDetail: null,
      paidAt: new Date(),
    })

    const { raw, headers } = signPaystack({
      event: 'charge.success',
      data: { id: 777111, reference: fixture.reference, amount: 120_000, currency: 'GHS' },
    })

    const outcomes = await Promise.all([
      handleWebhook('PAYSTACK', raw, headers),
      handleWebhook('PAYSTACK', raw, headers),
      handleWebhook('PAYSTACK', raw, headers),
      handleWebhook('PAYSTACK', raw, headers),
    ])

    const processed = outcomes.filter((o) => o.status === 'processed')
    expect(processed).toHaveLength(1)

    const invoice = await Invoice.findById(fixture.invoiceId)
    expect(invoice!.amountPaidMinor).toBe(120_000)
  })

  it('does not re-credit when a different event id references a settled payment', async () => {
    // Paystack sends both charge.success and transaction.success for one payment.
    // Distinct event ids, so the ledger dedupe does not catch it, the terminal
    // payment-status check must.
    const fixture = await seedPayableInvoice()
    jest.spyOn(paystackProvider, 'fetchTransaction').mockResolvedValue({
      providerReference: fixture.reference,
      status: 'succeeded',
      amountMinor: 120_000,
      currency: 'GHS',
      feeMinor: 0,
      channelDetail: null,
      paidAt: new Date(),
    })

    const first = signPaystack({
      event: 'charge.success',
      data: { id: 111, reference: fixture.reference, amount: 120_000, currency: 'GHS' },
    })
    const second = signPaystack({
      event: 'transaction.success',
      data: { id: 222, reference: fixture.reference, amount: 120_000, currency: 'GHS' },
    })

    await handleWebhook('PAYSTACK', first.raw, first.headers)
    const outcome = await handleWebhook('PAYSTACK', second.raw, second.headers)

    expect(outcome.status).toBe('duplicate')
    const invoice = await Invoice.findById(fixture.invoiceId)
    expect(invoice!.amountPaidMinor).toBe(120_000)
  })
})

describeIntegration('webhook amount verification, the tampering guard', () => {
  it('refuses to credit when the provider reports a different amount', async () => {
    const fixture = await seedPayableInvoice(120_000)
    // The webhook body claims the right amount, but the authoritative API says
    // only 1.00 was actually captured.
    jest.spyOn(paystackProvider, 'fetchTransaction').mockResolvedValue({
      providerReference: fixture.reference,
      status: 'succeeded',
      amountMinor: 100,
      currency: 'GHS',
      feeMinor: 0,
      channelDetail: null,
      paidAt: new Date(),
    })

    const { raw, headers } = signPaystack({
      event: 'charge.success',
      data: { id: 333, reference: fixture.reference, amount: 120_000, currency: 'GHS' },
    })

    const outcome = await handleWebhook('PAYSTACK', raw, headers)

    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toMatch(/mismatch/i)

    const invoice = await Invoice.findById(fixture.invoiceId)
    // Nothing credited.
    expect(invoice!.amountPaidMinor).toBe(0)
    expect(invoice!.status).toBe(InvoiceStatus.SENT)

    const payment = await Payment.findById(fixture.paymentId)
    expect(payment!.status).toBe(PaymentStatus.FAILED)
    expect(payment!.failureCode).toBe('AMOUNT_MISMATCH')
  })

  it('refuses to credit on a currency mismatch', async () => {
    const fixture = await seedPayableInvoice(120_000)
    // Same number, different currency, 120,000 NGN is not 120,000 GHS.
    jest.spyOn(paystackProvider, 'fetchTransaction').mockResolvedValue({
      providerReference: fixture.reference,
      status: 'succeeded',
      amountMinor: 120_000,
      currency: 'NGN',
      feeMinor: 0,
      channelDetail: null,
      paidAt: new Date(),
    })

    const { raw, headers } = signPaystack({
      event: 'charge.success',
      data: { id: 444, reference: fixture.reference, amount: 120_000, currency: 'NGN' },
    })

    const outcome = await handleWebhook('PAYSTACK', raw, headers)
    expect(outcome.status).toBe('failed')

    const invoice = await Invoice.findById(fixture.invoiceId)
    expect(invoice!.amountPaidMinor).toBe(0)
  })

  it('marks a failed charge without touching the invoice', async () => {
    const fixture = await seedPayableInvoice()
    jest.spyOn(paystackProvider, 'fetchTransaction').mockResolvedValue({
      providerReference: fixture.reference,
      status: 'failed',
      amountMinor: 120_000,
      currency: 'GHS',
      feeMinor: 0,
      channelDetail: null,
      failureCode: 'insufficient_funds',
      failureMessage: 'Insufficient balance',
      paidAt: null,
    })

    const { raw, headers } = signPaystack({
      event: 'charge.failed',
      data: { id: 666, reference: fixture.reference, amount: 120_000, currency: 'GHS' },
    })

    const outcome = await handleWebhook('PAYSTACK', raw, headers)
    expect(outcome.status).toBe('processed')

    const payment = await Payment.findById(fixture.paymentId)
    expect(payment!.status).toBe(PaymentStatus.FAILED)

    const invoice = await Invoice.findById(fixture.invoiceId)
    expect(invoice!.amountPaidMinor).toBe(0)
  })

  it('holds a mobile money charge as awaiting customer approval', async () => {
    const fixture = await seedPayableInvoice()
    jest.spyOn(paystackProvider, 'fetchTransaction').mockResolvedValue({
      providerReference: fixture.reference,
      status: 'pending',
      amountMinor: 120_000,
      currency: 'GHS',
      feeMinor: 0,
      channelDetail: null,
      paidAt: null,
    })

    const { raw, headers } = signPaystack({
      event: 'charge.success',
      data: { id: 888, reference: fixture.reference, amount: 120_000, currency: 'GHS' },
    })

    await handleWebhook('PAYSTACK', raw, headers)

    const payment = await Payment.findById(fixture.paymentId)
    expect(payment!.status).toBe(PaymentStatus.AWAITING_CUSTOMER)
  })
})

describeIntegration('webhook for unknown references', () => {
  it('ignores a payment reference it does not recognise', async () => {
    const { raw, headers } = signPaystack({
      event: 'charge.success',
      data: { id: 999, reference: 'not-ours', amount: 1000, currency: 'GHS' },
    })
    const outcome = await handleWebhook('PAYSTACK', raw, headers)
    expect(outcome.status).toBe('ignored')
  })

  it('ignores event types it does not handle', async () => {
    const { raw, headers } = signPaystack({
      event: 'subscription.create',
      data: { id: 1234, reference: 'x' },
    })
    const outcome = await handleWebhook('PAYSTACK', raw, headers)
    expect(outcome.status).toBe('ignored')
  })
})

describeIntegration('atomic invoice numbering under concurrency', () => {
  it('never issues the same sequence twice', async () => {
    const user = await User.create({
      email: `seq-${crypto.randomUUID()}@example.com`,
      passwordHash: 'x'.repeat(20),
      fullName: 'Seq Tester',
    })
    const org = await Organisation.create({
      name: 'Seq Co',
      slug: `seq-${crypto.randomUUID().slice(0, 8)}`,
      country: 'GB',
      baseCurrency: 'GBP',
      createdBy: user._id,
    })

    // 50 simultaneous allocations. A count-and-increment implementation
    // duplicates here; $inc with upsert does not.
    const results = await Promise.all(
      Array.from({ length: 50 }, () => nextSequence(org._id, 'invoice')),
    )

    expect(new Set(results).size).toBe(50)
    expect(Math.min(...results)).toBe(1)
    expect(Math.max(...results)).toBe(50)
  })

  it('keeps sequences independent per organisation', async () => {
    const user = await User.create({
      email: `multi-${crypto.randomUUID()}@example.com`,
      passwordHash: 'x'.repeat(20),
      fullName: 'Multi',
    })
    const [a, b] = await Promise.all([
      Organisation.create({
        name: 'A',
        slug: `a-${crypto.randomUUID().slice(0, 8)}`,
        country: 'GH',
        baseCurrency: 'GHS',
        createdBy: user._id,
      }),
      Organisation.create({
        name: 'B',
        slug: `b-${crypto.randomUUID().slice(0, 8)}`,
        country: 'GH',
        baseCurrency: 'GHS',
        createdBy: user._id,
      }),
    ])

    expect(await nextSequence(a._id, 'invoice')).toBe(1)
    expect(await nextSequence(b._id, 'invoice')).toBe(1)
    expect(await nextSequence(a._id, 'invoice')).toBe(2)
  })
})
