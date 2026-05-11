/**
 * Single source of truth for /AGENTS.md, /CLAUDE.md, /llms.txt, /llms-full.txt.
 *
 * A cold AI agent given only a bearer token and `APP_BASE_URL` should be able
 * to GET any of these four documents, skim the result, and make a successful
 * end-to-end call — signup → poll → rotate key — using nothing else.
 *
 * Keep every example `curl`-executable and pinned to `{{BASE}}` placeholder so
 * the rendered body substitutes the deployed base URL at request time.
 */

export interface ManifestContext {
  baseUrl: string;
  /** When set, appended to /AGENTS.md to point the agent at their per-user guide. */
  authenticatedUserGuideHint?: { updatedAt: string | null };
}

function substitute(template: string, baseUrl: string): string {
  return template.replaceAll('{{BASE}}', baseUrl);
}

// ---------------------------------------------------------------------------
// Canonical body. Markdown in, markdown out. Tool-layer decides whether to
// serve as text/markdown or text/plain.
// ---------------------------------------------------------------------------
const BODY_TEMPLATE = `# Relay — AI Agent Operating Guide

> Zero-retention third-party signup API. Agents call Relay, Relay calls the
> provider (Neon, Vercel, Resend, or a tenant-defined integrator), and the
> resulting API key is returned to the agent **exactly once**. Relay never
> persists the key bytes.

Base URL: \`{{BASE}}\`

## Authentication

Every authenticated endpoint requires:

\`\`\`
Authorization: Bearer agt_<base64url>
\`\`\`

Agent tokens are SHA-256 hashed server-side — the plaintext is shown once at
mint time and never again. Tokens are scoped to a single Relay user and
cannot be used against other websites.

Discover the canonical base URL and MCP endpoint at \`GET /.well-known/relay.json\`
(unauthenticated).

## Read-only discovery (no auth)

| Method | Path | Purpose |
|---|---|---|
| GET | \`/health\` | Liveness probe. Returns \`{ status: "ok", version }\`. |
| GET | \`/openapi.json\` | Full OpenAPI 3.1 spec. Every route below is covered. |
| GET | \`/docs/api\` | Swagger UI rendering of the spec. |
| GET | \`/.well-known/relay.json\` | API base, MCP endpoint, docs links. |
| GET | \`/AGENTS.md\` | This file. |
| GET | \`/CLAUDE.md\` | Alias of /AGENTS.md. |
| GET | \`/llms.txt\` | Short llmstxt.org index. |
| GET | \`/llms-full.txt\` | Full agent guide as plain text. |

## Canonical tasks

### 1. List available providers

\`\`\`
GET {{BASE}}/v1/providers
Authorization: Bearer $TOKEN
\`\`\`

The response distinguishes two kinds of providers via \`kind\`:

- \`kind: "builtin"\` — **Operator self-service.** Relay creates a sub-resource
  inside the operator's own third-party account (e.g. a new Neon project, a
  new Vercel project, a new Resend API key). Authenticates with operator-wide
  env secrets. The resulting API key lets the caller call the provider as the
  **operator's** account, not as a new end-user account on the provider's
  website.
- \`kind: "tenant"\` — **Real end-user signup.** A tenant has registered an
  integrator webhook (\`POST /v1/me/tenants/:id/providers\`). Relay
  HMAC-dispatches the signup to the tenant's backend, which creates a genuine
  independent account in the tenant's product.

Pick the shape that matches your goal: provisioning a sub-resource in the
operator's account vs. signing up a real end-user on an integrator's site.

### 2. Sign up on a provider

\`\`\`
POST {{BASE}}/v1/signups
Authorization: Bearer $TOKEN
Content-Type: application/json

{
  "provider": "cumulus-database",
  "input": {
    "email": "user@example.com",
    "purpose": "project memory"
  }
}
\`\`\`

Response includes a \`signupJobId\`. Poll until terminal:

\`\`\`
GET {{BASE}}/v1/signups/$SIGNUP_JOB_ID
\`\`\`

Statuses: \`pending\`, \`awaiting_email\`, \`complete\`, \`failed\`. When
\`complete\`, the response carries either \`initial_api_key\` for legacy
single-key providers or \`initial_credentials\` for structured handoffs such as
endpoint + database id + data token + admin token. The value is returned
**exactly once** — hand it to the end user in chat, wire \`data_token\` into
the app, and treat \`admin_token\` as a one-time administrative secret.

### 3. Rotate an API key (= the "retrieve my key" operation)

Relay does NOT persist key bytes, so there is no "show me my key again"
endpoint. Losing the plaintext = rotate.

\`\`\`
POST {{BASE}}/v1/me/accounts/$ACCOUNT_ID/api-keys/$KEY_ID/rotate
Cookie: relay_session=<user session>
\`\`\`

(The session-auth variant above is the dashboard path. For the agent-auth
variant, mint a new additional key with \`POST /v1/accounts/$ACCOUNT_ID/api-keys\`
and revoke the old row manually if you want strict rotation.)

### 4. Read the calling user's agent guide

Every Relay user has a free-form markdown "agent guide" that their agents
should read at session start. It carries preferences, defaults, and
long-running context the user wants you to apply.

\`\`\`
GET {{BASE}}/v1/agent-guide
Authorization: Bearer $TOKEN
\`\`\`

Response: \`{ content, updated_at, bytes }\`. When empty, the user has not
written a guide yet.

### 5. Update the agent guide (convention: user approves first)

\`\`\`
PUT {{BASE}}/v1/agent-guide
Authorization: Bearer $TOKEN
Content-Type: application/json

{ "content": "# My guide\\n..." }
\`\`\`

Max body is 64 KiB; larger bodies return 413. Last write wins — there is no
versioning in v1. Convention (not enforced): propose the edit in chat, wait
for the user to say yes, then PUT.

## MCP endpoint

Streamable HTTP transport: \`{{BASE}}/mcp\`. Auth lives at the tool layer —
every tool takes an \`agent_token\` argument (there is no HTTP-level bearer
gate on /mcp). Tools exposed:

- \`list_providers\`
- \`create_signup\`
- \`get_signup_status\`
- \`list_accounts\`
- \`get_api_key\` / \`reveal_api_key\`
- \`delete_account\`
- \`read_agent_guide\`
- \`update_agent_guide\`

## Error shapes

- \`401 { error }\` — token missing/revoked/not a user token.
- \`402 { error }\` — billing gate refused. Tenant subscription inactive.
- \`404 { error }\` — not owned by the caller, or does not exist. These are
  intentionally indistinguishable to avoid resource-existence oracles.
- \`410 { error }\` — legacy key bytes scrubbed; rotate instead.
- \`413 { error }\` — request body exceeds a size cap (agent guide = 64 KiB).
- \`429 { error, retryAfter }\` — per-token rate limit (60 writes/min, 300
  reads/min).

## Zero-retention recap

| What happens | Where it lives |
|---|---|
| Agent token plaintext | SHA-256 hashed — bytes never stored. |
| Account credentials | AES-256-GCM in \`accounts.credentials_enc\`. |
| API key bytes (new) | Not stored. Returned once and then forgotten. |
| API key bookkeeping | label + \`provider_key_id\` in \`api_keys\`. |
| \`last_used_at\` | Bumped by Relay-observable touches (mint, delivery, reveal, rotation). |

If you lose an API key, rotate. If you lose your agent token, mint a new one
from the dashboard or \`POST /v1/me/agent-tokens\`.

## Getting help

- Human docs: \`{{BASE}}/docs\`
- API reference: \`{{BASE}}/docs/api\`
- Source + issues: https://github.com/ocque41/api
`;

// ---------------------------------------------------------------------------
// Short llms.txt (per llmstxt.org). Title, blurb, links.
// ---------------------------------------------------------------------------
const LLMS_TXT_TEMPLATE = `# Relay

Zero-retention agent-callable signup API. AI agents call Relay to provision
accounts on third-party services and receive API keys returned exactly once.

## Primary resources

- [Agent guide (markdown)]({{BASE}}/AGENTS.md)
- [Agent guide (plain text)]({{BASE}}/llms-full.txt)
- [OpenAPI spec]({{BASE}}/openapi.json)
- [Swagger UI]({{BASE}}/docs/api)
- [MCP endpoint]({{BASE}}/mcp)
- [Discovery]({{BASE}}/.well-known/relay.json)

## Conventions

- Auth: \`Authorization: Bearer agt_<base64url>\`.
- API keys are returned exactly once at mint time. Rotation is the recovery path.
- Per-user agent memory: \`GET /v1/agent-guide\` (bearer) / \`GET /v1/me/agent-guide\` (session).
`;

export function renderAgentsMarkdown(ctx: ManifestContext): string {
  const body = substitute(BODY_TEMPLATE, ctx.baseUrl);
  if (ctx.authenticatedUserGuideHint) {
    const updated = ctx.authenticatedUserGuideHint.updatedAt ?? 'never set';
    return (
      body +
      `\n---\n\n*This session is authenticated. Your agent guide was last updated: \`${updated}\`. Fetch it at \`GET ${ctx.baseUrl}/v1/agent-guide\`.*\n`
    );
  }
  return (
    body +
    `\n---\n\n*Unauthenticated fetch — sign in (or present a bearer token) to receive your per-user agent guide via \`GET ${ctx.baseUrl}/v1/agent-guide\`.*\n`
  );
}

export function renderLlmsTxt(ctx: ManifestContext): string {
  return substitute(LLMS_TXT_TEMPLATE, ctx.baseUrl);
}

export function renderLlmsFullTxt(ctx: ManifestContext): string {
  return renderAgentsMarkdown(ctx);
}
