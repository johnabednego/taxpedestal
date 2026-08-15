import { Router, raw } from 'express'
import { logger } from '../../core/logger'
import { handleWebhook } from './webhook.service'
import type { ProviderId } from '../../services/payments/types'

/**
 * Webhook endpoints.
 *
 * RAW BODY IS MANDATORY. Signature verification hashes the exact bytes the
 * provider sent. express.json() parses and discards them, and re-serialising
 * with JSON.stringify produces different bytes whenever key order or whitespace
 * differs, verification then fails for every request. This router therefore
 * uses express.raw and is mounted BEFORE the JSON parser in app.ts.
 *
 * These routes are deliberately NOT rate limited: throttling a provider's
 * retries would drop legitimate payment events. Cost of abuse is bounded
 * because an invalid signature is rejected before any database work beyond a
 * single audit insert.
 */
const router = Router()

const rawJson = raw({ type: 'application/json', limit: '1mb' })

function makeHandler(providerId: ProviderId) {
  return async (req: Parameters<Parameters<typeof router.post>[1]>[0], res: Parameters<Parameters<typeof router.post>[1]>[1]): Promise<void> => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''))

    // Normalise headers to a plain lowercase record for the provider adapters.
    const headers: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value
    }

    try {
      const outcome = await handleWebhook(providerId, body, headers)

      if (outcome.status === 'invalid') {
        // 400 tells the provider the request was rejected, which surfaces in
        // their dashboard as a failed delivery, exactly what we want an
        // operator to see if a secret was rotated without a deploy.
        res.status(400).json({ received: false, reason: 'Signature verification failed' })
        return
      }

      // Everything else acknowledges. The event is durably recorded, so a retry
      // would only re-deliver something already stored.
      res.status(200).json({ received: true, status: outcome.status })
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error), provider: providerId },
        'Webhook handler threw before recording the event',
      )
      // 500 here is correct: nothing was stored, so we WANT the retry.
      res.status(500).json({ received: false })
    }
  }
}

router.post('/stripe', rawJson, (req, res) => void makeHandler('STRIPE')(req, res))
router.post('/paystack', rawJson, (req, res) => void makeHandler('PAYSTACK')(req, res))

export default router
