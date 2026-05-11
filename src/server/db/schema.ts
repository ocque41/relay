import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  boolean,
  date,
  index,
  primaryKey,
  uniqueIndex,
  customType,
} from 'drizzle-orm/pg-core';

// Postgres bytea type (not built-in in drizzle-orm 0.45.x).
// toDriver: encode Buffer as PostgreSQL hex literal (\x...) for the HTTP driver.
// fromDriver: accept both Buffer (direct connections) and \x-prefixed hex strings
// returned by the Neon HTTP / serverless drivers.
const bytea = customType<{ data: Buffer; driverData: string; notNull: false; default: false }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value: Buffer): string {
    return '\\x' + value.toString('hex');
  },
  fromDriver(value: unknown): Buffer {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof value === 'string') {
      // PostgreSQL hex format returned by most drivers: \x<hex>
      if (value.startsWith('\\x')) return Buffer.from(value.slice(2), 'hex');
      // Fallback: assume raw binary string
      return Buffer.from(value, 'binary');
    }
    throw new Error(`[bytea] Cannot convert ${typeof value} to Buffer`);
  },
});

// ---------------------------------------------------------------------------
// users — human accounts that own tenants and mint agent tokens
// ---------------------------------------------------------------------------
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').unique().notNull(),
  name: text('name'),
  // Persistent per-user inbox alias used when agents do third-party
  // signups on the user's behalf. Format: "<word>-<hex4>" (e.g. "alice-7f3b").
  // Full address = `${inbox_alias}@${CATCHALL_DOMAIN}`. Nullable so existing rows
  // can be backfilled; new users get one assigned at creation.
  //
  // Migration 0021: `user_workspaces.inbox_alias` is now the source of truth
  // for inbox routing. This column is kept populated for backward compat with
  // any unmigrated reader and mirrors the user's *default* workspace alias.
  inbox_alias: text('inbox_alias').unique(),
  // Abuse prevention: raise the per-month signup cap for a vetted
  // power-user. NULL means "use USER_SIGNUP_MONTHLY_LIMIT env default".
  signup_limit_override: integer('signup_limit_override'),
  // Mirror for the per-month action cap (covers reveal/revoke/delete in
  // addition to signups). NULL means "use USER_ACTION_MONTHLY_LIMIT env
  // default".
  action_limit_override: integer('action_limit_override'),
  // Per-user agent memory: free-form markdown the user's AI agents read at the
  // start of every session. Editable from the dashboard and via /v1/agent-guide
  // (bearer) or /v1/me/agent-guide (session). Capped at 64 KiB in the route layer.
  agent_guide: text('agent_guide'),
  agent_guide_updated_at: timestamp('agent_guide_updated_at', { withTimezone: true }),
  // Migration 0021: currently-selected personal workspace. Session shape is
  // unchanged — which user workspace is "active" is derived per-request from
  // this column. Null means "fall back to the user's is_default row".
  active_user_workspace_id: uuid('active_user_workspace_id'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  last_login_at: timestamp('last_login_at', { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// user_workspaces — per-user personal workspaces.
//
// One row per workspace. Each user gets one "Default" workspace on account
// creation (and via migration 0021 backfill for existing users). Additional
// workspaces are created on demand and can be deleted, except the default.
//
// Isolation guarantees:
//   - Each workspace owns its own `inbox_alias` so verification emails
//     never cross workspaces.
//   - User-scoped agent tokens carry `agents.user_workspace_id` so a token
//     minted in workspace A cannot read workspace B's data.
//   - Every user-scoped row (accounts, signup_jobs, email_messages,
//     magic_links, audit_log) carries `user_workspace_id` and every /me
//     query filters by it.
// ---------------------------------------------------------------------------
export const user_workspaces = pgTable(
  'user_workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    is_default: boolean('is_default').notNull().default(false),
    inbox_alias: text('inbox_alias').unique(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Slug is unique per user, not globally — two users can both own "default".
    uniqueIndex('user_workspaces_user_slug_key').on(t.user_id, t.slug),
  ],
);

// ---------------------------------------------------------------------------
// user_signup_counts — per-user monthly signup counter.
//
// Abuse prevention: cap one user's calendar-month signup count. `period_ym`
// is ISO 'YYYY-MM'; rollover is a new row inserted on next signup.
// ---------------------------------------------------------------------------
export const user_signup_counts = pgTable(
  'user_signup_counts',
  {
    user_id: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    period_ym: text('period_ym').notNull(),
    count: integer('count').notNull().default(0),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.period_ym] })],
);

// ---------------------------------------------------------------------------
// user_action_counts — per-user monthly action counter (mirror of
// user_signup_counts). Tracks all billable actions: signup + reveal +
// revoke + delete. period_ym is ISO 'YYYY-MM'.
// ---------------------------------------------------------------------------
export const user_action_counts = pgTable(
  'user_action_counts',
  {
    user_id: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    period_ym: text('period_ym').notNull(),
    count: integer('count').notNull().default(0),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.period_ym] })],
);

// ---------------------------------------------------------------------------
// user_provider_action_days — fairness debounce for key-lifecycle actions.
//
// One row per (end-user, integrator-tenant, provider, UTC day). The first
// debounceable action (mint / reveal / rotate / revoke) of the day inserts
// the row and bills 1 integrator action; subsequent same-day, same-triple
// actions bump action_count but skip the integrator-quota debit. Signups
// and deletes never touch this table — they always bill.
// ---------------------------------------------------------------------------
export const user_provider_action_days = pgTable(
  'user_provider_action_days',
  {
    user_id: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' })
      .notNull(),
    provider_id: text('provider_id').notNull(),
    ymd_utc: date('ymd_utc').notNull(),
    first_action_at: timestamp('first_action_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    action_count: integer('action_count').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.tenant_id, t.provider_id, t.ymd_utc] }),
    index('idx_upad_tenant_ymd').on(t.tenant_id, t.ymd_utc),
    index('idx_upad_ymd').on(t.ymd_utc),
  ],
);

// ---------------------------------------------------------------------------
// sessions — server-side session records for signed JWT cookies
// ---------------------------------------------------------------------------
export const sessions = pgTable('sessions', {
  jti: text('jti').primaryKey(),
  user_id: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  ip: text('ip'),
  user_agent: text('user_agent'),
  // Active workspace for this session:
  //   { kind: 'user' }                           → end-user workspace (default)
  //   { kind: 'tenant', tenantId: '<uuid>' }    → developer workspace for that tenant
  // Null is interpreted as { kind: 'user' }. Changed via POST /v1/session/workspace.
  active_workspace: jsonb('active_workspace'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// email_otps — short-lived 6-digit codes for passwordless email login
// ---------------------------------------------------------------------------
export const email_otps = pgTable('email_otps', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  code_hash: text('code_hash').notNull(),
  purpose: text('purpose').notNull().default('login'), // login | signup
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  used_at: timestamp('used_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// passkeys — registered WebAuthn credentials
// ---------------------------------------------------------------------------
export const passkeys = pgTable('passkeys', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  credential_id: bytea('credential_id').notNull(),
  public_key: bytea('public_key').notNull(),
  counter: integer('counter').notNull().default(0),
  transports: jsonb('transports').notNull().default([]),
  name: text('name'),
  last_used_at: timestamp('last_used_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// webauthn_challenges — ephemeral challenges issued during register/login
// ---------------------------------------------------------------------------
export const webauthn_challenges = pgTable('webauthn_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  subject: text('subject').notNull(), // email for login, user_id for register
  challenge: bytea('challenge').notNull(),
  purpose: text('purpose').notNull(), // register | login
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// tenants — integrator organizations
// ---------------------------------------------------------------------------
// Drop-in API additions:
//   `domain`           — the integrator's public hostname (e.g. "myapp.com").
//                        Nullable so legacy tenants without a known domain keep
//                        working. Unique where set so two tenants can't claim
//                        the same hostname in `.well-known/relay.json` lookups.
//   `rp_id`            — WebAuthn Relying-Party ID the tenant uses. Reserved
//                        for when we later expose passkey primitives through
//                        the integrator API; set now so tenants can configure
//                        it while the feature ships.
//   `allowed_origins`  — CORS allowlist for browser-side calls that present
//                        this tenant's integrator key.
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner_user_id: uuid('owner_user_id')
    .references(() => users.id, { onDelete: 'restrict' })
    .notNull(),
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  domain: text('domain').unique(),
  rp_id: text('rp_id'),
  allowed_origins: jsonb('allowed_origins').notNull().default([]),
  // Operator kill switch — non-null pauses all billable operations for
  // this tenant (charge middleware short-circuits to 503). Used to
  // contain runaway abuse without touching the Stripe subscription.
  paused_at: timestamp('paused_at', { withTimezone: true }),
  // Migration 0027: founding-partner sprint funnel state.
  //   NULL          — never engaged (or pre-pivot legacy tenant)
  //   'sprint_paid' — checkout.session.completed for the sprint SKU
  //   'renewed'     — month-to-month subscription started after sprint
  //   'lapsed'      — sprint ended without renewal
  // Operator-driven; not exposed to public catalog. The Stripe webhook
  // flips NULL → 'sprint_paid' on session metadata { product: 'founding_partner_sprint' }.
  partnership_status: text('partnership_status'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// user_external_identities — joins one Relay user to the "local" user ID an
// integrator uses in its own database. Populated the first time an agent
// attests for a tenant (Flow 2) or an integrator calls a server-to-server
// route with a new externalUserId (Flow 4). Two uniqueness guarantees:
//   - (tenant_id, external_user_id) is unique: an integrator's local user ID
//     maps to exactly one Relay user.
//   - (user_id, tenant_id) is unique: a Relay user has at most one identity
//     per integrator, so re-attestation returns the same external_user_id.
// ---------------------------------------------------------------------------
export const user_external_identities = pgTable(
  'user_external_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' })
      .notNull(),
    external_user_id: text('external_user_id').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex('user_external_identities_tenant_external_key').on(
      t.tenant_id,
      t.external_user_id,
    ),
    uniqueIndex('user_external_identities_user_tenant_key').on(t.user_id, t.tenant_id),
  ],
);

// ---------------------------------------------------------------------------
// tenant_members — future multi-seat support (owner is implicit)
// ---------------------------------------------------------------------------
export const tenant_members = pgTable(
  'tenant_members',
  {
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' })
      .notNull(),
    user_id: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    role: text('role').notNull().default('member'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenant_id, t.user_id] })],
);

// ---------------------------------------------------------------------------
// tenant_providers — tenant-defined signup targets dispatched via HTTP webhook
// ---------------------------------------------------------------------------
export const tenant_providers = pgTable('tenant_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id')
    .references(() => tenants.id, { onDelete: 'cascade' })
    .notNull(),
  slug: text('slug').unique().notNull(),
  display_name: text('display_name').notNull(),
  signup_webhook_url: text('signup_webhook_url').notNull(),
  teardown_webhook_url: text('teardown_webhook_url'),
  webhook_secret_enc: bytea('webhook_secret_enc').notNull(),
  input_schema: jsonb('input_schema').notNull().default({}),
  // Discoverability metadata (0018). Populated by integrators when registering
  // a product; surfaced in REST + MCP list/get responses + dashboard cards.
  description: text('description'),
  docs_url: text('docs_url'),
  homepage: text('homepage'),
  npm_package: text('npm_package'),
  categories: jsonb('categories').notNull().default([]),
  // Comparison metadata (0020). Lets agents pick between providers inside a
  // category without following docsUrl.
  pricing_model: text('pricing_model'),
  pricing_url: text('pricing_url'),
  free_tier_summary: text('free_tier_summary'),
  capabilities: jsonb('capabilities').notNull().default([]),
  needs_email_verification: boolean('needs_email_verification').notNull().default(true),
  // Verification mode:
  //   'none'               — no verification, dispatch immediately (legacy, needs_email_verification=false)
  //   'relay_confirm_link' — Relay sends its own confirmation email to the user's real address (legacy path)
  //   'integrator_email'   — integrator sends a verification email to the user's Relay alias;
  //                          Relay reads it via `read_inbox` + `auto_confirm_pending_signup`.
  // Backfilled from needs_email_verification in migration 0003.
  verification_mode: text('verification_mode').notNull().default('relay_confirm_link'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// agents — bearer tokens (existing; extended with user_id + label + last_used_at)
// ---------------------------------------------------------------------------
// `tenant_id` pins a bearer to a specific
// integrator when `scopes` contains 'integrator'. The require-integrator-key
// middleware enforces both conditions — an unpinned agent cannot be promoted
// to an integrator key by scope alone. Null for normal user-owned agents.
export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  tenant_id: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  // Migration 0021: user-scoped agent tokens are pinned to a single user
  // workspace at creation time, mirroring how integrator tokens pin to a
  // tenant via `tenant_id`. Null for integrator-scoped agents and for legacy
  // user agents minted before workspace pinning — those fall back to the user's
  // is_default workspace at request time.
  user_workspace_id: uuid('user_workspace_id').references(() => user_workspaces.id, {
    onDelete: 'cascade',
  }),
  token_hash: text('token_hash').unique().notNull(),
  label: text('label'),
  scopes: jsonb('scopes').notNull().default([]),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  last_used_at: timestamp('last_used_at', { withTimezone: true }),
  revoked_at: timestamp('revoked_at', { withTimezone: true }),
  // Migration 0022: agent-token expiry. NULL = never expires (only granted
  // when the human user explicitly opts in). The auth middleware rejects
  // tokens whose `expires_at` is in the past with a distinct `agent_token_expired`
  // error so callers can prompt the user to re-bootstrap.
  expires_at: timestamp('expires_at', { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider_id: text('provider_id').notNull(),
    external_id: text('external_id').notNull(),
    label: text('label').notNull(),
    email_alias: text('email_alias'),
    credentials_enc: bytea('credentials_enc'),
    status: text('status').notNull().default('active'),
    // Ownership FKs. `user_id` is the end-user whose agent provisioned
    // this account and is the primary scope filter for /v1/user/* and /me pages.
    // `tenant_id` is set for accounts minted through a tenant-defined provider
    // (it is NULL for built-in providers like neon/vercel/resend that are not
    // attached to any tenant).
    user_id: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    tenant_id: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    // Migration 0021: the user's personal workspace this account belongs to.
    // Every /me/* query filters by this. Nullable for integrator-scoped
    // accounts where user_id is null.
    user_workspace_id: uuid('user_workspace_id').references(() => user_workspaces.id, {
      onDelete: 'cascade',
    }),
    // Migration 0026: optional handle that lets a single (workspace, provider)
    // pair host multiple distinct accounts (e.g. {neon, primary} and
    // {neon, analytics}). NULL means "the primary account for this provider"
    // — the dedup check in /v1/intent treats NULL as the implicit alias.
    alias: text('alias'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [
    // Migration 0026: partial unique index protecting the dedup window in
    // /v1/intent. Failed rows are excluded so a prior bad signup never blocks
    // retry. Pairs with pg_advisory_xact_lock keyed by (workspace, provider,
    // alias) inside the intent route handler.
    uniqueIndex('accounts_workspace_provider_alias_active')
      .on(t.user_workspace_id, t.provider_id, sql`COALESCE(${t.alias}, '')`)
      .where(sql`${t.status} != 'failed'`),
  ],
);

// ---------------------------------------------------------------------------
// signup_jobs
// ---------------------------------------------------------------------------
export const signup_jobs = pgTable('signup_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  account_id: uuid('account_id').references(() => accounts.id),
  status: text('status').notNull().default('pending'),
  workflow_run_id: text('workflow_run_id'),
  error: text('error'),
  // Ownership FKs + denormalized provider slug for cheap filtering.
  user_id: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  tenant_id: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
  // Migration 0021: user workspace this signup ran under.
  user_workspace_id: uuid('user_workspace_id').references(() => user_workspaces.id, {
    onDelete: 'cascade',
  }),
  calling_agent_id: uuid('calling_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  provider_slug: text('provider_slug'),
  // Migration 0026: alias for /v1/intent multi-resolution dedup. Mirrors
  // accounts.alias so the intent route can spot an in-flight provision for
  // the same (workspace, provider, alias) and avoid spawning a duplicate
  // workflow that would crash on the accounts unique index.
  alias: text('alias'),
  // Deliver-once credential buffer. When a provider returns the
  // initial API key during signup, we AES-256-GCM it into this column so the
  // *calling* agent can retrieve the plaintext exactly once via
  // GET /v1/signups/:id (or MCP get_signup_status with reveal=true). On that
  // successful read the column is cleared and `credentials_delivered_at`
  // is stamped. Relay never persists third-party API keys beyond this window.
  pending_credentials_enc: bytea('pending_credentials_enc'),
  credentials_delivered_at: timestamp('credentials_delivered_at', { withTimezone: true }),
  // Migration 0027: ground-truth handoff timestamp for activation accounting.
  // Stamped ONLY at the genuine deliver-once handoff write site (signups.ts
  // GET handler + mcp/server.ts get_signup_status with reveal=true). Distinct
  // from credentials_delivered_at, which is also stamped by the 24h cron
  // scrub even when no caller picked up the credentials. activations.is_24h
  // is computed against this column, not credentials_delivered_at.
  handoff_at: timestamp('handoff_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// signup_confirmations — one row per pending agent-initiated signup that needs
// the end user's click-through consent before Relay dispatches to the integrator.
// ---------------------------------------------------------------------------
export const signup_confirmations = pgTable('signup_confirmations', {
  id: uuid('id').primaryKey().defaultRandom(),
  signup_job_id: uuid('signup_job_id')
    .references(() => signup_jobs.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  token: text('token').unique().notNull(),
  email: text('email').notNull(),
  tenant_provider_slug: text('tenant_provider_slug').notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  confirmed_at: timestamp('confirmed_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// api_keys
// ---------------------------------------------------------------------------
export const api_keys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  account_id: uuid('account_id')
    .references(() => accounts.id)
    .notNull(),
  provider_key_id: text('provider_key_id'),
  label: text('label').notNull(),
  key_enc: bytea('key_enc'),
  last_revealed_at: timestamp('last_revealed_at', { withTimezone: true }),
  // Relay-observable usage timestamp. Bumped on mint, signup delivery, legacy
  // reveal, rotation, and Relay-initiated provider calls. Does NOT reflect
  // direct calls from the end-user's copy of the key against the provider.
  last_used_at: timestamp('last_used_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  revoked_at: timestamp('revoked_at', { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// email_messages
// ---------------------------------------------------------------------------
export const email_messages = pgTable('email_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  to_address: text('to_address').notNull(),
  from_address: text('from_address').notNull(),
  subject: text('subject'),
  body_text: text('body_text'),
  headers: jsonb('headers'),
  matched_signup_id: uuid('matched_signup_id').references(() => signup_jobs.id),
  // If `to_address` matched a users.inbox_alias, link the message
  // to that user so MCP `read_inbox` can filter to the caller's own mail.
  user_id: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  // Migration 0021: the user workspace this email was addressed to. Resolved
  // by the email webhook by matching `to_address` against
  // user_workspaces.inbox_alias. Null for unmatched inbound mail.
  user_workspace_id: uuid('user_workspace_id').references(() => user_workspaces.id, {
    onDelete: 'set null',
  }),
  received_at: timestamp('received_at', { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// cli_auth_codes — one row per in-flight `npx @relay/cli login` device-code
// handshake. CLI generates a random device_code, browser approves in-session,
// server mints an agent token and drops its plaintext here for the CLI's next
// poll. Plaintext is cleared on pickup or expiry (10 min).
// ---------------------------------------------------------------------------
export const cli_auth_codes = pgTable('cli_auth_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  device_code: text('device_code').unique().notNull(),
  user_id: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  agent_id: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  agent_token_plaintext: text('agent_token_plaintext'),
  approved_at: timestamp('approved_at', { withTimezone: true }),
  picked_up_at: timestamp('picked_up_at', { withTimezone: true }),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// intent_resolutions — per-(agent, Idempotency-Key) cache for /v1/intent
// responses. Lets a caller retry after a 5xx without spawning duplicate
// signup_jobs. TTL 24h; the cron GC drops expired rows.
// ---------------------------------------------------------------------------
export const intent_resolutions = pgTable(
  'intent_resolutions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agent_id: uuid('agent_id')
      .references(() => agents.id, { onDelete: 'cascade' })
      .notNull(),
    key: text('key').notNull(),
    response_json: jsonb('response_json').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('intent_resolutions_agent_key_key').on(t.agent_id, t.key),
    index('idx_intent_resolutions_expires_at').on(t.expires_at),
  ],
);

// ---------------------------------------------------------------------------
// audit_log
// ---------------------------------------------------------------------------
export const audit_log = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  agent_id: uuid('agent_id').references(() => agents.id),
  action: text('action').notNull(),
  target: text('target'),
  metadata: jsonb('metadata'),
  // Ownership FKs so developer audit views and end-user audit views
  // can filter without reconstructing the chain through agents.
  user_id: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  tenant_id: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
  // Migration 0021: optional workspace scope so per-workspace audit views
  // don't have to reconstruct ownership through the agent chain.
  user_workspace_id: uuid('user_workspace_id').references(() => user_workspaces.id, {
    onDelete: 'set null',
  }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// magic_links — short-lived, single-use URLs that let an agent hand a
// logged-out user a minimal read-only view of their own Relay data.
// Plaintext is never stored; only the SHA-256 hash of the token.
// ---------------------------------------------------------------------------
export const magic_links = pgTable('magic_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  token_hash: text('token_hash').unique().notNull(),
  purpose: text('purpose').notNull(), // 'dashboard_summary' (reserved for future: 'single_account', ...)
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  claimed_at: timestamp('claimed_at', { withTimezone: true }),
  max_uses: integer('max_uses').notNull().default(1),
  used_count: integer('used_count').notNull().default(0),
  created_by: uuid('created_by').references(() => agents.id, { onDelete: 'set null' }),
  // Migration 0021: scope share links to a single user workspace so a link
  // from workspace A doesn't leak workspace B's data.
  user_workspace_id: uuid('user_workspace_id').references(() => user_workspaces.id, {
    onDelete: 'cascade',
  }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// tenant_feature_flags — per-tenant opt-ins. Composite PK keeps the row
// layout dead-simple: the presence of a (tenant_id, flag) pair means "on".
// ---------------------------------------------------------------------------
export const tenant_feature_flags = pgTable(
  'tenant_feature_flags',
  {
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' })
      .notNull(),
    flag: text('flag').notNull(),
    enabled_at: timestamp('enabled_at', { withTimezone: true }).notNull().defaultNow(),
    enabled_by: uuid('enabled_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [primaryKey({ columns: [t.tenant_id, t.flag] })],
);

// ---------------------------------------------------------------------------
// Billing data model
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// tenant_subscriptions — Stripe-backed tenant subscription state. A tenant
// may have multiple historical rows; only one is active at a time (partial
// index on status IN ('trialing','active') in the migration enforces the
// query path). Founders plan is a pre-billing 60-day trial seeded by the
// backfill script; real plans are managed by Stripe webhooks.
//   status ∈ 'trialing' | 'active' | 'past_due' | 'canceled'
//   plan   ∈ 'founders' | 'starter' | 'growth' | …
// ---------------------------------------------------------------------------
export const tenant_subscriptions = pgTable('tenant_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id')
    .references(() => tenants.id, { onDelete: 'cascade' })
    .notNull(),
  status: text('status').notNull(),
  plan: text('plan').notNull(),
  stripe_subscription_id: text('stripe_subscription_id').unique(),
  stripe_customer_id: text('stripe_customer_id'),
  current_period_end: timestamp('current_period_end', { withTimezone: true }),
  trial_ends_at: timestamp('trial_ends_at', { withTimezone: true }),
  canceled_at: timestamp('canceled_at', { withTimezone: true }),
  // Per-month action-API volume quota + rolling counter.
  //   actions_included:  plan cap (-1 == unlimited, 0 == no override →
  //                      hardcoded fallback from src/server/billing/user-cap.ts)
  //   actions_used_period: number of /v1/actions/execute calls this period
  //   period_resets_at:  rolls forward on next call when expired (or set by
  //                      the Stripe webhook on subscription.updated)
  actions_included: integer('actions_included').notNull().default(0),
  actions_used_period: integer('actions_used_period').notNull().default(0),
  period_resets_at: timestamp('period_resets_at', { withTimezone: true }),
  // Per-plan max end-users cap (enforced in user-cap.ts). -1 == unlimited
  // (Scale / Enterprise). 0 == fall back to the hardcoded per-plan default.
  users_limit: integer('users_limit').notNull().default(0),
  // Migration 0025: billing cadence selected by the integrator at checkout.
  // Sourced from Stripe webhooks (price.recurring.interval) — request
  // payload is not authoritative because Customer Portal can switch this
  // out from under us. CHECK constraint enforces the enum at the DB level.
  billing_interval: text('billing_interval').notNull().default('monthly'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// subscription_events — append-only audit of subscription state changes.
// `stripe_event_id` is the Stripe webhook event id and doubles as our
// idempotency key (UNIQUE). `event_type` mirrors Stripe ('created',
// 'renewed', 'canceled', 'past_due', …). 'created' rows with
// stripe_event_id NULL come from the initial backfill.
// ---------------------------------------------------------------------------
export const subscription_events = pgTable('subscription_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  subscription_id: uuid('subscription_id')
    .references(() => tenant_subscriptions.id, { onDelete: 'cascade' })
    .notNull(),
  event_type: text('event_type').notNull(),
  stripe_event_id: text('stripe_event_id').unique(),
  metadata: jsonb('metadata'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// plan_catalog — source of truth for plan pricing + included action quota.
// Rows are seeded by migration 0016 and re-quota'd in 0023 to the action
// meter. Editable in place; the Stripe webhook upsert re-reads on every
// event so operators can tune pricing without a redeploy.
//   included_actions  -1 == unlimited
//   overage_price_cents 0 on the Founders trial and Enterprise placeholder
// ---------------------------------------------------------------------------
export const plan_catalog = pgTable('plan_catalog', {
  id: text('id').primaryKey(),
  display_name: text('display_name').notNull(),
  price_cents: integer('price_cents').notNull(),
  included_actions: integer('included_actions').notNull(),
  overage_price_cents: integer('overage_price_cents').notNull(),
  trial_actions: integer('trial_actions'),
  trial_days: integer('trial_days'),
  sla_target: text('sla_target'),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// tenant_quota_state — per-tenant signup counter for the current billing
// period. Exactly one row per tenant. Webhooks reset it on
// invoice.payment_succeeded (new period); the workflow decrements it on
// dispatch and increments on failure via refundIntegratorQuota.
// ---------------------------------------------------------------------------
export const tenant_quota_state = pgTable('tenant_quota_state', {
  tenant_id: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  period_start: timestamp('period_start', { withTimezone: true }).notNull(),
  period_end: timestamp('period_end', { withTimezone: true }).notNull(),
  included_remaining: integer('included_remaining').notNull().default(0),
  overage_count: integer('overage_count').notNull().default(0),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// stripe_pending_invoice_items — queue of per-action overage charges that
// haven't been pushed to Stripe yet. Flushed monthly by the cron at
// /v1/cron/flush-overage. Keyed on idempotency_key (UNIQUE) so a retry
// of the same action is a no-op. signup_job_id stays around for legacy
// rows + cron debug logging; the new path uses idempotency_key.
// ---------------------------------------------------------------------------
export const stripe_pending_invoice_items = pgTable(
  'stripe_pending_invoice_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' })
      .notNull(),
    signup_job_id: uuid('signup_job_id').unique(),
    idempotency_key: text('idempotency_key').unique().notNull(),
    amount_cents: integer('amount_cents').notNull(),
    stripe_subscription_id: text('stripe_subscription_id'),
    flushed_at: timestamp('flushed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

// ---------------------------------------------------------------------------
// action_credits — per-tenant prepaid credit-pack ledger (migration 0025).
//
// An integrator buys a one-shot credit pack via Stripe Checkout
// (mode=payment) when they're running short of plan-included headroom
// for the current period. The webhook inserts one row per purchase with
// `actions_remaining = actions_purchased`. `requireIntegratorQuota`
// FIFO-decrements `actions_remaining` on the earliest-expiring unexpired
// row before falling through to the overage queue. Credits expire 12
// months after purchase. The partial index in 0025 is what makes the
// FIFO query cheap.
// ---------------------------------------------------------------------------
export const action_credits = pgTable('action_credits', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id')
    .references(() => tenants.id, { onDelete: 'cascade' })
    .notNull(),
  pack_id: text('pack_id').notNull(),
  actions_purchased: integer('actions_purchased').notNull(),
  actions_remaining: integer('actions_remaining').notNull(),
  amount_cents_paid: integer('amount_cents_paid').notNull(),
  stripe_payment_intent_id: text('stripe_payment_intent_id').unique(),
  stripe_checkout_session_id: text('stripe_checkout_session_id'),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// action_credit_consumptions — per-action audit log so refunds can put a
// credit slot back on the EXACT pack that was spent (migration 0025).
//
// Refunds are keyed on idempotency_key; this table maps that key back to
// the action_credit row whose actions_remaining was decremented. The
// UNIQUE on idempotency_key also makes the refund path idempotent.
// ---------------------------------------------------------------------------
export const action_credit_consumptions = pgTable('action_credit_consumptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id')
    .references(() => tenants.id, { onDelete: 'cascade' })
    .notNull(),
  action_credit_id: uuid('action_credit_id')
    .references(() => action_credits.id, { onDelete: 'cascade' })
    .notNull(),
  idempotency_key: text('idempotency_key').notNull().unique(),
  consumed_at: timestamp('consumed_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// actions — per-tenant registry of agent-invokable product actions.
//
// A tenant registers an action with an endpoint_url + input_schema; agents
// discover the catalog and POST to /v1/actions/execute to invoke. Relay
// HMAC-signs the callout to endpoint_url with webhook_secret_enc. Slug is
// unique per tenant (NOT globally unique — two integrators can both
// expose `publish`). visibility='public' means every agent with an
// identity binding on this tenant can invoke; 'private' is reserved for
// a future agent allowlist.
// ---------------------------------------------------------------------------
export const actions = pgTable(
  'actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' })
      .notNull(),
    slug: text('slug').notNull(),
    display_name: text('display_name').notNull(),
    description: text('description'),
    endpoint_url: text('endpoint_url').notNull(),
    endpoint_method: text('endpoint_method').notNull().default('POST'),
    input_schema: jsonb('input_schema').notNull().default({}),
    output_schema: jsonb('output_schema').notNull().default({}),
    webhook_secret_enc: bytea('webhook_secret_enc').notNull(),
    timeout_ms: integer('timeout_ms').notNull().default(30000),
    visibility: text('visibility').notNull().default('public'),
    disabled_at: timestamp('disabled_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('actions_tenant_slug_key').on(t.tenant_id, t.slug)],
);

// ---------------------------------------------------------------------------
// action_invocations — per-execute ledger + idempotency store.
//
// Inserted with status='dispatched' BEFORE the HMAC callout so that a
// timeout (status='unknown') leaves a durable trace. Flipped to
// 'succeeded' | 'failed' | 'unknown' on completion. 'overage' marks an
// invocation that ran inside the 110 % soft cap; 'quota_denied' is the
// 429 refusal past the cap. idempotency_key is client-supplied (Stripe
// pattern); unique per (tenant, action, external_user, key).
// ---------------------------------------------------------------------------
export const action_invocations = pgTable(
  'action_invocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    action_id: uuid('action_id')
      .references(() => actions.id, { onDelete: 'cascade' })
      .notNull(),
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' })
      .notNull(),
    user_id: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    agent_id: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    external_user_id: text('external_user_id').notNull(),
    idempotency_key: text('idempotency_key'),
    status: text('status').notNull(),
    latency_ms: integer('latency_ms'),
    error: text('error'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completed_at: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('action_invocations_idem_key')
      .on(t.tenant_id, t.action_id, t.external_user_id, t.idempotency_key)
      .where(sql`${t.idempotency_key} IS NOT NULL`),
  ],
);

// ---------------------------------------------------------------------------
// tenant_plan_features — per-tenant feature bag, set on plan upsert + by
// sales for Enterprise deals. Known flags:
//   scale_e2e_benchmark: boolean — auto-run synthetic probe every 5 min
//   custom_user_roles:  boolean — admin/editor/viewer allowed
//   custom_actions:     boolean — non-catalog actions registerable
//   sla_contract:       boolean — 99.9% uptime + P95 SLA owed
//   sso:                boolean — SAML/OIDC on /dev dashboard
//   data_residency:     'us' | 'eu' | null
//   audit_export:       boolean — daily audit_log → customer S3
//   pricing_override:   boolean — negotiated per-action or per-seat
// ---------------------------------------------------------------------------
export const tenant_plan_features = pgTable('tenant_plan_features', {
  tenant_id: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  features: jsonb('features').notNull().default({}),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// scale_benchmark_samples — synthetic E2E probe timings for Scale tenants.
// The /v1/cron/scale-benchmark route walks discover → attest → execute
// against every tenant where features.scale_e2e_benchmark=true and records
// each stage's latency. /dev/analytics aggregates these into the P50/P95
// charts that back Scale's performance SLA.
// ---------------------------------------------------------------------------
export const scale_benchmark_samples = pgTable(
  'scale_benchmark_samples',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' })
      .notNull(),
    stage: text('stage').notNull(),
    latency_ms: integer('latency_ms').notNull(),
    ok: boolean('ok').notNull(),
    error: text('error'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

// ---------------------------------------------------------------------------
// Migration 0027 — founding-partner sprint + activation tracking
// ---------------------------------------------------------------------------

// tenant_tracking_secrets — per-tenant low-privilege HMAC secret used
// only to authenticate POST /v1/activations from the @relay/track SDK.
// Multiple non-revoked rows per tenant let manual rotation accept both
// old and new secrets during a short grace window.
//
// The integrator stores both `public_id` (sent in X-Relay-Secret-Id) and
// `secret_value` (used to compute HMAC signatures). The server stores
// `secret_value` at rest (Stripe restricted-key pattern) and uses
// `public_id` as the lookup key for fast verification. Plaintext is
// never echoed in any API response.
export const tenant_tracking_secrets = pgTable(
  'tenant_tracking_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' })
      .notNull(),
    public_id: text('public_id').notNull().unique(),
    secret_value: text('secret_value').notNull(),
    label: text('label'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    grace_until: timestamp('grace_until', { withTimezone: true }),
  },
  (t) => [index('idx_tenant_tracking_secrets_tenant').on(t.tenant_id)],
);

// activations — one row per integrator-reported activation event.
// Idempotent on (tenant_id, idempotency_key). Joins primarily on
// signup_id; is_24h is computed at write time against
// signup_jobs.handoff_at. metadata_redacted holds normalized fields
// only — never raw integrator request payloads.
export const activations = pgTable(
  'activations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' })
      .notNull(),
    signup_id: uuid('signup_id')
      .references(() => signup_jobs.id, { onDelete: 'cascade' })
      .notNull(),
    account_id: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    external_user_id: text('external_user_id'),
    provider_key_id: uuid('provider_key_id'),
    event_name: text('event_name').notNull().default('authenticated_api_call_succeeded'),
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
    received_at: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    idempotency_key: text('idempotency_key').notNull(),
    metadata_redacted: jsonb('metadata_redacted').notNull().default({}),
    is_24h: boolean('is_24h').notNull().default(false),
    is_7d: boolean('is_7d').notNull().default(false),
  },
  (t) => [
    uniqueIndex('activations_tenant_idem_key').on(t.tenant_id, t.idempotency_key),
    index('idx_activations_signup_id').on(t.signup_id),
    index('idx_activations_tenant_occurred').on(t.tenant_id, t.occurred_at),
  ],
);
