import PDFDocument from 'pdfkit'
import { formatMoney } from '../../core/money'
import { BRAND } from '../../core/brand'
import { countryName } from '../../core/countries'
import {
  checkInvoiceCompliance,
  documentProfileFor,
} from '../documents/requirements'
import {
  DEFAULT_TEMPLATE,
  defaultDocumentLocale,
  labelsFor,
} from '../documents/templates'
import type { IClient, IInvoice, IOrganisation } from '../../models'

/**
 * Invoice PDF generation.
 *
 * Server-side with pdfkit rather than headless Chrome. A Puppeteer render is
 * prettier but pulls a ~300MB Chromium download, needs 500MB+ of RAM and
 * exceeds the memory limit of every free hosting tier — including Render's,
 * which this project targets. pdfkit draws vectors in-process in milliseconds.
 *
 * The trade-off is real and worth stating: layout is manual coordinate maths
 * rather than CSS, so complex designs are expensive to change. Logged as
 * technical debt; the escape hatch is to swap this one module for a rendering
 * service later without touching anything that calls it.
 *
 * COMPLIANCE, NOT DECORATION. Tax components are itemised separately because
 * several authorities require it — Ghana's GRA mandates VAT, NHIL and GETFund
 * appear as distinct lines even though they now share one base. Mandatory
 * statements (EU reverse-charge declarations) are printed verbatim from the
 * invoice's frozen tax snapshot, not recomputed.
 */

const INK = '#0B1B3A'
const MUTED = '#667085'
const RULE = '#E4E7EC'
const JADE = '#0E9F6E'

const PAGE_MARGIN = 48
const PAGE_WIDTH = 595.28 // A4 portrait, points
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2

export interface InvoicePdfInput {
  invoice: IInvoice
  organisation: IOrganisation
  client: IClient
  /**
   * Public payment URL, written out in full on the document.
   *
   * A printed or emailed PDF must still be payable. Hiding the link behind
   * anchor text would make a paper copy a dead end, which matters most for the
   * bank-transfer markets where paper is still normal.
   */
  payUrl?: string | null
}

/**
 * Render to a Buffer.
 *
 * Buffered rather than streamed to the response because the documents are
 * small (a few KB) and buffering lets the caller set Content-Length, which
 * makes downloads show a progress bar instead of hanging at "unknown size".
 */
export function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: PAGE_MARGIN,
        info: {
          Title: `Invoice ${input.invoice.number}`,
          // Author is the SUPPLIER, not us — the document is theirs.
          Author: input.organisation.name,
          Subject: `Invoice ${input.invoice.number} from ${input.organisation.name}`,
          // Creator names the software, which is the PDF convention and lets a
          // recipient's accounting system recognise the source.
          Creator: BRAND.name,
        },
      })

      const chunks: Buffer[] = []
      doc.on('data', (chunk: Buffer) => chunks.push(chunk))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      draw(doc, input)
      doc.end()
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function draw(
  doc: PDFKit.PDFDocument,
  { invoice, organisation, client, payUrl }: InvoicePdfInput,
): void {
  /**
   * Presentation comes from the organisation's template; the document TITLE and
   * mandatory statements come from the jurisdiction. Keeping those two sources
   * separate is the whole design: a user can restyle freely without being able
   * to drop a legally required element.
   */
  const template = { ...DEFAULT_TEMPLATE, ...(organisation.invoiceTemplate ?? {}) }
  const locale = template.documentLocale ?? defaultDocumentLocale(client.country)
  const t = labelsFor(locale)
  // Falls back to the brand blue when a workspace has not set one.
  const accent = template.accentColor || '#2B59FF'
  const profile = documentProfileFor(organisation.country)
  const compliance = checkInvoiceCompliance(invoice, organisation, client)

  const documentTitle =
    template.documentTitleOverride ??
    profile.documentTitle ??
    t.invoice
  const currency = invoice.currency
  const brand = /^#[0-9a-fA-F]{6}$/.test(organisation.brandColor)
    ? organisation.brandColor
    : '#2B59FF'

  /* --- Header ----------------------------------------------------------- */
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text(organisation.name, PAGE_MARGIN, PAGE_MARGIN)

  const supplierLines = [
    organisation.legalName && organisation.legalName !== organisation.name
      ? organisation.legalName
      : null,
    organisation.addressLine1,
    [organisation.city, organisation.postalCode].filter(Boolean).join(' '),
    countryName(organisation.country),
    organisation.email,
    organisation.taxRegistered && organisation.taxId ? `${t.taxId}: ${organisation.taxId}` : null,
  ].filter((line): line is string => Boolean(line))

  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
  let y = doc.y + 4
  for (const line of supplierLines) {
    doc.text(line, PAGE_MARGIN, y, { width: CONTENT_WIDTH * 0.5 })
    y = doc.y
  }

  // Invoice identity, right aligned.
  doc
    .font('Helvetica-Bold')
    .fontSize(26)
    .fillColor(brand)
    .fillColor(accent)
    .text(documentTitle, PAGE_MARGIN, PAGE_MARGIN, { width: CONTENT_WIDTH, align: 'right' })

  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(INK)
    .text(invoice.number, PAGE_MARGIN, PAGE_MARGIN + 32, {
      width: CONTENT_WIDTH,
      align: 'right',
    })

  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
  doc.text(
    `${t.issueDate}: ${new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(invoice.issueDate)}`,
    PAGE_MARGIN,
    PAGE_MARGIN + 48,
    { width: CONTENT_WIDTH, align: 'right' },
  )
  doc.text(`${t.dueDate}: ${new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(invoice.dueDate)}`, PAGE_MARGIN, PAGE_MARGIN + 60, {
    width: CONTENT_WIDTH,
    align: 'right',
  })

  /* --- Bill to ----------------------------------------------------------- */
  const billToY = Math.max(y, PAGE_MARGIN + 78) + 18

  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(t.billTo, PAGE_MARGIN, billToY)

  const clientLines = [
    client.name,
    client.contactName,
    client.addressLine1,
    [client.city, client.postalCode].filter(Boolean).join(' '),
    countryName(client.country),
    client.taxId ? `${t.taxId}: ${client.taxId}` : null,
  ].filter((line): line is string => Boolean(line))

  doc.font('Helvetica').fontSize(10).fillColor(INK)
  let clientY = billToY + 14
  for (const [index, line] of clientLines.entries()) {
    doc
      .font(index === 0 ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(index === 0 ? 11 : 9)
      .fillColor(index === 0 ? INK : MUTED)
      .text(line, PAGE_MARGIN, clientY, { width: CONTENT_WIDTH * 0.55 })
    clientY = doc.y
  }

  if (invoice.reference || invoice.purchaseOrderNumber) {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
    doc.text(
      [
        invoice.reference ? `${t.reference}: ${invoice.reference}` : null,
        invoice.purchaseOrderNumber ? `PO: ${invoice.purchaseOrderNumber}` : null,
      ]
        .filter(Boolean)
        .join('   '),
      PAGE_MARGIN,
      billToY + 14,
      { width: CONTENT_WIDTH, align: 'right' },
    )
  }

  /* --- Line items -------------------------------------------------------- */
  let tableY = clientY + 26

  const columns = {
    description: PAGE_MARGIN,
    qty: PAGE_MARGIN + CONTENT_WIDTH * 0.52,
    unit: PAGE_MARGIN + CONTENT_WIDTH * 0.64,
    amount: PAGE_MARGIN + CONTENT_WIDTH * 0.82,
  }
  const amountWidth = CONTENT_WIDTH * 0.18

  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED)
  doc.text(t.description, columns.description, tableY)
  doc.text(t.quantity, columns.qty, tableY, { width: CONTENT_WIDTH * 0.1, align: 'right' })
  doc.text(t.unitPrice, columns.unit, tableY, { width: CONTENT_WIDTH * 0.16, align: 'right' })
  doc.text(t.amount, columns.amount, tableY, { width: amountWidth, align: 'right' })

  tableY += 14
  rule(doc, tableY)
  tableY += 8

  for (const line of invoice.lines) {
    // Page break before the row would overflow, so a long invoice paginates
    // rather than writing off the bottom edge.
    if (tableY > 700) {
      doc.addPage()
      tableY = PAGE_MARGIN
    }

    doc.font('Helvetica').fontSize(9.5).fillColor(INK)
    const descriptionHeight = doc.heightOfString(line.description, {
      width: CONTENT_WIDTH * 0.5,
    })
    doc.text(line.description, columns.description, tableY, { width: CONTENT_WIDTH * 0.5 })

    doc.fillColor(MUTED)
    doc.text(String(line.quantityMilli / 1000), columns.qty, tableY, {
      width: CONTENT_WIDTH * 0.1,
      align: 'right',
    })
    doc.text(formatMoney(line.unitAmountMinor, currency), columns.unit, tableY, {
      width: CONTENT_WIDTH * 0.16,
      align: 'right',
    })
    doc.fillColor(INK).text(formatMoney(line.netMinor, currency), columns.amount, tableY, {
      width: amountWidth,
      align: 'right',
    })

    tableY += Math.max(descriptionHeight, 12) + 8
  }

  rule(doc, tableY)
  tableY += 12

  /* --- Totals ------------------------------------------------------------ */
  const labelX = PAGE_MARGIN + CONTENT_WIDTH * 0.52
  const labelWidth = CONTENT_WIDTH * 0.28

  const totalRow = (label: string, value: string, bold = false): void => {
    doc
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(bold ? 11 : 9.5)
      .fillColor(bold ? INK : MUTED)
      .text(label, labelX, tableY, { width: labelWidth, align: 'right' })
    doc
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fillColor(INK)
      .text(value, columns.amount, tableY, { width: amountWidth, align: 'right' })
    tableY += bold ? 18 : 14
  }

  totalRow(t.subtotal, formatMoney(invoice.subtotalMinor, currency))
  if (invoice.discountMinor > 0) {
    totalRow('Discount', `-${formatMoney(invoice.discountMinor, currency)}`)
  }

  // Each tax component on its own line — a compliance requirement, not styling.
  for (const component of invoice.taxSnapshot?.components ?? []) {
    totalRow(component.label, formatMoney(component.amountMinor, currency))
  }

  tableY += 4
  rule(doc, tableY, labelX)
  tableY += 8
  totalRow(t.total, formatMoney(invoice.totalMinor, currency), true)

  if (invoice.amountPaidMinor > 0) {
    totalRow(t.paid, `-${formatMoney(invoice.amountPaidMinor, currency)}`)
    totalRow(t.amountDue, formatMoney(invoice.amountDueMinor, currency), true)
  }

  /* --- Paid stamp -------------------------------------------------------- */
  if (invoice.amountDueMinor <= 0 && invoice.totalMinor > 0) {
    doc.save()
    doc.rotate(-12, { origin: [PAGE_MARGIN + 90, tableY + 40] })
    doc
      .roundedRect(PAGE_MARGIN + 30, tableY + 20, 120, 42, 6)
      .lineWidth(2)
      .strokeColor(JADE)
      .stroke()
    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor(JADE)
      .text('PAID', PAGE_MARGIN + 30, tableY + 32, { width: 120, align: 'center' })
    doc.restore()
  }

  /* --- Tax statements ---------------------------------------------------- */
  let footerY = tableY + 30

  const taxNotes = invoice.taxSnapshot?.notes ?? []
  if (taxNotes.length > 0) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(t.tax.toUpperCase(), PAGE_MARGIN, footerY)
    footerY = doc.y + 4
    doc.font('Helvetica').fontSize(8.5).fillColor(INK)
    for (const note of taxNotes) {
      doc.text(note, PAGE_MARGIN, footerY, { width: CONTENT_WIDTH })
      footerY = doc.y + 2
    }
    footerY += 8
  }

  if (invoice.notes) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(t.notes, PAGE_MARGIN, footerY)
    footerY = doc.y + 4
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(INK)
      .text(invoice.notes, PAGE_MARGIN, footerY, { width: CONTENT_WIDTH })
    footerY = doc.y + 10
  }

  /* --- How to pay -------------------------------------------------------- */
  const instructions = organisation.paymentInstructions
  if (template.showPaymentInstructions && instructions?.enabled && invoice.amountDueMinor > 0) {
    if (footerY > 680) {
      doc.addPage()
      footerY = PAGE_MARGIN
    }

    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(t.howToPay, PAGE_MARGIN, footerY)
    footerY = doc.y + 4

    const details = [
      [payLabel('accountName', locale), instructions.accountName],
      [payLabel('bank', locale), instructions.bankName],
      [payLabel('accountNumber', locale), instructions.accountNumber],
      ['IBAN / routing', instructions.routingCode],
      ['SWIFT / BIC', instructions.swiftBic],
      [
        instructions.mobileMoneyProvider ?? 'Mobile money',
        instructions.mobileMoneyNumber,
      ],
      // The reference is what lets the supplier match the transfer to this
      // invoice, so it is always printed.
      [t.reference, invoice.number],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]))

    doc.fontSize(9)
    for (const [label, value] of details) {
      doc.font('Helvetica').fillColor(MUTED).text(`${label}: `, PAGE_MARGIN, footerY, {
        continued: true,
      })
      doc.font('Helvetica-Bold').fillColor(INK).text(value)
      footerY = doc.y + 1
    }

    if (instructions.additionalDetails) {
      footerY += 4
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(MUTED)
        .text(instructions.additionalDetails, PAGE_MARGIN, footerY, { width: CONTENT_WIDTH })
      footerY = doc.y
    }
  }

  /* --- Mandatory statements ---------------------------------------------- */
  /**
   * Printed from the jurisdiction profile, not from the template. These are
   * the sentences an invoice is legally required to carry — the EU's
   * reverse-charge mention, for instance — so they are not something the
   * presentation layer may switch off.
   */
  if (compliance.statements.length > 0) {
    footerY += 8
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
    for (const statement of compliance.statements) {
      doc.text(statement, PAGE_MARGIN, footerY, { width: CONTENT_WIDTH })
      footerY = doc.y + 2
    }
  }

  /* --- Pay online -------------------------------------------------------- */
  /**
   * The URL is written out in full rather than hidden behind anchor text.
   * A PDF gets printed, forwarded and read on paper — link text that says
   * "pay here" is a dead end in exactly the bank-transfer markets where paper
   * is still normal. Shown whenever money is outstanding, including when no
   * bank details are configured, since it may be the only way to pay.
   */
  if (payUrl && invoice.amountDueMinor > 0) {
    if (footerY > 720) {
      doc.addPage()
      footerY = PAGE_MARGIN
    }
    footerY += 10
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor(MUTED)
      .text(t.payOnline, PAGE_MARGIN, footerY)
    footerY = doc.y + 3
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(accent)
      .text(payUrl, PAGE_MARGIN, footerY, {
        width: CONTENT_WIDTH,
        link: payUrl,
        underline: true,
      })
  }

  /* --- Footer ------------------------------------------------------------ */
  if (invoice.footer) {
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(invoice.footer, PAGE_MARGIN, 780, { width: CONTENT_WIDTH, align: 'center' })
  }
}

/**
 * Bank-detail labels.
 *
 * Kept separate from the main label set because these are banking terms rather
 * than invoice structure, and a business may prefer them in English even on a
 * translated invoice so the payer can match them to their online banking form.
 * Falls back to English for any language not listed.
 */
const PAY_LABELS: Record<string, Record<string, string>> = {
  fr: { accountName: 'Titulaire du compte', bank: 'Banque', accountNumber: 'Numéro de compte' },
  es: { accountName: 'Titular de la cuenta', bank: 'Banco', accountNumber: 'Número de cuenta' },
  de: { accountName: 'Kontoinhaber', bank: 'Bank', accountNumber: 'Kontonummer' },
  pt: { accountName: 'Titular da conta', bank: 'Banco', accountNumber: 'Número da conta' },
  it: { accountName: 'Intestatario', bank: 'Banca', accountNumber: 'Numero di conto' },
  nl: { accountName: 'Rekeninghouder', bank: 'Bank', accountNumber: 'Rekeningnummer' },
}

const PAY_LABELS_EN: Record<string, string> = {
  accountName: 'Account name',
  bank: 'Bank',
  accountNumber: 'Account number',
}

function payLabel(key: string, locale: string): string {
  const primary = locale.split('-')[0]?.toLowerCase() ?? 'en'
  return PAY_LABELS[primary]?.[key] ?? PAY_LABELS_EN[key] ?? key
}

function rule(doc: PDFKit.PDFDocument, y: number, fromX = PAGE_MARGIN): void {
  doc
    .moveTo(fromX, y)
    .lineTo(PAGE_MARGIN + CONTENT_WIDTH, y)
    .lineWidth(0.5)
    .strokeColor(RULE)
    .stroke()
}
