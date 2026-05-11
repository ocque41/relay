# Self-Hosting Cumulus Relay

This guide is for teams that want to run the full Cumulus Relay control plane
themselves instead of using hosted Cumulus Cloud.

Self-hosting means you operate:

- the Next.js web app,
- the `/v1/*` REST API,
- the `/mcp` Streamable HTTP MCP endpoint,
- user/session/auth tables,
- tenant/product/provider tables,
- account and API-key bookkeeping,
- signup workflows,
- inbound email,
- optional billing,
- optional built-in provider credentials.

## Choose A Mode

| Mode | Use When |
| --- | --- |
| Hosted Cumulus Cloud | You want the fastest path and do not want to operate the control plane. |
| Self-hosted Cumulus Relay | You need ownership, customization, private infrastructure, or a fork. |

Hosted mode still lets your app own its own UI and product logic. Self-hosted
mode gives you the whole control plane.

## Requirements

- Node.js 24
- npm
- A deployed Postgres-compatible database URL supported by the configured
  Drizzle/Neon driver
- Public HTTPS URL for production
- Email provider for OTP and inbox features
- Optional Stripe account for billing
- Optional provider credentials for built-in providers

## Setup

```bash
git clone https://github.com/Cumulus-s/relay.git
cd relay
npm install
cp .env.example .env.local
```

Generate required secrets:

```bash
# MASTER_KEY: 32 bytes base64
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# SESSION_SECRET and webhook secrets
openssl rand -hex 32
```

Fill at minimum:

```bash
DATABASE_URL=
MASTER_KEY=
SESSION_SECRET=
APP_BASE_URL=http://localhost:3000
WEBAUTHN_RP_ID=localhost
WEBAUTHN_ORIGIN=http://localhost:3000
```

Apply migrations:

```bash
DATABASE_URL="$DATABASE_URL" npx tsx scripts/apply-pending-migrations.ts
```

Run locally:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Production Env

Required for the core app:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Primary database connection. |
| `MASTER_KEY` | AES-256-GCM encryption key for encrypted columns. |
| `SESSION_SECRET` | Session JWT signing secret. |
| `APP_BASE_URL` | Public base URL. |
| `WEBAUTHN_RP_ID` | Hostname for passkeys. |
| `WEBAUTHN_ORIGIN` | Allowed passkey origin. |

Email and inbox:

| Variable | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Outbound transactional email. |
| `RELAY_FROM_ADDRESS` | Verified sender address. |
| `EMAIL_SENDGRID_SECRET` | Shared secret for inbound email webhook. |
| `CATCHALL_DOMAIN` | Domain for agent inbox aliases. |

Billing:

| Variable | Purpose |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe API key. |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook verifier. |
| `STRIPE_PRICE_*` | Price IDs for plans and credits. |

Built-in providers:

| Variable | Purpose |
| --- | --- |
| `NEON_API_KEY` | Neon provider automation. |
| `VERCEL_API_TOKEN` | Vercel provider automation. |
| `RESEND_API_KEY` | Resend provider automation and outbound mail. |

Observability:

| Variable | Purpose |
| --- | --- |
| `SENTRY_DSN` | Error reporting. |
| `SENTRY_TRACES_SAMPLE_RATE` | Trace sample rate. |
| `LOG_LEVEL` | Pino log level. |

## Deployment

Vercel is the reference deployment target because this repository uses Next.js
and Vercel Workflow DevKit.

```bash
npm run typecheck
npm run test
npm run build
npx vercel deploy --prod
```

Other Node-compatible platforms can work, but you must verify support for:

- Next.js App Router route handlers,
- long-running or resumable workflow behavior,
- scheduled jobs,
- public HTTPS webhooks,
- the same environment variable set.

## First Production Checks

```bash
BASE=https://your-domain.example npx tsx scripts/smoke-prod.ts
curl https://your-domain.example/.well-known/relay.json
curl https://your-domain.example/openapi.json
```

Then verify:

- login,
- `/me`,
- `/dev`,
- product registration,
- agent token minting,
- MCP `/mcp`,
- signup workflow,
- inbound email,
- billing webhook if enabled.

## Hosted Cumulus Cloud

If operating all of this is not your goal, use hosted mode instead:

```bash
npx create-cumulus@latest my-app --template full --agent-auth hosted
```

Hosted mode keeps the generated app small and lets Cumulus operate the Relay
control plane.
