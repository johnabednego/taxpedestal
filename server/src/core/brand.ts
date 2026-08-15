/**
 * Brand.
 *
 * Server-side counterpart to web/src/brand.ts. Referenced by email templates,
 * PDF metadata, the JWT issuer claim and the seed script, so the product name
 * appears in exactly one place per codebase.
 */
export const BRAND = {
  name: 'TaxPedestal',
  shortName: 'Pedestal',
  tagline: 'Invoice the world. Get the tax right.',
  etymology: 'A pedestal, the base a thing stands on',
  domain: 'taxpedestal.app',
  colors: {
    ink: '#0B1B3A',
    accent: '#2B59FF',
    paid: '#0E9F6E',
  },
} as const
