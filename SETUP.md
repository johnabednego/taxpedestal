# Running TaxPedestal locally

Two processes: the API (`server`) and the web app (`web`). Start the API first.

## 1. Prerequisites

- Node.js 20 or newer (`node -v`)
- A MongoDB database, either MongoDB Atlas, or local:
  ```bash
  docker run -d -p 27017:27017 --name taxpedestal-mongo mongo:7
  ```

## 2. Backend

```bash
cd server
npm install
cp .env.example .env
```

Open `.env` and replace every `REPLACE_ME`. The two required values are:

**MONGODB_URI**, your Atlas connection string, or `mongodb://127.0.0.1:27017/taxpedestal` locally.

**The two JWT secrets**, generate each separately:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```
Run it twice. They must differ; the server refuses to start in production if they match.

Everything else is optional. `EMAIL_PROVIDER=console` prints emails to the log, so the whole
app works end to end with no third-party credentials at all.

Then:
```bash
npm run seed    # demo workspace, clients and invoices across four tax regimes
npm run dev     # http://localhost:4000
```

Check it: `curl http://localhost:4000/api/v1/meta`

## 3. Frontend

In a second terminal:
```bash
cd web
npm install
cp .env.example .env    # default already points at localhost:4000
npm run dev             # http://localhost:5173
```

## 4. Sign in

| | |
|---|---|
| Demo user | `demo@taxpedestal.app` |
| Password | `taxpedestal-demo-2026` |

The platform admin is whatever you set as `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD`
before running the seed. Sign in as that user and the **Admin console** appears in the sidebar.

The seed prints public payment links. Open one in a private window to see the customer view, no login required.

## 5. Tests

```bash
cd server
npm test                # unit + HTTP smoke tests, no database needed

# Integration tests need a real MongoDB:
MONGODB_TEST_URI=mongodb://127.0.0.1:27017/taxpedestal-test npm run test:integration
```

The harness REFUSES to run against a database whose name does not contain `test`, because
teardown drops the database. Pointing it at your real `taxpedestal` database fails with an
explanatory error rather than destroying your data.

## 6. Payments (optional)

The app runs without payment credentials, manual payment recording still works, and every
payment goes through the same ledger.

To enable gateways, add keys to `server/.env`:

- **Stripe** (worldwide cards): `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`.
  Webhook endpoint: `POST {API_URL}/api/v1/webhooks/stripe`, subscribed to
  `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`.
  Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
  Locally: `stripe listen --forward-to localhost:4000/api/v1/webhooks/stripe`

- **Paystack** (African mobile money): `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`.
  Set the webhook URL in the Paystack dashboard to `{API_URL}/api/v1/webhooks/paystack`.
  No separate webhook secret. Paystack signs with your secret key.
  Locally you need a tunnel: `ngrok http 4000`

## 7. Deployment

**Frontend → Vercel.** Root directory `web`. Set `VITE_API_URL` to your Render URL.
`vercel.json` handles SPA routing so `/pay/<token>` links resolve.

**Backend → Render.** Import `render.yaml`, or create a Web Service with root directory
`server`, build `npm ci && npm run build`, start `node dist/index.js`, health check `/ready`.

After both are live, set on the API:
- `APP_URL` = your Vercel URL
- `CORS_ORIGINS` = the same Vercel URL (exact, no trailing slash)

If Atlas blocks Render, add `0.0.0.0/0` under Network Access. Render's free tier has no
static egress IPs.

## Troubleshooting

**`connect ECONNREFUSED 127.0.0.1:27017`**. MongoDB is not running. Start the Docker
container above, or point `MONGODB_URI` at Atlas.

**`Configuration is invalid`**, the server validates config at boot and lists exactly which
variables are wrong. Fix those and restart.

**CORS errors in the browser**, `CORS_ORIGINS` must match the frontend origin exactly.
`http://localhost:5173` and `http://localhost:5173/` are not the same.

**Webhooks return 400**, the signing secret is wrong, or a proxy is re-serialising the body.
Check the Admin console's webhook inspector: it records every event with the verification
result and the error.
