# Cumulus Relay

Cumulus Relay is an open-source agent signup and action stack. It gives AI
agents a safe way to discover products, authenticate users, create accounts,
read signup status, manage API keys, and call product actions.

You can use it in two ways:

- **Hosted Cumulus Cloud**: connect your generated app to the managed Cumulus
  API and let Cumulus run the Relay control plane.
- **Self-hosted Cumulus Relay**: clone this repository, bring your own
  database, email, billing, and provider credentials, and run the full API,
  MCP server, dashboards, workflows, and provider registry yourself.

The hosted path is the fastest route for most startups. The self-hosted path
is for teams that need ownership, customization, or private infrastructure.

## Create An App

```bash
npx create-cumulus@latest my-acme

# Equivalent npm create shorthand
npm create cumulus@latest my-acme
```

Templates:

| Template | Includes |
| --- | --- |
| `full` | Outer site, inner app, API, playground, and agent auth. |
| `outer` | Marketing/docs site plus discovery, signup, and action endpoints. |
| `inner` | Dashboard, `/me`, settings, API, playground, and agent auth. |
| `agent-auth` | Smallest Relay-compatible auth/signup/actions starter. |

Agent auth modes:

| Mode | Meaning |
| --- | --- |
| `hosted` | Generated app connects to hosted Cumulus Cloud. |
| `self-hosted` | Generated app includes a local Relay-style API/MCP starter. |

## What Is In This Repo

This repository is the full Cumulus Relay service:

- Next.js app router UI for public pages, `/me`, `/dev`, `/share`, docs, login,
  billing, products, settings, and security.
- Hono/OpenAPI REST API mounted under `/v1/*`.
- Streamable HTTP MCP server mounted at `/mcp`.
- Agent discovery documents at `/.well-known/relay.json`, `/AGENTS.md`,
  `/llms.txt`, and `/llms-full.txt`.
- User, session, passkey, email OTP, agent token, tenant, product, account,
  API key, action, audit, inbox, billing, and quota data models.
- Durable signup workflows using Vercel Workflow DevKit.
- Optional built-in providers for Neon, Vercel, and Resend.
- Tenant-defined product providers through HMAC webhooks.
- Creator package in `packages/create-cumulus`.
- MIT SDK/helper packages in `packages/*`.

## Local Development

Requirements:

- Node.js 24
- npm
- A Neon Postgres database URL or compatible deployed Postgres connection
- Optional provider credentials for Neon, Vercel, Resend, Stripe, SendGrid, and
  Sentry depending on which features you enable

```bash
git clone https://github.com/Cumulus-s/relay.git
cd relay
npm install

cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

Useful checks:

```bash
npm run typecheck
npm run test
npm run build
```

Apply database migrations:

```bash
DATABASE_URL="postgres://..." npx tsx scripts/apply-pending-migrations.ts
```

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
openssl rand -hex 32
```

## Self-Hosting

Start with [SELF_HOSTING.md](SELF_HOSTING.md).

The short version:

1. Provision a database and set `DATABASE_URL`.
2. Generate `MASTER_KEY` and `SESSION_SECRET`.
3. Configure email if you want login, inbox, and verification flows.
4. Configure Stripe if you want billing.
5. Configure provider credentials only for providers you operate.
6. Apply migrations.
7. Deploy the Next.js app to Vercel or another Node-compatible platform.

Self-hosted Cumulus Relay is AGPL-licensed. If you run a modified network
service, you must comply with the AGPL network-source requirements. Commercial
licenses are available for private modifications.

## Hosted API

Hosted Cumulus Cloud runs the Relay control plane for you. Generated apps can
use hosted mode and keep only app-specific endpoints locally:

- `/.well-known/relay.json`
- `/api/relay-login`
- `/api/agent-signup`
- `/api/actions`

This is the best default when you want agent authentication, signup dispatch,
action dispatch, hosted inboxes, provider catalog, and ongoing upgrades without
operating the control plane.

## Provider Model

Cumulus Relay supports two provider shapes:

- **Built-in providers** are operated by the Relay host. They use host-owned
  credentials for services such as Neon, Vercel, and Resend.
- **Tenant providers** are products registered by developers. Relay sends
  HMAC-signed signup and action webhooks to the developer's backend.

For most startups building on Cumulus, tenant providers are the normal path.
Built-ins are useful for demos, internal automation, and hosted cloud products
where the Relay operator owns the underlying infrastructure.

## Packages

```text
packages/
├── create-cumulus/  create-cumulus npm creator package
├── server-sdk/      framework-agnostic webhook helper
├── cli/             relay CLI source
└── track-sdk/       activation tracking helper
```

The creator package and SDK/helper packages are MIT-licensed through their own
package-level license files.

## License

- Full Cumulus Relay app and server: **GNU AGPLv3**. See [LICENSE](LICENSE).
- Creator, templates, SDK helpers, and examples where separately marked:
  **MIT**.
- Cumulus and Relay names, marks, and logos are governed by
  [TRADEMARKS.md](TRADEMARKS.md).
- Commercial licensing is available. See [COMMERCIAL.md](COMMERCIAL.md).

## Security

Report vulnerabilities privately. See [SECURITY.md](SECURITY.md).
