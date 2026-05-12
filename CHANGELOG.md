# Changelog

All notable changes to Relay. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), semver.

## [Unreleased]

## [create-cumulus@0.3.1] — 2026-05-12

### Fixed

- Generated `full` and `inner` local Relay DB apps now support normal local
  Postgres URLs through `DATABASE_DRIVER` auto-detection instead of forcing Neon
  HTTP for `localhost` and `127.0.0.1`.
- Generated Cumulus DB config accepts narrow env objects, so local and both-mode
  template typechecks do not fail on missing `NODE_ENV`.
- Empty `LOG_LEVEL` values are treated as unset, and generated examples now
  default to `LOG_LEVEL=info`.
- Generated package installs pin safer transitive dependency versions and avoid
  the reported `workflow`, `undici`, `devalue`, `drizzle-kit`, and `esbuild`
  audit findings in representative installs.
- Generated Cumulus DB dashboards now cover health, MCP metadata, KV, events,
  token management, backup, compact, and compact record views.
- Generated dashboards include clearer token copy, a form-wrapped password
  field, `/favicon.ico`, and an HTML hydration warning guard.
- Generated license docs now explain why `full` and `inner` remain AGPL even
  when pointed at cloud Cumulus DB.

## [create-cumulus@0.3.0] — 2026-05-12

### Added

- `create-cumulus --cumulus-db cloud|local|both`.
- Cumulus DB support for generated `full`, `inner`, and `agent-auth`
  projects. They default to `both`.
- Local Cumulus DB template files under generated `apps/cumulus-db`, including
  the AGPL `LICENSE`, `NOTICE`, tests, and smoke script.
- Generated Cumulus DB scripts: `cumulus-db:build`, `cumulus-db:start`,
  `cumulus-db:test`, `cumulus-db:smoke`, and `cumulus-db:workspace`.
- Generated Cumulus DB UI at `/me/database` for `full` and `inner`, and
  `/database` for `agent-auth`.

### Changed

- Generated public app code talks to Cumulus DB over HTTP/token APIs only.
- `outer` defaults to hosted Cumulus DB and does not include local DB files
  unless explicitly requested.
- Generated projects that include local Cumulus DB default to AGPL-3.0-only.
  Small hosted `agent-auth --cumulus-db cloud` projects remain MIT.

## [0.3.0] — 2026-05-12

### Added

- Open-source release posture for the Relay server under AGPL-3.0-only.
- `create-cumulus` project creator with `full`, `outer`, `inner`, and
  `agent-auth` templates.
- Hosted and self-hosted agent-auth bootstrap modes in generated projects.
- Public self-hosting, commercial licensing, trademark, third-party notice, and
  contributor docs.

### Changed

- Public docs now explain hosted Relay vs self-hosted Relay without private
  launch notes.
- Generated Cumulus apps use clearer `outer` and `inner` template names while
  keeping `marketing` and `inside` as backwards-compatible aliases.
- Integration packages live under the Cumulus brand.

### Removed

- Internal launch notes, archived design plans, and stale release runbooks from
  the tracked public repository.

## [0.2.0] — 2026-05-03

Headline: **`POST /v1/intent`** — one round-trip from a natural-language goal to a paste-ready env block.

### Added — Intent resolver (the headline)

- **`POST /v1/intent`** — accepts a free-text goal (`"Postgres + transactional email for a Next.js app"`), parses it into canonical categories, dedups against existing accounts in the workspace, kicks signups for the gaps, and returns a deterministic `envBlock` plus `signup_job_ids` to poll. Always 200; partial success (some categories provisioning, some `no_provider`) is the expected shape.
- **`resolve_intent` MCP tool** — same surface as the REST endpoint, slimmed for LLM safety: drops `revealUrl` and `revealAllUrl` so agents can't speculatively rotate keys.
- **`POST /v1/accounts/keys/reveal-batch`** — companion endpoint for legacy reveals at scale; per-key results are independent so one bad id never aborts the batch.
- **Heuristic parser** (no LLM) — keyword map of ~70 phrases → canonical categories. Determinism is the product feature: same goal + same workspace = byte-identical response.
- **Provider selector** — within a category, deterministic tie-break by pricing (`free` → `free-tier` → `freemium` → `usage-based` → `paid`), then alphabetical.
- **Pin override** — `pin: [{ category, providerId, alias? }]` lets callers specify provider, or express multiple distinct accounts inside one category (e.g. primary + analytics Postgres).
- **Idempotency-Key** — responses cached for 24h per `(agent, key)` so retries after a 5xx never spawn duplicate signups.

### Changed — Signup pipeline

- **`Provider` interface** gained two optional fields:
  - `envVar?: string` — default env var name for the provider's primary credential. Built-ins populated: Neon → `DATABASE_URL`, Vercel → `VERCEL_TOKEN`, Resend → `RESEND_API_KEY`.
  - `defaultInputForIntent?(ctx)` — synthesises a sensible signup input from workspace + alias context so intent calls don't need per-provider arguments.
- **`accounts` table** gained an `alias` column with a partial unique index on `(user_workspace_id, provider_id, COALESCE(alias, ''))` — enables clean dedup and supports multiple accounts per provider via aliasing.
- **Signup workflow** is now race-safe: on a partial-unique-index violation it looks up the dedup winner, points the losing job at the existing account, and refunds the integrator quota slot — no zombie workflows.
- **`kickSignup()` extracted** from `routes/signups.ts` into `src/server/signups/kick.ts` so REST + MCP + intent share one signup-spawn primitive (abuse limits, integrator quota, audit, workflow start).

### Added — Inbound email pipeline (since 0.1.0)

- Replaced Cloudflare Email Routing + Email Worker with **SendGrid Inbound Parse**. MX records for `inbox.cumulush.com` now point at `mx.sendgrid.net`; inbound traffic lands as multipart/form-data at `POST /v1/webhooks/email?secret=$EMAIL_SENDGRID_SECRET`.
- **Env:** `EMAIL_WEBHOOK_SECRET` → `EMAIL_SENDGRID_SECRET` (rename). Outbound transactional email stays on Resend.
- **Docs:** `docs/inbound-email-worker.md` → `docs/inbound-email-setup.md` (fully rewritten).

### Added — Observability + tests

- `@sentry/node` + `instrumentation.ts` (no-op without `SENTRY_DSN`).
- `pino` structured logger + request-logging middleware in `src/server/app.ts`.
- **Vitest** test harness — **224 tests** at HEAD covering crypto, rate-limiting, billing, the new intent modules (parse / select / env-block / route), and live-DB smoke scripts (`scripts/smoke-intent*.ts`).
- Hot-path indexes on `signup_jobs(user_id, created_at DESC)`, `signup_jobs(status)`, `api_keys(account_id)`.
- `key_version` column on all encrypted-bytea tables — prep for `MASTER_KEY` rotation.

### Migration

- `0026_intent_dedup.sql` — adds `accounts.alias`, `signup_jobs.alias`, the partial unique index, and the `intent_resolutions` cache table. Idempotent (`IF NOT EXISTS` everywhere); apply with `npx tsx --env-file=.env scripts/apply-0026.ts`. Pre-flight backfill: `scripts/backfill-account-aliases.ts` stamps a unique alias on any pre-existing duplicate `(workspace, provider)` rows so the unique index can be created without data loss.

### Docs

- `app/docs/agent-builders/page.tsx` — new "One-shot resolver" section walking through `/v1/intent`: request shape, pinning, idempotency, billing rules, and the MCP equivalent.

## [0.1.0] — 2026-04-17

First release. Everything below is new.

### Product

- **Agent-driven signup API** — tenants register webhook URLs; AI agents call `/v1/signups` or the MCP `create_signup` tool to onboard users.
- **Agent-readable inboxes** — each user gets `<alias>@inbox.cumulush.com`; integrator verification emails land there and are readable via MCP `read_inbox`.
- **Email OTP + WebAuthn passkeys** — human sign-in.
- **Dashboard** — tenants, providers, agent tokens, inbox, audit log, passkey management.
- **Dogfood MCP tools** — `register_tenant`, `submit_verification_code`, `whoami` so new users can sign up entirely via their agent.
- **CLI** — `npx @cumulus/cli login/whoami/logout/init` with device-code browser handshake.

### Platform

- **Next.js 16** App Router with Tailwind v4 as the root framework.
- **Hono** mounted at `/v1/**`, `/mcp`, `/.well-known/workflow/*` via catch-all Route Handlers.
- **Neon Postgres** + **Drizzle ORM** — 15 tables, all encrypted columns via AES-256-GCM.
- **Workflow DevKit** — durable signup workflows with crash recovery + email verification suspend/resume.
- **MCP server** (`/mcp`) — 13 tools, stateless Streamable HTTP transport.
- **Vercel Cron** — daily GC of expired OTPs, WebAuthn challenges, sessions, CLI device codes, signup confirmations.

### Packages

- `@cumulus/server` — framework-agnostic webhook handler (zero deps beyond Web Crypto).
- `@cumulus/cli` — `login`, `whoami`, `logout`, `init`.

### Migrations

- `0000_empty_morgan_stark` — initial 6 tables (agents, accounts, signup_jobs, api_keys, email_messages, audit_log)
- `0001_cold_brood` — users, sessions, email_otps, passkeys, webauthn_challenges, tenants, tenant_members, tenant_providers; agents.user_id
- `0002_steady_martin_li` — signup_confirmations
- `0003_fair_quentin_quire` — users.inbox_alias, email_messages.user_id, tenant_providers.verification_mode
- `0004_tiny_silhouette` — cli_auth_codes

### Known gaps

- Initial Relay signup still requires a one-time 6-digit OTP to the user's real email. Downstream third-party signups are fully agent-automated via the inbox alias.
- `inbox.cumulush.com` MX records + SendGrid Inbound Parse configuration are a user operational setup; see [docs/inbound-email-setup.md](docs/inbound-email-setup.md).
- The hosted service still requires operator-managed email, billing, database,
  and cloud-provider accounts.
