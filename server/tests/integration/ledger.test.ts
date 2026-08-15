import crypto from 'node:crypto'
import {
  clearCollections,
  connectTestDatabase,
  describeIntegration,
  disconnectTestDatabase,
  syncIndexes,
} from '../helpers/database'

import {
  Client,
  Invoice,
  InvoiceStatus,
  LedgerEntry,
  LedgerEntryType,
  Organisation,
  User,
  nextSequence,
  type IInvoice,
} from '../../src/models'
import {
  auditInvoiceBalance,
  computeOutstanding,
  computePaid,
  entryHistory,
  postEntry,
  reverseEntry,
} from '../../src/modules/invoices/ledger.service'
import { applyPayment } from '../../src/modules/invoices/invoice.service'
import { reconcileBalances } from '../../src/modules/invoices/reconciliation.service'

jest.setTimeout(120_000)

async function seedInvoice(totalMinor = 120_000): Promise<IInvoice> {
  const user = await User.create({
    email: `led-${crypto.randomUUID()}@example.com`,
    passwordHash: 'x'.repeat(20),
    fullName: 'Ledger Tester',
  })
  const org = await Organisation.create({
    name: 'Ledger Co',
    slug: `ledger-${crypto.randomUUID().slice(0, 8)}`,
    country: 'GH',
    baseCurrency: 'GHS',
    taxRegistered: true,
    createdBy: user._id,
  })
  const client = await Client.create({
    org: org._id,
    name: 'Client Ltd',
    email: 'ap@client.example',
    country: 'GH',
    defaultCurrency: 'GHS',
    createdBy: user._id,
  })
  const sequence = await nextSequence(org._id, 'invoice')

  return Invoice.create({
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
        description: 'Work',
        quantityMilli: 1000,
        unitAmountMinor: totalMinor,
        discountBasisPoints: 0,
        supplyType: 'services',
        taxTreatmentOverride: null,
        netMinor: totalMinor,
        taxMinor: 0,
        totalMinor,
        taxComponents: [],
      },
    ],
    subtotalMinor: totalMinor,
    totalMinor,
    amountDueMinor: totalMinor,
    publicToken: crypto.randomBytes(32).toString('base64url'),
    createdBy: user._id,
    sentAt: new Date(),
  })
}

/** Post the opening CHARGE so the invoice is a receivable. */
async function charge(invoice: IInvoice): Promise<void> {
  await postEntry({
    invoice,
    type: LedgerEntryType.CHARGE,
    amountMinor: invoice.totalMinor,
    idempotencyKey: `charge:${invoice._id.toString()}`,
    description: 'Invoice issued',
  })
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
})

describeIntegration('ledger — derived balances', () => {
  it('starts at the full amount owed after the charge is posted', async () => {
    const invoice = await seedInvoice(120_000)
    await charge(invoice)

    expect(await computeOutstanding(invoice._id)).toBe(120_000)
    expect(await computePaid(invoice._id)).toBe(0)
  })

  it('sums to zero when paid in full', async () => {
    const invoice = await seedInvoice(120_000)
    await charge(invoice)

    await applyPayment(invoice, 120_000, {
      source: 'test',
      idempotencyKey: 'payment:full',
    })

    // The core invariant: a settled invoice's entries sum to zero.
    expect(await computeOutstanding(invoice._id)).toBe(0)
    expect(await computePaid(invoice._id)).toBe(120_000)

    const reloaded = await Invoice.findById(invoice._id)
    expect(reloaded!.status).toBe(InvoiceStatus.PAID)
    expect(reloaded!.amountDueMinor).toBe(0)
  })

  it('tracks a sequence of partial payments exactly', async () => {
    const invoice = await seedInvoice(100_000)
    await charge(invoice)

    await applyPayment(invoice, 30_000, { source: 't', idempotencyKey: 'payment:a' })
    await applyPayment(invoice, 45_000, { source: 't', idempotencyKey: 'payment:b' })

    expect(await computeOutstanding(invoice._id)).toBe(25_000)

    let reloaded = await Invoice.findById(invoice._id)
    expect(reloaded!.status).toBe(InvoiceStatus.PARTIALLY_PAID)
    expect(reloaded!.amountPaidMinor).toBe(75_000)

    await applyPayment(reloaded!, 25_000, { source: 't', idempotencyKey: 'payment:c' })

    reloaded = await Invoice.findById(invoice._id)
    expect(reloaded!.status).toBe(InvoiceStatus.PAID)
    expect(await computeOutstanding(invoice._id)).toBe(0)
  })

  it('reports a negative balance on overpayment rather than hiding it', async () => {
    const invoice = await seedInvoice(100_000)
    await charge(invoice)

    await applyPayment(invoice, 150_000, { source: 't', idempotencyKey: 'payment:over' })

    // The ledger tells the truth: the business owes the customer 500.00.
    expect(await computeOutstanding(invoice._id)).toBe(-50_000)
    // The cached "due" field floors at zero for display purposes.
    const reloaded = await Invoice.findById(invoice._id)
    expect(reloaded!.amountDueMinor).toBe(0)
    expect(reloaded!.status).toBe(InvoiceStatus.PAID)
  })
})

describeIntegration('ledger — idempotency by database constraint', () => {
  it('applies the same payment key exactly once', async () => {
    const invoice = await seedInvoice(120_000)
    await charge(invoice)

    const first = await applyPayment(invoice, 120_000, {
      source: 'webhook',
      idempotencyKey: 'payment:same',
    })
    const second = await applyPayment(invoice, 120_000, {
      source: 'reconciliation',
      idempotencyKey: 'payment:same',
    })

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)

    // 120,000 — not 240,000.
    expect(await computePaid(invoice._id)).toBe(120_000)
    expect(await LedgerEntry.countDocuments({ invoice: invoice._id, type: LedgerEntryType.PAYMENT })).toBe(1)
  })

  it('survives a webhook and a reconciliation sweep racing on one payment', async () => {
    // This is the scenario the old counter design would have lost. Both paths
    // run concurrently with the same key; the unique index arbitrates.
    const invoice = await seedInvoice(120_000)
    await charge(invoice)

    const results = await Promise.all([
      applyPayment(invoice, 120_000, { source: 'webhook', idempotencyKey: 'payment:race' }),
      applyPayment(invoice, 120_000, { source: 'reconciliation', idempotencyKey: 'payment:race' }),
      applyPayment(invoice, 120_000, { source: 'webhook-retry', idempotencyKey: 'payment:race' }),
    ])

    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(await computePaid(invoice._id)).toBe(120_000)
    expect(await computeOutstanding(invoice._id)).toBe(0)
  })

  it('does not confuse identical keys on different invoices', async () => {
    // The uniqueness is scoped to (invoice, key), so two invoices may legitimately
    // use the same key without colliding.
    const a = await seedInvoice(50_000)
    const b = await seedInvoice(50_000)
    await charge(a)
    await charge(b)

    const ra = await applyPayment(a, 50_000, { source: 't', idempotencyKey: 'payment:shared' })
    const rb = await applyPayment(b, 50_000, { source: 't', idempotencyKey: 'payment:shared' })

    expect(ra.created).toBe(true)
    expect(rb.created).toBe(true)
    expect(await computeOutstanding(a._id)).toBe(0)
    expect(await computeOutstanding(b._id)).toBe(0)
  })

  it('posts the opening charge only once even if issuing is retried', async () => {
    const invoice = await seedInvoice(80_000)
    await charge(invoice)
    await charge(invoice)

    expect(await LedgerEntry.countDocuments({ invoice: invoice._id, type: LedgerEntryType.CHARGE })).toBe(1)
    expect(await computeOutstanding(invoice._id)).toBe(80_000)
  })
})

describeIntegration('ledger — immutability', () => {
  it('refuses to update an existing entry', async () => {
    const invoice = await seedInvoice(60_000)
    await charge(invoice)
    const entry = await LedgerEntry.findOne({ invoice: invoice._id })

    entry!.amountMinor = 1
    await expect(entry!.save()).rejects.toThrow(/immutable/i)
  })

  it('refuses updateOne and findOneAndUpdate', async () => {
    const invoice = await seedInvoice(60_000)
    await charge(invoice)

    await expect(
      LedgerEntry.updateOne({ invoice: invoice._id }, { $set: { amountMinor: 0 } }),
    ).rejects.toThrow(/immutable/i)

    await expect(
      LedgerEntry.findOneAndUpdate({ invoice: invoice._id }, { $set: { amountMinor: 0 } }),
    ).rejects.toThrow(/immutable/i)
  })

  it('refuses deletion', async () => {
    const invoice = await seedInvoice(60_000)
    await charge(invoice)

    await expect(LedgerEntry.deleteOne({ invoice: invoice._id })).rejects.toThrow(/immutable/i)
    await expect(LedgerEntry.deleteMany({ invoice: invoice._id })).rejects.toThrow(/immutable/i)
  })

  it('rejects non-integer amounts', async () => {
    const invoice = await seedInvoice(60_000)
    await expect(
      postEntry({
        invoice,
        type: LedgerEntryType.PAYMENT,
        amountMinor: 12.5,
        idempotencyKey: 'bad',
        description: 'fractional',
      }),
    ).rejects.toThrow(/integer/i)
  })

  it('rejects a negative magnitude, since sign comes from the entry type', async () => {
    const invoice = await seedInvoice(60_000)
    await expect(
      postEntry({
        invoice,
        type: LedgerEntryType.PAYMENT,
        amountMinor: -100,
        idempotencyKey: 'neg',
        description: 'negative',
      }),
    ).rejects.toThrow(/unsigned/i)
  })
})

describeIntegration('ledger — corrections preserve history', () => {
  it('reverses an erroneous entry without deleting it', async () => {
    const invoice = await seedInvoice(100_000)
    await charge(invoice)

    // A payment that should not have been recorded.
    const bad = await postEntry({
      invoice,
      type: LedgerEntryType.PAYMENT,
      amountMinor: 100_000,
      idempotencyKey: 'payment:mistake',
      description: 'Recorded in error',
    })
    expect(await computeOutstanding(invoice._id)).toBe(0)

    await reverseEntry(bad.entry._id, 'Applied to the wrong invoice', null)

    // Balance restored...
    expect(await computeOutstanding(invoice._id)).toBe(100_000)
    // ...and BOTH records survive. This is the audit property a mutable counter
    // cannot provide.
    const history = await entryHistory(invoice._id)
    expect(history).toHaveLength(3)
    expect(history.map((e) => e.type)).toEqual([
      LedgerEntryType.CHARGE,
      LedgerEntryType.PAYMENT,
      LedgerEntryType.ADJUSTMENT,
    ])
    expect(history[2]!.reverses?.toString()).toBe(bad.entry._id.toString())
  })

  it('refuses to reverse the same entry twice', async () => {
    const invoice = await seedInvoice(100_000)
    await charge(invoice)
    const entry = await postEntry({
      invoice,
      type: LedgerEntryType.PAYMENT,
      amountMinor: 40_000,
      idempotencyKey: 'payment:x',
      description: 'p',
    })

    await reverseEntry(entry.entry._id, 'first', null)
    await expect(reverseEntry(entry.entry._id, 'second', null)).rejects.toThrow(
      /already been reversed/i,
    )
  })
})

describeIntegration('ledger — drift detection', () => {
  it('detects a cached balance that disagrees with the ledger', async () => {
    const invoice = await seedInvoice(100_000)
    await charge(invoice)
    await applyPayment(invoice, 100_000, { source: 't', idempotencyKey: 'payment:ok' })

    // Simulate the corruption a counter-based design cannot detect: write a
    // wrong cached value directly, bypassing the ledger.
    await Invoice.updateOne(
      { _id: invoice._id },
      { $set: { amountPaidMinor: 999_999, amountDueMinor: 555 } },
    )

    const reloaded = await Invoice.findById(invoice._id)
    const audit = await auditInvoiceBalance(reloaded!)

    expect(audit.drifted).toBe(true)
    expect(audit.ledgerPaidMinor).toBe(100_000)
    expect(audit.cachedPaidMinor).toBe(999_999)
  })

  it('repairs drift from the ledger, which always wins', async () => {
    const invoice = await seedInvoice(100_000)
    await charge(invoice)
    await applyPayment(invoice, 60_000, { source: 't', idempotencyKey: 'payment:partial' })

    await Invoice.updateOne(
      { _id: invoice._id },
      { $set: { amountPaidMinor: 0, amountDueMinor: 100_000 } },
    )

    const report = await reconcileBalances({ repair: true })

    expect(report.drifted).toBeGreaterThanOrEqual(1)
    expect(report.repaired).toBeGreaterThanOrEqual(1)

    const repaired = await Invoice.findById(invoice._id)
    expect(repaired!.amountPaidMinor).toBe(60_000)
    expect(repaired!.amountDueMinor).toBe(40_000)
  })

  it('reports no drift on a healthy set of invoices', async () => {
    const invoice = await seedInvoice(100_000)
    await charge(invoice)
    await applyPayment(invoice, 100_000, { source: 't', idempotencyKey: 'payment:clean' })

    const report = await reconcileBalances({ repair: false })
    expect(report.drifted).toBe(0)
  })
})

describeIntegration('ledger — void reverses the receivable', () => {
  it('removes a voided invoice from the amount owed', async () => {
    const invoice = await seedInvoice(70_000)
    await charge(invoice)
    expect(await computeOutstanding(invoice._id)).toBe(70_000)

    await postEntry({
      invoice,
      type: LedgerEntryType.VOID,
      amountMinor: invoice.totalMinor,
      idempotencyKey: `void:${invoice._id.toString()}`,
      description: 'Voided',
    })

    expect(await computeOutstanding(invoice._id)).toBe(0)
    // The charge is still on record; it was reversed, not erased.
    const history = await entryHistory(invoice._id)
    expect(history).toHaveLength(2)
  })
})
