import { useState } from 'react'
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
 */
export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, languages, t } = useI18n()
  const [open, setOpen] = useState(false)
  const current = languages.find((l) => l.code === locale)

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={t('nav.language')}
        aria-expanded={open}
        className={clsx(
          'inline-flex items-center gap-1.5 rounded-lg text-sm text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900',
          compact ? 'px-2 py-1.5' : 'px-2.5 py-2 w-full',
        )}
      >
        <Globe className="h-4 w-4 shrink-0" />
        {!compact && <span className="flex-1 text-start truncate">{current?.endonym ?? locale}</span>}
        {compact && <span className="uppercase">{locale.split('-')[0]}</span>}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div
            className={clsx(
              'absolute z-20 mt-1 max-h-80 w-56 overflow-y-auto rounded-lg border border-ink-200 bg-white py-1 shadow-lift',
              // Logical positioning so the menu opens correctly in RTL too.
              'end-0',
            )}
          >
            {languages.map((language) => (
              <button
                key={language.code}
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
