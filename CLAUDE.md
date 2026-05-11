# CLAUDE.md

Guidance for AI coding agents working in this repository.

## Project

Cumulus Relay is an open-source agent signup and action control plane. It can
run as hosted Cumulus Cloud or as a self-hosted service. The repo includes:

- Next.js App Router UI,
- Hono/OpenAPI REST API under `/v1/*`,
- Streamable HTTP MCP server at `/mcp`,
- user and tenant workspaces,
- agent token auth,
- passkey and email OTP login,
- provider registry,
- tenant-provider HMAC dispatch,
- durable signup workflows,
- account/API-key bookkeeping,
- Stripe billing hooks,
- creator and SDK/helper packages.

## Documentation Policy

This repository is public. Documentation must be useful to outside users,
self-hosters, contributors, and AI agents.

Keep docs in sync with code:

- Public product docs live in `app/docs/**`.
- Contributor and operator docs live in `README.md`, `SELF_HOSTING.md`,
  `CONTRIBUTING.md`, `SECURITY.md`, and `docs/**`.
- Avoid private notes, personal paths, stale planning artifacts, credentials,
  customer-specific runbooks, and unpublished strategy in committed files.
- Use placeholders for secrets and production-only values.
- If a doc describes a route, schema, package, or env var, keep names exact.

## Commands

```bash
npm install
npm run dev
npm run typecheck
npm run test
npm run build
```

Database:

```bash
npx drizzle-kit generate
DATABASE_URL="postgres://..." npx tsx scripts/apply-pending-migrations.ts
```

Creator package:

```bash
npm run create-cumulus:typecheck
npm run create-cumulus:test
npm run create-cumulus:build
```

## Architecture

### App Surface

- `app/` contains public pages, auth, `/me`, `/dev`, `/share`, docs, and route
  handlers.
- `app/v1/[[...path]]/route.ts` mounts the Hono API.
- `app/mcp/route.ts` mounts the MCP server.
- `app/.well-known/*` exposes agent discovery and JWKS documents.

### Server Surface

- `src/server/app.ts` creates the OpenAPIHono app.
- `src/server/routes/*` contains REST route groups.
- `src/mcp/server.ts` contains MCP tools.
- `src/server/db/schema.ts` defines Drizzle tables.
- `src/server/providers/*` contains provider registry logic.
- `workflows/signup.ts` contains the durable signup workflow.

### Auth Model

- Session cookies protect user and developer workspaces.
- Bearer agent tokens protect agent REST and MCP flows.
- Agent token plaintext is shown once and stored only as a hash.
- Attestation JWTs support drop-in agent login for generated apps.

### Provider Model

- Built-in providers use operator-owned credentials and are optional.
- Tenant providers are registered products that receive HMAC-signed webhooks.
- Agents discover providers through `/v1/providers`, `/v1/index`, and MCP.

## Engineering Rules

- Keep changes scoped and coherent.
- Do not commit secrets, generated `.env` files, local machine paths, or private
  release notes.
- Preserve self-hostability when adding hosted-cloud features.
- Add or update tests for shared auth, billing, provider, and API behavior.
- Run typecheck, tests, and build before release commits.

## Release Checklist

1. `npm run typecheck`
2. `npm run test`
3. `npm run build`
4. Creator package checks if `packages/create-cumulus` changed
5. Secret scan for tracked files and staged diff
6. Self-host docs updated when env, migrations, providers, or deployment change
