import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../../core/asyncHandler'
import { SUPPORTED_CURRENCY_CODES, formatMoney } from '../../core/money'
import { publicLimiter } from '../../middleware/rateLimit'
import { validate } from '../../middleware/validate'
import { priceInvoice } from '../invoices/pricing'
import { describeTaxTreatment } from '../invoices/invoice.service'
import { TaxTreatment } from '../../services/tax/types'

/**
 * Anonymous tax preview.
 *
 * Powers the interactive invoice on the marketing page, so a visitor can see
 * the engine work before signing up. Safe to expose because it is a PURE
 * COMPUTATION, it touches no database, reads no tenant data, and returns only
 * what the caller supplied plus the tax that applies to it.
 *
 * Rate limited like any other public endpoint. Mounted before the authenticated
 * invoice router so this one path bypasses the auth guard while every other
 * /invoices route does not.
 */
const router = Router()

const previewSchema = z.object({
  supplierCountry: z.string().trim().toUpperCase().length(2),
  // Sub-national code. Changes the answer in India (intra-state CGST+SGST vs
  // inter-state IGST) and in origin-sourced US states.
  supplierRegion: z.string().trim().toUpperCase().max(10).nullish(),
  supplierTaxRegistered: z.boolean().default(true),
  customer: z.object({
    country: z.string().trim().toUpperCase().length(2),
    region: z.string().trim().toUpperCase().max(10).nullish(),
    isBusiness: z.boolean().default(true),
    taxId: z.string().trim().max(60).nullish(),
    taxRegistered: z.boolean().default(false),
  }),
  currency: z.string().trim().toUpperCase().refine((c) => SUPPORTED_CURRENCY_CODES.includes(c)),
  // Capped tighter than the authenticated endpoint: this is a demo, not a
  // computation service someone should batch through.
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(200),
        quantityMilli: z.number().int().min(0).max(1_000_000),
        unitAmountMinor: z.number().int().min(-100_000_000).max(100_000_000),
        supplyType: z.enum(['goods', 'services', 'digital_services']).default('services'),
      }),
    )
    .max(10),
  discountBasisPoints: z.number().int().min(0).max(10_000).default(0),
})

router.post(
  '/preview-public',
  publicLimiter,
  validate(previewSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof previewSchema>

    const priced = priceInvoice(body.lines, {
      supplier: {
        country: body.supplierCountry,
        region: body.supplierRegion ?? null,
        taxRegistered: body.supplierTaxRegistered,
        // A plausible identifier so registration-dependent rules engage.
        taxId: 'DEMO-TAX-ID',
      },
      customer: {
        country: body.customer.country,
        region: body.customer.region ?? null,
        taxRegistered: body.customer.taxRegistered,
        taxId: body.customer.taxId ?? null,
        isBusiness: body.customer.isBusiness,
      },
      currency: body.currency,
      issueDate: new Date(),
      discountBasisPoints: body.discountBasisPoints,
    })

    res.json({
      subtotalMinor: priced.subtotalMinor,
      discountMinor: priced.discountMinor,
      taxMinor: priced.taxMinor,
      totalMinor: priced.totalMinor,
      taxComponents: priced.taxComponents,
      taxNotes: priced.taxNotes,
      treatmentLabel: describeTaxTreatment(priced.taxTreatments as TaxTreatment[]),
      formatted: {
        subtotal: formatMoney(priced.subtotalMinor, body.currency),
        tax: formatMoney(priced.taxMinor, body.currency),
        total: formatMoney(priced.totalMinor, body.currency),
      },
    })
  }),
)

export default router
