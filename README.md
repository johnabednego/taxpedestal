# TaxPedestal

Global invoicing and payment collection for freelancers, agencies and small
businesses. Send a compliant invoice to a customer in any of 53 tax
jurisdictions and get paid by card, wallet or mobile money.

**Status:** in development. See "Build progress" below.

---

## Why this exists

Cross-border invoicing breaks in two places that existing tools handle badly.

**Tax.** The correct amount depends on where both parties are, what is being
supplied, and whether the buyer is a registered business — not on a single rate.
A Berlin studio billing a Paris agency reverse-charges and must print an
Article 196 declaration; billing a Budapest consumer, the same studio owes
Hungarian VAT at 27% rather than German VAT at 19%. Goods shipped to Texas are
sourced to Texas. An Indian supply crossing a state line turns CGST + SGST into
a single IGST line. Rules also move: Ghana replaced its entire VAT computation
on 1 January 2026, so a back-dated invoice must use the law that applied on the
supply date. Most invoicing tools offer one "tax rate" field and leave the user
to be their own tax adviser.

**Collection.** Payment habits are local even when business is not. Stripe
settles cards and bank debits across most of the world but cannot process
African mobile money; Paystack covers mobile money but not most markets. A tool
that supports one rail silently excludes the other's customers.

TaxPedestal treats both as first-class architecture rather than configuration.

---

## Architecture

```
web/     React + Vite + TypeScript      -> Vercel
server/  Node + Express + Mongoose      -> Render (or Vercel serverless)
         MongoDB Atlas
```

### Two extension points carry the product

**Tax engine** (`server/src/services/tax/`) — a registry of `JurisdictionRule`
implementations. Each rule answers two questions: where is this supply taxed,
and what components apply. Adding a country means adding a rule and registering
it; `engine.ts` never changes. Rules are pure functions of their inputs, so the
entire tax surface is unit-testable without a database.

**Payment providers** (`server/src/services/payments/`) — a common interface over
Stripe, Paystack and manually recorded payments. The invoice domain never
imports a provider SDK.

### Decisions worth knowing before reading the code

| Decision | Reason |
|---|---|
| Money as integer minor units | IEEE-754 cannot represent 0.1. Float drift across line items produces off-by-a-cent invoices. |
| Amounts enter the API as integers or strings, never floats | `1.005 * 100 === 100.49999999999999`. Precision is lost at the literal, before any code runs. See `parseMoneyInput`. |
| Per-currency ISO 4217 exponents | JPY has 0 decimals, KWD has 3. Assuming "divide by 100" is the most common i18n billing bug. |
| Tax frozen onto the invoice at issue | Rates change. Recomputing on read silently rewrites invoices already sent and paid. |
| Tax computed per line, then aggregated | Invoice-subtotal-level computation is wrong the moment one invoice mixes rates. |
| Invoice numbers from an atomic counter | Count-and-increment duplicates under concurrency. Sequential numbering is a legal requirement in many jurisdictions. |
| Webhooks recorded before processing, unique on `(provider, eventId)` | Providers guarantee at-least-once delivery. A retried success event would otherwise credit an invoice twice. |
| Public invoice pages keyed by opaque high-entropy token | ObjectIds are enumerable. A guessable invoice URL exposes other customers' financial data. |
| Config validated at boot, process exits on failure | Converts a 3am production incident into a deploy-time error. |
| Refresh token rotation with reuse detection | A replayed token means two parties hold it; the whole family is revoked. |

---

## Local setup

```bash
# Backend
cd server
npm install
cp .env.example .env      # then replace every REPLACE_ME value
npm run seed              # creates the platform admin and demo data
npm run dev               # http://localhost:4000

# Frontend
cd ../web
npm install
cp .env.example .env
npm run dev               # http://localhost:5173
```

`.env.example` documents where each credential comes from. The email provider
defaults to `console`, so the app runs end to end with no mail credentials.

## Tests

```bash
cd server
npm test                  # unit + integration
npm run test:coverage     # thresholds enforced; tax engine held to 90%
```

Coverage thresholds are set per-directory, not globally: the tax engine and money
module are held to 90%+ because a silent error there is a compliance defect,
while glue code is held to a lower bar.

---

## Build progress

- [x] Money primitives — minor units, ISO 4217 exponents, lossless allocation
- [x] Tax engine — 53 jurisdictions, per-line assessment, reverse charge, OSS
- [x] Error taxonomy, structured logging, boot-time config validation
- [x] Data models — tenancy, RBAC, invoices, payments, webhook ledger, audit log
- [x] Auth — registration, login, refresh rotation, invitations
- [x] Invoice service — build, issue, state machine, PDF
- [x] Payments — Stripe + Paystack adapters, webhook handling
- [x] Analytics, reminders, admin console
- [x] Frontend — including team management and a fully translated interface
- [x] Deployment configuration
- [x] Examination documentation set

### Verification status

| Check | Result |
|---|---|
| Unit + HTTP contract tests | 207 passing |
| Integration tests (ledger, webhooks) | 34 passing |
| Total | **241 / 241** |
| TypeScript strict (server, web) | 0 errors |
| ESLint (server) | 0 errors |
| ESLint (web) | 0 errors, 8 `react-refresh` warnings |
| Interface languages | 15 registered, 5 at 100% |

The integration suite runs against `mongodb-memory-server` by default, so
`npm test` needs no external database. Point `MONGODB_TEST_URI` at a disposable
database to run against a real mongod instead.

## Licence

MIT. Third-party acknowledgements in `docs/ACKNOWLEDGEMENTS.md`.
