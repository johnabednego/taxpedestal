import { Router } from 'express'
import dayjs from 'dayjs'
import { z } from 'zod'
import { asyncHandler } from '../../core/asyncHandler'
import { formatMoney } from '../../core/money'
import { requireAuth, requireOrg } from '../../middleware/auth'
import { validate } from '../../middleware/validate'
import { Client, Invoice, InvoiceStatus, LedgerEntryType, LedgerEntry, Payment, PaymentStatus } from '../../models'

/**
 * Dashboard analytics.
 *
 * Every figure is computed by aggregation rather than by loading documents into
 * Node, so the dashboard stays fast as invoice volume grows. All pipelines
 * begin with an $match on org, which matches the leading field of the compound
 * indexes and keeps them index-covered.
 */
const router = Router()
router.use(requireAuth, requireOrg)

const rangeQuery = z.object({
  months: z.coerce.number().int().min(1).max(24).default(12),
})

router.get(
  '/summary',
  validate(rangeQuery, 'query'),
  asyncHandler(async (req, res) => {
    const org = req.org!.id
    const currency = req.org!.baseCurrency
    const { months } = req.query as unknown as z.infer<typeof rangeQuery>
    const since = dayjs().subtract(months, 'month').startOf('month').toDate()
    const now = new Date()

    const [outstanding, overdue, paidThisMonth, draftCount, clientCount, aging, monthly, topClients, recentPayments] =
      await Promise.all([
        // Money owed across all open invoices.
        Invoice.aggregate<{ total: number; count: number }>([
          { $match: { org, status: { $in: [InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.OVERDUE] } } },
          { $group: { _id: null, total: { $sum: '$amountDueMinor' }, count: { $sum: 1 } } },
        ]),
        Invoice.aggregate<{ total: number; count: number }>([
          { $match: { org, status: InvoiceStatus.OVERDUE } },
          { $group: { _id: null, total: { $sum: '$amountDueMinor' }, count: { $sum: 1 } } },
        ]),
        // Actual cash received this month, from the ledger.
        LedgerEntry.aggregate<{ total: number }>([
          {
            $match: {
              org,
              type: LedgerEntryType.PAYMENT,
              effectiveAt: { $gte: dayjs().startOf('month').toDate() },
            },
          },
          { $group: { _id: null, total: { $sum: '$amountMinor' } } },
        ]),
        Invoice.countDocuments({ org, status: InvoiceStatus.DRAFT }),
        Client.countDocuments({ org, archivedAt: null }),

        // Aging buckets — the report every finance team asks for first.
        Invoice.aggregate<{ _id: string; total: number; count: number }>([
          {
            $match: {
              org,
              status: { $in: [InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.OVERDUE] },
              amountDueMinor: { $gt: 0 },
            },
          },
          {
            $addFields: {
              daysLate: {
                $divide: [{ $subtract: [now, '$dueDate'] }, 1000 * 60 * 60 * 24],
              },
            },
          },
          {
            $bucket: {
              groupBy: '$daysLate',
              boundaries: [-100000, 0, 31, 61, 91],
              default: '90+',
              output: { total: { $sum: '$amountDueMinor' }, count: { $sum: 1 } },
            },
          },
        ]),

        // Invoiced vs collected by month.
        Invoice.aggregate<{ _id: string; invoiced: number; count: number }>([
          { $match: { org, status: { $ne: InvoiceStatus.DRAFT }, issueDate: { $gte: since } } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m', date: '$issueDate' } },
              invoiced: { $sum: '$totalMinor' },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ]),

        Invoice.aggregate<{ _id: unknown; total: number; count: number }>([
          { $match: { org, status: { $ne: InvoiceStatus.DRAFT } } },
          { $group: { _id: '$client', total: { $sum: '$totalMinor' }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
          { $limit: 5 },
          { $lookup: { from: 'clients', localField: '_id', foreignField: '_id', as: 'client' } },
          { $unwind: '$client' },
          { $project: { name: '$client.name', total: 1, count: 1 } },
        ]),

        Payment.find({ org, status: PaymentStatus.SUCCEEDED })
          .sort({ paidAt: -1 })
          .limit(8)
          .populate('invoice', 'number'),
      ])

    const collected = await LedgerEntry.aggregate<{ _id: string; collected: number }>([
      { $match: { org, type: LedgerEntryType.PAYMENT, effectiveAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$effectiveAt' } },
          collected: { $sum: '$amountMinor' },
        },
      },
      { $sort: { _id: 1 } },
    ])

    const collectedByMonth = new Map(collected.map((c) => [c._id, Math.abs(c.collected)]))

    /**
     * Aging buckets carry a stable id as well as English text.
     *
     * The id is what the client translates against; the text is the fallback
     * for any consumer that has no catalogue. Returning only prose would make
     * the dashboard permanently English no matter which language is selected.
     */
    const bucketIds: Record<string, string> = {
      '-100000': 'notYetDue',
      '0': 'days1to30',
      '31': 'days31to60',
      '61': 'days61to90',
      '90+': 'days90plus',
    }
    const bucketLabels: Record<string, string> = {
      '-100000': 'Not yet due',
      '0': '1–30 days',
      '31': '31–60 days',
      '61': '61–90 days',
      '90+': '90+ days',
    }

    res.json({
      currency,
      outstanding: {
        amountMinor: outstanding[0]?.total ?? 0,
        formatted: formatMoney(outstanding[0]?.total ?? 0, currency),
        count: outstanding[0]?.count ?? 0,
      },
      overdue: {
        amountMinor: overdue[0]?.total ?? 0,
        formatted: formatMoney(overdue[0]?.total ?? 0, currency),
        count: overdue[0]?.count ?? 0,
      },
      collectedThisMonth: {
        amountMinor: Math.abs(paidThisMonth[0]?.total ?? 0),
        formatted: formatMoney(Math.abs(paidThisMonth[0]?.total ?? 0), currency),
      },
      draftCount,
      clientCount,
      aging: aging.map((b) => ({
        bucketId: bucketIds[String(b._id)] ?? String(b._id),
        bucket: bucketLabels[String(b._id)] ?? String(b._id),
        amountMinor: b.total,
        formatted: formatMoney(b.total, currency),
        count: b.count,
      })),
      monthly: monthly.map((m) => ({
        month: m._id,
        invoicedMinor: m.invoiced,
        collectedMinor: collectedByMonth.get(m._id) ?? 0,
        count: m.count,
      })),
      topClients: topClients.map((c) => ({
        name: (c as unknown as { name: string }).name,
        amountMinor: c.total,
        formatted: formatMoney(c.total, currency),
        invoiceCount: c.count,
      })),
      recentPayments: recentPayments.map((p) => ({
        id: p._id.toString(),
        amountMinor: p.amountMinor,
        formatted: formatMoney(p.amountMinor, p.currency),
        method: p.method,
        channelDetail: p.channelDetail,
        paidAt: p.paidAt,
        invoiceNumber: (p.invoice as unknown as { number?: string })?.number ?? null,
      })),
    })
  }),
)

export default router
