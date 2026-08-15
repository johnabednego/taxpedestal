import { useEffect, useRef } from 'react'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useI18n } from '../i18n'

/**
 * Keeps the interface language in step between the browser and the account.
 *
 * ==========================================================================
 * THE PRECEDENCE RULES, IN ONE PLACE
 * ==========================================================================
 * A visitor can choose a language before they have an account, and an account
 * can remember a language chosen on another device. Those two can disagree, so
 * the order is fixed and deliberate:
 *
 *   1. An EXPLICIT choice in this browser wins. Someone who switched to French
 *      on the marketing page and then signed in should stay in French — and
 *      their account is updated to match, because that click was a decision.
 *
 *   2. Otherwise the ACCOUNT preference is adopted. A user who set Arabic on
 *      their laptop gets Arabic on their phone without hunting for the
 *      switcher, even though that phone's browser reports English.
 *
 *   3. Otherwise the browser's own language, then English.
 *
 * The alternative — letting the account always win — produces the worst
 * moment in the flow: you pick your language, sign in, and the site silently
 * switches back. Users read that as the product ignoring them.
 *
 * This lives in its own component because it needs BOTH contexts, and
 * AuthProvider sits inside I18nProvider. Rendering it as a child of the auth
 * tree is the cheapest way to reach both without inverting the providers or
 * threading callbacks through them.
 */
export function LocaleSync() {
  const { user } = useAuth()
  const { locale, setLocale, isExplicit } = useI18n()

  /** Guards against writing back the value we have just adopted. */
  const adopting = useRef(false)
  /** The last value successfully saved, so we do not re-send it. */
  const lastSaved = useRef<string | null>(null)

  // --- Rule 1 and 2: decide who wins at sign-in ---------------------------
  useEffect(() => {
    if (!user) return

    if (isExplicit()) {
      // The person chose in this browser. Their choice wins, and the account
      // is brought into line with it.
      if (user.preferredLocale !== locale && lastSaved.current !== locale) {
        lastSaved.current = locale
        void api('/api/v1/auth/preferences', {
          method: 'PATCH',
          body: { preferredLocale: locale },
        }).catch(() => {
          // A failed save is not worth interrupting anyone for; the browser
          // keeps the choice regardless and the next change retries.
          lastSaved.current = null
        })
      }
      return
    }

    // No deliberate choice here, so adopt whatever the account remembers.
    if (user.preferredLocale && user.preferredLocale !== locale) {
      adopting.current = true
      // `false` so adopting a stored value is not itself recorded as a new
      // decision — otherwise the next device would inherit it as explicit.
      setLocale(user.preferredLocale, false)
      lastSaved.current = user.preferredLocale
    }
  }, [user, locale, setLocale, isExplicit])

  // --- Persist later changes made while signed in -------------------------
  useEffect(() => {
    if (!user) return

    if (adopting.current) {
      adopting.current = false
      return
    }
    if (!isExplicit()) return
    if (lastSaved.current === locale) return

    lastSaved.current = locale
    void api('/api/v1/auth/preferences', {
      method: 'PATCH',
      body: { preferredLocale: locale },
    }).catch(() => {
      lastSaved.current = null
    })
  }, [locale, user, isExplicit])

  return null
}
