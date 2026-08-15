/**
 * Provider health probing.
 *
 * ============================================================================
 * WHY THIS EXISTS: STATIC COVERAGE TABLES ROT
 * ============================================================================
 * The first version of coverage.ts hardcoded the set of countries where Stripe
 * onboards merchants. That set was accurate the day it was written and starts
 * decaying immediately: Stripe adds markets, Paystack expands, a provider
 * withdraws from a country. A stale table does not fail loudly — it quietly
 * tells a user in a newly supported country that they cannot accept cards, and
 * they leave.
 *
 * The fix is to invert authority. Our table becomes a HINT used only when we
 * have nothing better; the provider's own API becomes the SOURCE OF TRUTH the
 * moment credentials exist. Stripe knows whether this account can take charges.
 * We should ask it rather than guess.
 *
 * Three rules follow:
 *
 *   1. A live probe always outranks reference data.
 *   2. Reference data carries a review date, and goes stale visibly.
 *   3. Our table NEVER hard-blocks. If a user believes their country is now
 *      supported, they may attempt it, and the provider decides. Being wrong
 *      in the direction of "let them try" costs a clear error message; being
 *      wrong the other way costs a customer.
 */

import { logger } from '../../core/logger'
import { env } from '../../config/env'
import type { ProviderId } from './types'

export interface ProviderHealth {
  provider: ProviderId
  /** Credentials present in configuration. */
  configured: boolean
  /** The provider's API answered. */
  reachable: boolean
  /** Whether this account can actually take money right now. */
  chargesEnabled: boolean | null
  /** Country the provider has on file for this account — authoritative. */
  accountCountry: string | null
  /** Currencies or methods the provider reports, where available. */
  capabilities: string[]
  checkedAt: string
  error?: string
}

/**
 * Probes are cached: they cost a network round trip and the answer changes on
 * the scale of days, not requests. Refreshed on demand from the admin console.
 */
const CACHE_TTL_MS = 15 * 60 * 1000
const cache = new Map<ProviderId, { value: ProviderHealth; expiresAt: number }>()

function unconfigured(provider: ProviderId): ProviderHealth {
  return {
    provider,
    configured: false,
    reachable: false,
    chargesEnabled: null,
    accountCountry: null,
    capabilities: [],
    checkedAt: new Date().toISOString(),
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Provider did not respond in time')), ms),
    ),
  ])
}

/**
 * Ask Stripe about this account.
 *
 * `GET /v1/account` returns the account's country and whether charges are
 * enabled — which is the real question, and one no static table can answer.
 * An account can be in a supported country and still be unable to charge
 * because onboarding is incomplete.
 */
async function probeStripe(): Promise<ProviderHealth> {
  if (!env.STRIPE_SECRET_KEY) return unconfigured('STRIPE')

  const base: ProviderHealth = {
    provider: 'STRIPE',
    configured: true,
    reachable: false,
    chargesEnabled: null,
    accountCountry: null,
    capabilities: [],
    checkedAt: new Date().toISOString(),
  }

  try {
    const response = await withTimeout(
      fetch('https://api.stripe.com/v1/account', {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      }),
      8000,
    )

    if (!response.ok) {
      return { ...base, error: `Stripe responded ${response.status}` }
    }

    const account = (await response.json()) as {
      country?: string
      charges_enabled?: boolean
      capabilities?: Record<string, string>
    }

    return {
      ...base,
      reachable: true,
      chargesEnabled: Boolean(account.charges_enabled),
      accountCountry: account.country?.toUpperCase() ?? null,
      capabilities: Object.entries(account.capabilities ?? {})
        .filter(([, status]) => status === 'active')
        .map(([name]) => name),
    }
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Ask Paystack.
 *
 * Paystack has no account-status endpoint equivalent to Stripe's, so we call a
 * cheap authenticated endpoint. A 200 proves the key is live and the
 * integration is active; anything else tells us why not.
 */
async function probePaystack(): Promise<ProviderHealth> {
  if (!env.PAYSTACK_SECRET_KEY) return unconfigured('PAYSTACK')

  const base: ProviderHealth = {
    provider: 'PAYSTACK',
    configured: true,
    reachable: false,
    chargesEnabled: null,
    accountCountry: null,
    capabilities: [],
    checkedAt: new Date().toISOString(),
  }

  try {
    const response = await withTimeout(
      fetch('https://api.paystack.co/integration/payment_session_timeout', {
        headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` },
      }),
      8000,
    )

    if (response.status === 401) {
      return { ...base, error: 'Paystack rejected the secret key' }
    }
    if (!response.ok) {
      return { ...base, error: `Paystack responded ${response.status}` }
    }

    return { ...base, reachable: true, chargesEnabled: true }
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function probeProvider(
  provider: ProviderId,
  options: { force?: boolean } = {},
): Promise<ProviderHealth> {
  if (provider === 'MANUAL') {
    // Offline rails need no third party, so they are healthy by definition.
    // This is the whole point: the universal path has no dependency to probe.
    return {
      provider,
      configured: true,
      reachable: true,
      chargesEnabled: true,
      accountCountry: null,
      capabilities: ['offline'],
      checkedAt: new Date().toISOString(),
    }
  }

  const cached = cache.get(provider)
  if (!options.force && cached && cached.expiresAt > Date.now()) {
    return cached.value
  }

  const health = provider === 'STRIPE' ? await probeStripe() : await probePaystack()

  cache.set(provider, { value: health, expiresAt: Date.now() + CACHE_TTL_MS })

  if (health.configured && !health.reachable) {
    logger.warn({ provider, error: health.error }, 'Payment provider probe failed')
  }

  return health
}

/**
 * Probe every gateway.
 *
 * Returns a named object rather than an array so callers destructure by
 * meaning, not position — with `noUncheckedIndexedAccess` an array index is
 * `T | undefined` and every call site would need a redundant guard.
 */
export async function probeAll(
  options: { force?: boolean } = {},
): Promise<{ stripe: ProviderHealth; paystack: ProviderHealth; all: ProviderHealth[] }> {
  const [stripe, paystack] = await Promise.all([
    probeProvider('STRIPE', options),
    probeProvider('PAYSTACK', options),
  ])
  return { stripe, paystack, all: [stripe, paystack] }
}

/** Used by tests and by the admin console after credentials change. */
export function clearProbeCache(): void {
  cache.clear()
}
