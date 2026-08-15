import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, Globe } from 'lucide-react'
import clsx from 'clsx'
import { useI18n } from '../i18n'

/**
 * Language switcher.
 *
 * Lists each language by its ENDONYM — its name in itself — because someone
 * looking for Arabic scans for "العربية", not "Arabic". The English name is
 * shown alongside for orientation.
 *
 * Coverage is shown when a catalogue is incomplete. Hiding it would let a user
 * pick a language and then wonder why parts of the interface are in English;
 * saying "82%" up front sets the expectation honestly.
 *
 * ============================================================================
 * PLACEMENT
 * ============================================================================
 * This control appears at the BOTTOM of the sidebar as well as in page
 * headers. A menu that always opened downwards ran off the bottom of the
 * viewport there, leaving most of the list unreachable. The menu therefore
 * measures the space around the trigger when it opens and flips above it when
 * there is more room there, capping its height to whatever space it actually
 * has rather than a fixed guess.
 */
export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, languages, t } = useI18n()
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<{ dropUp: boolean; maxHeight: number }>({
    dropUp: false,
    maxHeight: 320,
  })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const current = languages.find((l) => l.code === locale)

  /**
   * Decide direction before paint, so the menu never appears in the wrong
   * place for a frame and then jumps.
   */
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return

    const GAP = 8
    const rect = triggerRef.current.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom - GAP
    const above = rect.top - GAP
    // Prefer downwards; only flip when above genuinely has more room.
    const dropUp = below < 240 && above > below

    setPlacement({
      dropUp,
      // Never taller than the space available, and never so short it is
      // useless — the list scrolls inside whatever it gets.
      maxHeight: Math.max(160, Math.min(360, dropUp ? above : below)),
    })
  }, [open])

  // Escape closes, matching the modal behaviour elsewhere.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        aria-label={t('nav.language')}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={clsx(
          'inline-flex items-center gap-1.5 rounded-lg text-sm text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900',
          compact ? 'px-2 py-1.5' : 'px-2.5 py-2 w-full',
          open && 'bg-ink-100 text-ink-900',
        )}
      >
        <Globe className="h-4 w-4 shrink-0" />
        {!compact && <span className="flex-1 text-start truncate">{current?.endonym ?? locale}</span>}
        {compact && <span className="uppercase">{locale.split('-')[0]}</span>}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="listbox"
            style={{ maxHeight: placement.maxHeight }}
            className={clsx(
              'absolute z-50 w-56 overflow-y-auto overscroll-contain rounded-lg border border-ink-200 bg-white py-1 shadow-lift',
              // Logical positioning so the menu opens correctly in RTL too.
              'end-0',
              placement.dropUp ? 'bottom-full mb-1' : 'top-full mt-1',
            )}
          >
            {languages.map((language) => (
              <button
                key={language.code}
                role="option"
                aria-selected={language.code === locale}
                onClick={() => {
                  setLocale(language.code)
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-ink-50"
                lang={language.code}
                dir={language.rtl ? 'rtl' : 'ltr'}
              >
                <span className="flex-1 truncate">
                  <span className="font-medium text-ink-900">{language.endonym}</span>
                  {language.exonym.toLowerCase() !== language.endonym.toLowerCase() && (
                    <span className="ms-1.5 text-xs text-ink-400">{language.exonym}</span>
                  )}
                </span>
                {language.coverage < 100 && (
                  <span className="shrink-0 text-2xs text-ink-400">{language.coverage}%</span>
                )}
                {language.code === locale && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-cobalt" />
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
