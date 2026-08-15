/**
 * Invoice presentation: templates and language.
 *
 * The counterpart to requirements.ts. That file decides WHAT must appear; this
 * one decides how it looks and what language it is written in.
 *
 * DESIGN DECISION: layout presets with slots, not a free canvas.
 *
 * A drag-and-drop designer sounds more flexible and is worse here:
 *   - it lets a user delete a legally required element,
 *   - it produces layouts that break when a tax rule adds a component line,
 *   - it is a large surface to build and maintain for a document whose
 *     structure is, in every country, a header, a party block, a line table and
 *     a totals block,
 *   - and most people do not want to design an invoice. They want one that is
 *     correct and looks professional.
 *
 * So users choose a preset, set brand colour and logo, pick the document
 * language, toggle OPTIONAL blocks, and add custom fields. Required elements
 * are not removable, and new tax components appear automatically because the
 * totals block is generated from the tax snapshot rather than positioned by
 * hand.
 */

export type TemplatePreset = 'classic' | 'modern' | 'compact'

export interface TemplateSettings {
  preset: TemplatePreset
  accentColor: string
  /** BCP 47 tag. Defaults to the customer's country language where known. */
  documentLocale: string | null
  showLogo: boolean
  showPaymentInstructions: boolean
  showTaxSummary: boolean
  /** Free-form rows printed in the header, e.g. "Project code: X". */
  customFields: Array<{ label: string; value: string }>
  /** Overrides the jurisdiction default, e.g. "TAX INVOICE" vs "INVOICE". */
  documentTitleOverride: string | null
}

export const DEFAULT_TEMPLATE: TemplateSettings = {
  preset: 'classic',
  accentColor: '#2B59FF',
  documentLocale: null,
  showLogo: true,
  showPaymentInstructions: true,
  showTaxSummary: true,
  customFields: [],
  documentTitleOverride: null,
}

/**
 * Document label translations.
 *
 * An invoice sent to a French customer that says "Invoice" and "Total Due" is
 * legible but reads as foreign. Translating the dozen structural labels is
 * cheap and makes the document feel local.
 *
 * SCOPE, STATED HONESTLY: these are structural labels only, never the tax
 * component names, which come from the tax engine and are already
 * jurisdiction-correct ("TVA (20%)", "GST (18%)"). The set below covers the
 * languages of the largest invoicing markets. Anything missing falls back to
 * English rather than showing a key.
 *
 * Before commercial launch these should be reviewed by a native speaker with
 * accounting vocabulary; "invoice" and "receipt" are distinct legal terms in
 * several of these languages and a plausible-looking mistranslation on a tax
 * document is worse than English.
 */
export type LabelKey =
  | 'invoice'
  | 'taxInvoice'
  | 'billTo'
  | 'from'
  | 'description'
  | 'quantity'
  | 'unitPrice'
  | 'amount'
  | 'subtotal'
  | 'discount'
  | 'tax'
  | 'total'
  | 'paid'
  | 'amountDue'
  | 'issueDate'
  | 'dueDate'
  | 'reference'
  | 'notes'
  | 'howToPay'
  | 'payOnline'
  | 'taxId'
  | 'page'

type LabelSet = Record<LabelKey, string>

const EN: LabelSet = {
  invoice: 'INVOICE',
  taxInvoice: 'TAX INVOICE',
  billTo: 'BILL TO',
  from: 'FROM',
  description: 'DESCRIPTION',
  quantity: 'QTY',
  unitPrice: 'UNIT PRICE',
  amount: 'AMOUNT',
  subtotal: 'Subtotal',
  discount: 'Discount',
  tax: 'Tax',
  total: 'Total',
  paid: 'Paid',
  amountDue: 'Amount due',
  issueDate: 'Issue date',
  dueDate: 'Due date',
  reference: 'Reference',
  notes: 'NOTES',
  howToPay: 'HOW TO PAY',
  payOnline: 'PAY ONLINE',
  taxId: 'Tax ID',
  page: 'Page',
}

const LABELS: Record<string, Partial<LabelSet>> = {
  en: EN,
  fr: {
    invoice: 'FACTURE',
    taxInvoice: 'FACTURE',
    billTo: 'FACTURÉ À',
    from: 'DE',
    description: 'DÉSIGNATION',
    quantity: 'QTÉ',
    unitPrice: 'PRIX UNITAIRE',
    amount: 'MONTANT',
    subtotal: 'Sous-total',
    discount: 'Remise',
    tax: 'TVA',
    total: 'Total',
    paid: 'Payé',
    amountDue: 'Montant dû',
    issueDate: 'Date d’émission',
    dueDate: 'Date d’échéance',
    reference: 'Référence',
    notes: 'NOTES',
    howToPay: 'MODALITÉS DE PAIEMENT',
    payOnline: 'PAYER EN LIGNE',
    taxId: 'N° de TVA',
    page: 'Page',
  },
  es: {
    invoice: 'FACTURA',
    taxInvoice: 'FACTURA',
    billTo: 'FACTURAR A',
    from: 'DE',
    description: 'DESCRIPCIÓN',
    quantity: 'CANT.',
    unitPrice: 'PRECIO UNITARIO',
    amount: 'IMPORTE',
    subtotal: 'Subtotal',
    discount: 'Descuento',
    tax: 'Impuesto',
    total: 'Total',
    paid: 'Pagado',
    amountDue: 'Importe pendiente',
    issueDate: 'Fecha de emisión',
    dueDate: 'Fecha de vencimiento',
    reference: 'Referencia',
    notes: 'NOTAS',
    howToPay: 'FORMA DE PAGO',
    payOnline: 'PAGAR EN LÍNEA',
    taxId: 'NIF',
    page: 'Página',
  },
  de: {
    invoice: 'RECHNUNG',
    taxInvoice: 'RECHNUNG',
    billTo: 'RECHNUNGSEMPFÄNGER',
    from: 'VON',
    description: 'BESCHREIBUNG',
    quantity: 'MENGE',
    unitPrice: 'EINZELPREIS',
    amount: 'BETRAG',
    subtotal: 'Zwischensumme',
    discount: 'Rabatt',
    tax: 'USt.',
    total: 'Gesamt',
    paid: 'Bezahlt',
    amountDue: 'Offener Betrag',
    issueDate: 'Rechnungsdatum',
    dueDate: 'Fälligkeitsdatum',
    reference: 'Referenz',
    notes: 'HINWEISE',
    howToPay: 'ZAHLUNGSHINWEISE',
    payOnline: 'ONLINE BEZAHLEN',
    taxId: 'USt-IdNr.',
    page: 'Seite',
  },
  pt: {
    invoice: 'FATURA',
    taxInvoice: 'FATURA',
    billTo: 'FATURAR A',
    from: 'DE',
    description: 'DESCRIÇÃO',
    quantity: 'QTD',
    unitPrice: 'PREÇO UNITÁRIO',
    amount: 'VALOR',
    subtotal: 'Subtotal',
    discount: 'Desconto',
    tax: 'Imposto',
    total: 'Total',
    paid: 'Pago',
    amountDue: 'Valor em dívida',
    issueDate: 'Data de emissão',
    dueDate: 'Data de vencimento',
    reference: 'Referência',
    notes: 'NOTAS',
    howToPay: 'COMO PAGAR',
    payOnline: 'PAGAR ONLINE',
    taxId: 'NIF',
    page: 'Página',
  },
  it: {
    invoice: 'FATTURA',
    taxInvoice: 'FATTURA',
    billTo: 'DESTINATARIO',
    from: 'DA',
    description: 'DESCRIZIONE',
    quantity: 'Q.TÀ',
    unitPrice: 'PREZZO UNITARIO',
    amount: 'IMPORTO',
    subtotal: 'Imponibile',
    discount: 'Sconto',
    tax: 'IVA',
    total: 'Totale',
    paid: 'Pagato',
    amountDue: 'Importo dovuto',
    issueDate: 'Data emissione',
    dueDate: 'Data scadenza',
    reference: 'Riferimento',
    notes: 'NOTE',
    howToPay: 'MODALITÀ DI PAGAMENTO',
    payOnline: 'PAGA ONLINE',
    taxId: 'P. IVA',
    page: 'Pagina',
  },
  nl: {
    invoice: 'FACTUUR',
    taxInvoice: 'FACTUUR',
    billTo: 'FACTUURADRES',
    from: 'VAN',
    description: 'OMSCHRIJVING',
    quantity: 'AANTAL',
    unitPrice: 'STUKPRIJS',
    amount: 'BEDRAG',
    subtotal: 'Subtotaal',
    discount: 'Korting',
    tax: 'BTW',
    total: 'Totaal',
    paid: 'Betaald',
    amountDue: 'Openstaand bedrag',
    issueDate: 'Factuurdatum',
    dueDate: 'Vervaldatum',
    reference: 'Referentie',
    notes: 'OPMERKINGEN',
    howToPay: 'BETALINGSGEGEVENS',
    payOnline: 'ONLINE BETALEN',
    taxId: 'BTW-nummer',
    page: 'Pagina',
  },
}

/**
 * Default document language for a country.
 *
 * Only where it is unambiguous. Multilingual countries are left to English so
 * the product does not guess wrong on a legal document, the user can override.
 */
const COUNTRY_LANGUAGE: Record<string, string> = {
  FR: 'fr', BE: 'fr', MC: 'fr', SN: 'fr', CI: 'fr', ML: 'fr', BF: 'fr', NE: 'fr',
  ES: 'es', MX: 'es', AR: 'es', CO: 'es', CL: 'es', PE: 'es', VE: 'es', EC: 'es',
  DE: 'de', AT: 'de',
  PT: 'pt', BR: 'pt', AO: 'pt', MZ: 'pt',
  IT: 'it', SM: 'it',
  NL: 'nl',
}

export function defaultDocumentLocale(customerCountry: string): string {
  return COUNTRY_LANGUAGE[customerCountry.toUpperCase()] ?? 'en'
}

/**
 * Resolve labels for a locale, falling back per-key to English.
 *
 * Per-key rather than per-language, so a partially translated set still
 * renders a complete document instead of showing blanks.
 */
export function labelsFor(locale: string | null | undefined): LabelSet {
  if (!locale) return EN
  const primary = locale.split('-')[0]?.toLowerCase() ?? 'en'
  const set = LABELS[primary]
  if (!set) return EN
  return { ...EN, ...set }
}

export function supportedDocumentLocales(): Array<{ code: string; name: string }> {
  return Object.keys(LABELS).map((code) => {
    let name = code
    try {
      name = new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code
    } catch {
      /* fall back to the code */
    }
    return { code, name }
  })
}
