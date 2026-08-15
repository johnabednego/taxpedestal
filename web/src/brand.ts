/**
 * Brand.
 *
 * ONE definition of the product's identity, referenced everywhere.
 *
 * Translation strings carry a {brand} placeholder that `t()` substitutes
 * automatically, so a rename touches this file and nothing else. That design
 * has now paid for itself three times over.
 */

export const BRAND = {
  name: 'TaxPedestal',

  /** Shown in the sidebar and on narrow screens where the full name wraps. */
  shortName: 'Pedestal',

  /**
   * A pedestal is the base a thing stands on. The product is meant to be the
   * one your billing rests on: tax computed correctly, money collected, books
   * that reconcile.
   *
   * NAMES CONSIDERED AND WHY THEY WERE DROPPED, so this is not relitigated:
   *  - Meridian: heavily used across financial services, weak to defend.
   *  - Tributa: clean Latin root, but the founder preferred an English name.
   *  - TaxJil: a genuine hazard. TaxJar is a large tax-compliance product owned
   *    by Stripe since 2021, and Stripe is a provider this product integrates
   *    with. One letter apart in an identical class is how a rebrand happens
   *    under legal pressure rather than on your own terms.
   *
   * KNOWN WEAKNESS, recorded honestly: "Tax*" is a crowded prefix and
   * descriptive compounds are the hardest marks to register and defend. A
   * clearance search in the relevant Nice classes should happen before any money
   * goes on a domain or a filing. Dropping to `shortName` alone is a one-line
   * change here if that search comes back badly.
   */
  etymology: 'A pedestal — the base a thing stands on',

  tagline: 'Invoice the world. Get the tax right.',

  description:
    'Global invoicing with correct tax in every jurisdiction, and payment on whatever rail your customer actually uses.',

  /** Colours mirror tailwind.config.js. Kept here for SVG and email use. */
  colors: {
    ink: '#0B1B3A',
    accent: '#2B59FF',
    paid: '#0E9F6E',
  },

  domain: 'taxpedestal.app',
  supportEmail: 'support@taxpedestal.app',
} as const

export type Brand = typeof BRAND
