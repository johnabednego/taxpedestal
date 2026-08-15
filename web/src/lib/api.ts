/**
 * API client.
 *
 * Handles the access/refresh split: the access token lives in memory only (never
 * localStorage, which any XSS can read), and the refresh token is an httpOnly
 * cookie the browser sends automatically.
 *
 * A 401 triggers ONE refresh attempt, and concurrent 401s share that single
 * attempt rather than each firing their own, otherwise a dashboard making six
 * parallel requests would rotate the refresh token six times and trip the
 * server's reuse detection, logging the user out.
 */

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000'

let accessToken: string | null = null
let activeOrgId: string | null = null
let activeLocale: string | null = null
let refreshPromise: Promise<boolean> | null = null
let onUnauthorised: (() => void) | null = null

export const setAccessToken = (token: string | null): void => {
  accessToken = token
}
export const getAccessToken = (): string | null => accessToken
export const setActiveOrg = (id: string | null): void => {
  activeOrgId = id
}
/**
 * The interface language, sent with every request as `X-Locale`.
 *
 * The server localises what only it can: country names, and the language an
 * invoice document is rendered in. Accept-Language cannot carry this, it is a
 * forbidden header name that `fetch` refuses to set, and it describes the
 * browser rather than the choice the user just made in the switcher.
 */
export const setActiveLocale = (locale: string | null): void => {
  activeLocale = locale
}
export const setUnauthorisedHandler = (fn: (() => void) | null): void => {
  onUnauthorised = fn
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: { fields?: Record<string, string> } & Record<string, unknown>
  readonly requestId?: string

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    requestId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
    this.requestId = requestId
  }

  /** Field-level errors, ready to attach to inputs. */
  get fieldErrors(): Record<string, string> {
    return (this.details?.fields as Record<string, string>) ?? {}
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
  /** Skip the Authorization header (public endpoints). */
  anonymous?: boolean
  /** Sent as Idempotency-Key so a retry cannot duplicate the action. */
  idempotencyKey?: string
  skipRetry?: boolean
}

async function refreshAccessToken(): Promise<boolean> {
  // Share one in-flight refresh across all callers.
  refreshPromise ??= (async () => {
    try {
      const response = await fetch(`${API_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!response.ok) return false
      const data = (await response.json()) as { accessToken: string }
      accessToken = data.accessToken
      return true
    } catch {
      return false
    } finally {
      // Cleared on the next tick so simultaneous callers all observe the result.
      setTimeout(() => {
        refreshPromise = null
      }, 0)
    }
  })()

  return refreshPromise
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, anonymous, idempotencyKey, skipRetry, headers, ...rest } = options

  const requestHeaders: Record<string, string> = {
    Accept: 'application/json',
    ...(headers as Record<string, string> | undefined),
  }
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json'
  if (!anonymous && accessToken) requestHeaders.Authorization = `Bearer ${accessToken}`
  if (!anonymous && activeOrgId) requestHeaders['X-Organisation-Id'] = activeOrgId
  if (idempotencyKey) requestHeaders['Idempotency-Key'] = idempotencyKey
  // Sent on anonymous requests too: the public payment page and the landing
  // page's live preview are both localised, and neither has a session.
  if (activeLocale) requestHeaders['X-Locale'] = activeLocale

  const response = await fetch(`${API_URL}${path}`, {
    ...rest,
    headers: requestHeaders,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (response.status === 401 && !anonymous && !skipRetry) {
    if (await refreshAccessToken()) {
      return api<T>(path, { ...options, skipRetry: true })
    }
    onUnauthorised?.()
  }

  if (response.status === 204) return undefined as T

  const text = await response.text()
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { error: { code: 'BAD_RESPONSE', message: text.slice(0, 200) } }
    }
  }

  if (!response.ok) {
    const err = (payload as { error?: { code: string; message: string; details?: Record<string, unknown>; requestId?: string } })?.error
    throw new ApiError(
      response.status,
      err?.code ?? 'UNKNOWN',
      err?.message ?? 'Something went wrong',
      err?.details,
      err?.requestId,
    )
  }

  return payload as T
}

export const apiUrl = API_URL

/** Stable key for idempotent POSTs. */
export const newIdempotencyKey = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
