# Deploying the API to Vercel

The web client is already deployed. This covers the API as a **second Vercel
project** pointed at the same repository, with `server` as its root directory.

---

## The entry point, and why `app.ts` was renamed

Vercel treats Express as a first-class framework and finds the entry point by
filename, **in this order**, relative to the project's root directory:

```
app.*  →  index.*  →  server.*  →  src/app.*  →  src/index.*  →  src/server.*
```

The order is the trap. This project used to have both `src/app.ts` (a factory
exporting `createApp`) and `src/index.ts` (the real entry point). `src/app.ts`
outranks `src/index.ts`, so Vercel selected the factory, found no default
export, and every request died with:

```
Invalid export found in module "/var/task/server/src/app.js".
The default export must be a function or server.
FUNCTION_INVOCATION_FAILED
```

The factory is now `src/create-app.ts`, which matches no detection pattern, so
`src/index.ts` is the only candidate. Adding a default export to the factory
instead would have been worse: importing it would construct an application, and
`index.ts` (the module that connects the database) would never run.

**Do not rename `create-app.ts` back to `app.ts`.**

`api/index.ts` is not on the list at all. It is the older "one function per
file" convention, and using it here would be actively worse for this project. See "Webhooks" below.

`app.listen()` is supported and expected. Vercel captures the server the call
creates; the port is how the platform finds the app, not a public port.
`index.ts` also carries `export default app`, so either detection path works.

## The second rule: the entry must import `express` itself

Renaming alone was not enough. Vercel then rejected the file it had just found:

```
No entrypoint found which imports express. Found possible entrypoint: src/index.ts
```

The detector requires the entry module to import the `express` **package
directly**. Importing a factory that imports express does not count.

Rather than carry a decorative `import express` that a future cleanup would
delete, the `express()` call was moved into the entry point and the
configuration split out:

```ts
// src/index.ts owns the instance
import express from 'express'
import { configureApp } from './create-app'
const app = configureApp(express())

// src/create-app.ts applies middleware and routes to an instance
export function configureApp(app: Express): Express { /* … */ return app }
export function createApp(): Express { return configureApp(express()) }   // tests
```

`createApp()` still exists, so the test suite is unchanged.

### Verifying before you push

From `server/`, all four must hold:

```bash
# 1. Exactly one detection candidate
for f in app.ts index.ts server.ts src/app.ts src/index.ts src/server.ts; do
  [ -f "$f" ] && echo "MATCH: $f"
done

# 2. That file imports express directly
grep -n "^import express from 'express'" src/index.ts

# 3. It exports a default AND binds a listener
grep -n "^export default app" src/index.ts
grep -n "app.listen" src/index.ts
```

---

## Project settings

| Setting | Value |
|---|---|
| Repository | `johnabednego/taxpedestal` |
| **Root Directory** | **`server`** |
| Framework Preset | Express (auto-detected) |
| Build Command | *leave default* |
| Output Directory | *leave empty* |
| Install Command | *leave default* |
| Node.js Version | from `engines.node` (`22.x`) |

The root directory is the part most guides get wrong for this repo: `server`
and `web` are siblings, so `.` would point Vercel at the monorepo root, where
there is no Express app.

Do **not** set a build command. `npm run build` emits `dist/` for the Render
deployment; Vercel compiles the TypeScript entry point itself, and pointing it
at `dist/` only adds a way for the two to disagree.

---

## Environment variables

Set these under **Settings → Environment Variables → Production**.

**Required**

```
NODE_ENV=production
MONGODB_URI=<your Atlas connection string, including the /meridian database name>
JWT_ACCESS_SECRET=<48 random bytes, base64url>
JWT_REFRESH_SECRET=<a DIFFERENT 48 random bytes>
APP_URL=https://taxpedestal.vercel.app
API_URL=https://<this-project>.vercel.app
CORS_ORIGINS=https://taxpedestal.vercel.app
ENABLE_SCHEDULER=false
CRON_SECRET=<32+ random characters>
```

Generate each secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

**Deliberately omitted**

- `PORT`. The platform assigns it; the schema defaults to 4000 locally.

**Notes that matter**

- `ENABLE_SCHEDULER=false` is not optional. An in-process cron inside a
  function instance either never fires or fires once per cold start.
- `CORS_ORIGINS` is an exact-match allow-list: no trailing slash, no wildcard.
  A preview deployment on a different URL will be refused unless added.
- `MONGODB_URI` must contain the database name. Without it the driver picks its
  default, and the app silently reads an empty database.
- Atlas **Network Access** must allow `0.0.0.0/0`. Vercel's egress addresses
  are not stable.

---

## Scheduled jobs

The four jobs that ran in-process on a long-lived server are now HTTP
endpoints, registered in `server/vercel.json` and guarded by `CRON_SECRET`:

| Job | What it does |
|---|---|
| `reconcile-payments` | Settles payments whose webhook never arrived |
| `mark-overdue` | Moves past-due invoices to `OVERDUE` |
| `reminders` | Sends the reminder sweep |
| `reconcile-balances` | Audits cached balances against the ledger |

Vercel sends `Authorization: Bearer $CRON_SECRET`. Without a matching secret
the routes return **404** rather than 401. An unauthenticated endpoint that
settles payments is not something to advertise.

### Frequency is a real trade-off on Hobby

Hobby accounts allow **one run per day per cron**, with ±59 minutes of
scheduling slack. A more frequent expression **fails at deploy time**, so the
committed schedules are all daily.

The cost is concrete: `reconcile-payments` is the safety net for a payment that
succeeded at the provider while its webhook was lost. On a long-lived server it
ran every 10 minutes; daily, that gap is up to a day. Three mitigations:

1. Webhooks remain the primary path. Reconciliation is the fallback, not the
   mechanism.
2. An admin can run it on demand from the admin console at any time.
3. On **Pro**, restore the original cadence in `server/vercel.json`:

```json
{ "path": "/api/v1/cron/reconcile-payments", "schedule": "*/10 * * * *" },
{ "path": "/api/v1/cron/mark-overdue",       "schedule": "7 * * * *"    }
```

If that gap is unacceptable and Pro is not an option, keep the API on Render. `render.yaml` still provisions it, and the in-process
scheduler works there.

---

## Webhooks: the reason the entry point matters

Signature verification hashes the exact bytes the provider sent, so
`webhook.routes.ts` uses `express.raw()` and is mounted before
`express.json()`.

An `/api/*` function handler would put that at risk: Vercel adds a `request.body`
helper there that parses `application/json` into an object. A captured Node
server gets **plain `IncomingMessage`/`ServerResponse` with no such helpers**,
so the raw stream reaches `express.raw()` untouched. That is a documented
difference between the two shapes, and it is the main reason this deployment
uses the `src/index.ts` entry point.

Verify after deploying rather than assuming. A broken signature check still
returns 200 to the provider while crediting nothing:

1. Point the Stripe webhook at `https://<api>/api/v1/webhooks/stripe` and send a
   test `payment_intent.succeeded`.
2. Sign in as the platform administrator and open the **webhook inspector**.
3. The event must read `PROCESSED` with a valid signature. `Bad signature` on a
   correctly configured secret means the raw body is being altered in transit.

Set `STRIPE_WEBHOOK_SECRET` from the Stripe dashboard once the endpoint exists.
Paystack signs with the secret key, so it needs no separate value.

---

## After the API is live

1. **Point the web client at it.** In the *web* Vercel project set
   `VITE_API_URL=https://<api>.vercel.app` and redeploy. `VITE_*` values are
   baked in at build time, so an environment change alone does nothing.
2. **Seed the database**, once, from your machine:
   ```bash
   cd server && MONGODB_URI="<production uri>" npm run seed
   ```
3. **Check readiness:** `https://<api>.vercel.app/ready` must return 200 with
   `"database":"connected"`. `/health` answers without touching the database,
   so a 200 there with a 503 on `/ready` means the app is up but Atlas is not
   reachable, almost always the IP allow-list.
4. **Confirm the session survives a reload.** The refresh token is an httpOnly
   cookie sent cross-site between two different `vercel.app` hosts, which
   requires `SameSite=None; Secure`. The code already sets both when
   `NODE_ENV=production`, if sign-in works but a refresh logs you out, that
   variable is missing.

---

## Known limits of this deployment

- **Rate limiting is per instance** (TD-04). Serverless multiplies instances,
  so the effective limit is higher than configured. A shared Redis store is the
  fix; the limiter is already centralised in one module.
- **Cron precision is ±59 minutes** on Hobby.
- **Cold starts** add latency to the first request after idle, and the database
  connection is established alongside the listener rather than before it.
  Mongoose buffers queries until the connection is ready, so requests wait
  rather than fail.
