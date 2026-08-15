import { BRAND } from '../brand'

/**
 * The TaxPedestal mark.
 *
 * ==========================================================================
 * WHAT IT ENCODES
 * ==========================================================================
 * A jade tile raised on a two-part plinth: cap, column, base.
 *
 * The tile is the invoice, and jade is the colour reserved throughout the
 * product for money that has arrived. So the mark says what the name says:
 * your billing rests on a base that holds — tax computed correctly underneath,
 * the settled invoice on top.
 *
 * ==========================================================================
 * WHY THIS SHAPE AND NOT A SIMPLER ONE
 * ==========================================================================
 * Two other versions were drawn and rejected by rendering them at 16px:
 *
 *   - A jade BAR as the cap merged into the top slab at favicon size, leaving
 *     something that read as an I-beam rather than a pedestal.
 *   - Collapsing to three elements (jade top slab, column, base) had the same
 *     problem worse: symmetrical horizontal bars around a stem is an I-beam,
 *     whatever the colours.
 *
 * Making the elevated element a TILE — a different shape, not merely a
 * different colour — is what keeps "object on a plinth" legible when the mark
 * is sixteen pixels wide in a browser tab. A logo that only works at
 * presentation size is not finished.
 */
export function Logo({
  size = 32,
  monochrome = false,
  className,
}: {
  size?: number
  monochrome?: boolean
  className?: string
}) {
  const accent = monochrome ? '#FFFFFF' : BRAND.colors.accent
  const paid = monochrome ? '#FFFFFF' : BRAND.colors.paid

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label={BRAND.name}
    >
      <rect width="32" height="32" rx="8" fill={BRAND.colors.ink} />

      {/* The invoice, settled. A tile, so the silhouette survives 16px. */}
      <rect x="11.6" y="5.4" width="8.8" height="6.2" rx="1.6" fill={paid} />

      {/* Cap of the plinth. */}
      <rect x="8.6" y="13.4" width="14.8" height="2.6" rx="1.3" fill={accent} />

      {/* Column. Square-cornered on purpose — a plinth is not a rounded form. */}
      <rect x="13.4" y="16" width="5.2" height="5.8" fill={accent} />

      {/* Base: the widest element, so the mark reads bottom-heavy and stable. */}
      <rect x="6.2" y="21.8" width="19.6" height="2.9" rx="1.45" fill={accent} />
    </svg>
  )
}

/**
 * Logo with the name beside it.
 *
 * `short` renders just "Pedestal", for the sidebar and anywhere the full
 * compound name would wrap. Long compound names need a short form or they
 * break layouts.
 */
export function Wordmark({
  size = 28,
  short = false,
  className,
  textClassName,
}: {
  size?: number
  short?: boolean
  className?: string
  textClassName?: string
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <Logo size={size} />
      <span
        className={`font-display font-bold tracking-tightest text-ink-900 ${textClassName ?? 'text-lg'}`}
      >
        {short ? BRAND.shortName : BRAND.name}
      </span>
    </span>
  )
}

/**
 * The mark as a data URI, for the favicon and for embedding in email.
 *
 * Inlined rather than served as a file so it cannot 404 and costs no extra
 * request on first paint.
 */
export function logoDataUri(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="8" fill="${BRAND.colors.ink}"/>
<rect x="11.6" y="5.4" width="8.8" height="6.2" rx="1.6" fill="${BRAND.colors.paid}"/>
<rect x="8.6" y="13.4" width="14.8" height="2.6" rx="1.3" fill="${BRAND.colors.accent}"/>
<rect x="13.4" y="16" width="5.2" height="5.8" fill="${BRAND.colors.accent}"/>
<rect x="6.2" y="21.8" width="19.6" height="2.9" rx="1.45" fill="${BRAND.colors.accent}"/>
</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
