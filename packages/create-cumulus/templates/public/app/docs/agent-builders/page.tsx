import Link from 'next/link';
import { Kicker } from '@/app/components/Kicker';

export const metadata = {
  title: 'For agent builders — Relay',
  description:
    "Point your agent at Relay's MCP server and it can sign users up to any app that's registered on the platform. Claude Desktop setup, MCP tool reference, example prompts.",
};

interface Tool {
  name: string;
  summary: string;
  args?: string;
}

const tools: Tool[] = [
  { name: 'list_categories', summary: 'Top-level chunk: which provider categories exist, with counts + alias map. No token required.', args: '—' },
  { name: 'list_providers_by_category', summary: 'Per-category chunk: full provider details (pricing, capabilities, input schema). Supports capability + pricing filters.', args: 'agent_token, category, capability?, pricing?' },
  { name: 'list_providers', summary: 'List every signup target in one payload (built-in and tenant-defined). Prefer the chunked index above for large catalogs.' },
  { name: 'get_provider', summary: 'Full metadata + JSON Schema input for a single provider.', args: 'agent_token, id' },
  { name: 'create_signup', summary: 'Start a durable signup workflow on the named provider.', args: 'agent_token, provider, input' },
  { name: 'get_signup_status', summary: 'Poll a signup; returns initial_api_key or initial_credentials exactly once on completion.', args: 'agent_token, signup_id' },
  { name: 'list_accounts', summary: "List the calling user's provisioned accounts." },
  { name: 'get_api_key', summary: 'Mint a fresh API key on an account (zero-retention; returned once).', args: 'agent_token, account_id, label?' },
  { name: 'reveal_api_key', summary: 'Legacy reveal for keys stored before the zero-retention policy.' },
  { name: 'delete_account', summary: "Delete an account through the provider's teardown handler." },
  { name: 'register_tenant', summary: 'Start the Relay bootstrap: email an OTP to the caller.' },
  { name: 'submit_verification_code', summary: 'Complete the bootstrap; returns the first agent token + tenant id.' },
  { name: 'register_tenant_product', summary: 'Register a new signup target on a tenant via MCP.' },
  { name: 'get_my_inbox_address', summary: "Return the user's agent-readable inbox alias." },
  { name: 'read_inbox', summary: 'Read recent inbound emails; supports code/link extraction.' },
  { name: 'auto_confirm_pending_signup', summary: 'Poll the inbox for a verification email and auto-resume the workflow.' },
  { name: 'share_dashboard_link', summary: 'Mint a one-time read-only share URL to the dashboard.' },
  { name: 'get_subscription_status', summary: "Return the tenant's subscription + quota snapshot. During the founding-partner phase the response carries the partnership_status field (sprint_paid / renewed / lapsed) instead of a self-serve plan." },
  { name: 'whoami', summary: 'Identify the calling agent / user.' },
  { name: 'resolve_intent', summary: 'One-shot goal-to-env resolver. Parses a free-text goal ("Postgres + transactional email"), dedups against existing accounts, kicks signups for the gaps, and returns a paste-ready env block. Deterministic — same goal + same workspace returns the same response. Intent itself is non-billable; sub-signups bill normally.', args: 'agent_token, goal, workspace_id, [pin]' },
];

const tokenHygieneNotes: string[] = [
  'Tokens minted via `submit_verification_code`, `register_tenant`, or the CLI flow default to 30 days. The response includes `agent_token_expires_at` (ISO-8601, or `null` for non-expiring tokens).',
  'Save the token into the user\'s project CLAUDE.md under a `## Relay` heading. Include the expiry date as a comment so future sessions know when to rotate.',
  'On the next call after expiry, Relay returns `{ "error": "agent_token_expired" }`. Tell the user, call `register_tenant` again, and overwrite the CLAUDE.md entry with the new token.',
  'Only pass `never_expires: true` when the user has explicitly asked for a non-rotating token. A 30-day token is the secure default.',
];

const examples: Array<{ title: string; user: string; agent: string }> = [
  {
    title: 'Fresh agent delegate — full Relay bootstrap',
    user: "'Sign me up for Relay and call me Alex.'",
    agent:
      "register_tenant → OTP lands in the user's real inbox → user pastes code → submit_verification_code → agent token minted → whoami confirms.",
  },
  {
    title: 'Pick the best provider for a task (chunked discovery)',
    user: "'I need somewhere to store data for my app.'",
    agent:
      "list_categories → sees a 'database' slug → list_providers_by_category(category:'database', capability:['postgres'], pricing:'free-tier') → compares the (now short) list on pricingModel / capabilities / freeTierSummary → create_signup(provider:'<pick>', input:{…}).",
  },
  {
    title: 'Sign up on a partnered product',
    user: "'Create a Cumulus account for me.'",
    agent:
      "list_providers → create_signup(provider='cumulus-database', input={email:'alex@example.com', purpose:'project memory'}) → get_signup_status loops until complete → returns endpoint, database_id, data_token, and admin_token.",
  },
  {
    title: 'Automated verification via the agent inbox',
    user: "'Confirm the verification email Cumulus just sent.'",
    agent:
      "get_signup_status returns status='awaiting_email' → auto_confirm_pending_signup reads inbox, extracts OTP or link, calls the confirm endpoint → workflow resumes → account delivered.",
  },
];

export default function AgentBuildersPage() {
  return (
    <main
      style={{
        maxWidth: 880,
        margin: '0 auto',
        padding: '96px 24px',
        fontFamily: 'var(--font-display)',
      }}
    >
      <Kicker>Docs · agent builders</Kicker>
      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 300,
          fontSize: 48,
          lineHeight: 1,
          letterSpacing: '-0.025em',
          margin: '0 0 24px',
        }}
      >
        For agent builders.
      </h1>
      <p
        style={{
          fontSize: 17,
          color: 'var(--color-ink-2)',
          lineHeight: 1.5,
          maxWidth: 620,
          marginBottom: 48,
        }}
      >
        Relay exposes every product operation as an MCP tool. Point your
        agent at <code>/mcp</code>, hand it an agent token, and it can sign
        users up, read verification emails, and deliver working API keys —
        all in one chat turn.
      </p>

      <Section title="Zero-context quickstart">
        A cold agent handed a bearer token can bootstrap in three requests —
        no codebase access, no env vars, no out-of-band configuration:
        <Pre>
{`# 1. Discover the base URL + MCP endpoint + docs (unauthenticated)
curl https://relay.cumulush.com/.well-known/relay.json

# 2. Prove the token works
curl -H "Authorization: Bearer agt_..." \\
     https://relay.cumulush.com/v1/whoami

# 3. Browse the provider catalog in chunks (see next section)
curl -H "Authorization: Bearer agt_..." \\
     https://relay.cumulush.com/v1/index`}
        </Pre>
        Step 1 is the only unauthenticated hop. Its response contains{' '}
        <code>apiBase</code>, <code>mcpEndpoint</code>,{' '}
        <code>openapiUrl</code>, <code>docsUrl</code>, and{' '}
        <code>agentDocsUrl</code> — everything a fresh agent needs to wire the
        rest up.
      </Section>

      <Section title="Provider discovery (chunked index)">
        <a
          id="provider-index"
          style={{ display: 'block', position: 'relative', top: -80 }}
        />
        The provider catalog grows with every integrator that signs up. Rather
        than shipping the whole list on every agent call, Relay exposes a{' '}
        <strong>chunked index</strong>: agents ask for the categories they need,
        not the whole catalog.

        <h3 style={{ fontSize: 15, margin: '18px 0 6px' }}>The three-step flow</h3>
        <Pre>
{`# Step 1 — what categories exist right now?
#   Returns:  { categories:[{ slug, displayName, count, providerIds }],
#              aliases:{ "hoster":"hosting", "mail":"email", ... } }
curl -H "Authorization: Bearer agt_..." \\
     https://relay.cumulush.com/v1/index

# Step 2 — full details for just the category you need.
#   Optional: ?capability=postgres&pricing=free-tier
#   Returns:  { category, displayName, providers:[ProviderSummary...] }
curl -H "Authorization: Bearer agt_..." \\
     "https://relay.cumulush.com/v1/index/database?capability=postgres"

# Step 3 — pick one + sign up as usual.
curl -X POST -H "Authorization: Bearer agt_..." \\
     -H "Content-Type: application/json" \\
     -d '{"provider":"neon","input":{"name":"my-app-db"}}' \\
     https://relay.cumulush.com/v1/signups`}
        </Pre>
        <p style={{ margin: '12px 0' }}>
          The MCP equivalents are <code>list_categories</code> and{' '}
          <code>list_providers_by_category</code>. <code>list_categories</code>{' '}
          does not take an <code>agent_token</code> — the overview is public
          discovery data.
        </p>

        <h3 style={{ fontSize: 15, margin: '18px 0 6px' }}>Canonical categories</h3>
        <p style={{ margin: '4px 0 10px' }}>
          Every category query is normalized server-side. Aliases like{' '}
          <code>hoster</code> → <code>hosting</code>, <code>mail</code> →{' '}
          <code>email</code>, or <code>logs</code> →{' '}
          <code>observability</code> resolve automatically so an agent&apos;s
          fuzzy guess still lands on the right chunk. The full alias map is
          returned on <code>GET /v1/index</code>.
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
            }}
          >
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-hair)' }}>
                <th style={{ padding: '8px 12px' }}>Slug</th>
                <th style={{ padding: '8px 12px' }}>What goes here</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['database', 'Postgres / MySQL / key-value / managed DB of any flavor.'],
                  ['hosting', 'Deploy + serve an app. Vercel, Netlify, Fly, Cloudflare Workers.'],
                  ['email', 'Transactional email senders (Resend, Postmark, SendGrid).'],
                  ['newsletter', 'Broadcast / marketing email (Buttondown, Substack, Beehiiv).'],
                  ['auth', 'Identity, SSO, passkeys. Clerk, WorkOS, Descope, Auth0.'],
                  ['storage', 'Object / blob / file storage. S3-compatible, Tigris, R2.'],
                  ['analytics', 'Product + marketing analytics. PostHog, Plausible, Mixpanel.'],
                  ['payments', 'Stripe, Paddle, LemonSqueezy.'],
                  ['cms', 'Sanity, Contentful, Payload, Hygraph.'],
                  ['observability', 'Logging, tracing, error reporting. Sentry, Datadog, Axiom.'],
                  ['ai', 'LLM / embedding / inference providers.'],
                  ['search', 'Algolia, Typesense, Meilisearch.'],
                  ['saas', 'Everything else.'],
                ] as const
              ).map(([slug, blurb]) => (
                <tr key={slug} style={{ borderBottom: '1px solid var(--color-hair)' }}>
                  <td style={{ padding: '8px 12px', fontWeight: 500 }}>{slug}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--color-ink-2)' }}>{blurb}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 style={{ fontSize: 15, margin: '20px 0 6px' }}>Fields on each provider</h3>
        <ul style={{ margin: '4px 0 0', paddingLeft: 22 }}>
          <li>
            <code>pricingModel</code>: one of <code>free</code>,{' '}
            <code>free-tier</code>, <code>paid</code>,{' '}
            <code>usage-based</code>, <code>freemium</code> — or{' '}
            <code>null</code> if unspecified.
          </li>
          <li>
            <code>pricingUrl</code>, <code>freeTierSummary</code>: one-line
            human-readable pointers so an agent can show the user a sane
            comparison without scraping.
          </li>
          <li>
            <code>capabilities</code>: array of lower-case tags (e.g.{' '}
            <code>[&quot;postgres&quot;, &quot;serverless&quot;, &quot;branching&quot;]</code>). Filter
            with <code>?capability=…</code> on the HTTP side, or the{' '}
            <code>capability:[…]</code> argument on the MCP tool — multiple
            values AND together.
          </li>
          <li>
            <code>categories</code>, <code>displayName</code>,{' '}
            <code>description</code>, <code>docsUrl</code>,{' '}
            <code>homepage</code>, <code>npmPackage</code>,{' '}
            <code>inputSchema</code> — all the usual provider metadata.
          </li>
        </ul>

        <h3 style={{ fontSize: 15, margin: '20px 0 6px' }}>Worked example</h3>
        <p style={{ margin: '4px 0 10px' }}>
          User says <em>&quot;I need a free Postgres database.&quot;</em> Agent
          runs:
        </p>
        <Pre>
{`list_providers_by_category({
  category: "database",
  capability: ["postgres"],
  pricing: "free-tier"
})

# → { category: "database",
#     providers: [
#       { id: "neon",
#         pricingModel: "free-tier",
#         freeTierSummary: "0.5 GB storage and ~190 compute hours per month…",
#         capabilities: ["postgres","serverless","branching", ...],
#         … }
#     ] }

create_signup({
  provider: "neon",
  input: { name: "my-app-db" }
})`}
        </Pre>
      </Section>

      <Section title="Cumulus Database quickstart">
        Cumulus Database is available under both <code>database</code> and{' '}
        <code>ai</code>. Use it when a project needs agent-owned memory,
        records, key-value data, secrets, or hybrid search.
        <Pre>
{`# REST discovery
curl https://relay.cumulush.com/v1/index
curl "https://relay.cumulush.com/v1/index/database?capability=agent-memory"
curl "https://relay.cumulush.com/v1/index/ai"

# REST signup
curl -X POST -H "Authorization: Bearer agt_..." \\
     -H "Content-Type: application/json" \\
     -d '{
       "provider": "cumulus-database",
       "input": {
         "email": "alex@example.com",
         "purpose": "project memory"
       }
     }' \\
     https://relay.cumulush.com/v1/signups

# Poll until status is "complete".
curl -H "Authorization: Bearer agt_..." \\
     https://relay.cumulush.com/v1/signups/<signup_id>

# First complete response only:
{
  "signup_id": "<signup_id>",
  "status": "complete",
  "account_id": "<account_id>",
  "initial_credentials": {
    "endpoint": "https://db.cumulush.com",
    "database_id": "db_...",
    "data_token": "cdb_data_...",
    "admin_token": "cdb_admin_..."
  }
}`}
        </Pre>
        <p style={{ margin: '12px 0' }}>
          MCP agents use the same flow with <code>list_categories</code>,{' '}
          <code>list_providers_by_category</code>,{' '}
          <code>create_signup</code>, and <code>get_signup_status</code>.
          The <code>initial_credentials</code> object is returned exactly once.
          Put <code>data_token</code> in the project runtime and treat{' '}
          <code>admin_token</code> as a one-time administrative secret.
        </p>
        <Pre>
{`create_signup({
  provider: "cumulus-database",
  input: {
    email: "alex@example.com",
    purpose: "project memory"
  }
})

get_signup_status({ signup_id: "<signup_id>" })`}
        </Pre>
      </Section>

      <Section title="One-shot resolver — POST /v1/intent">
        <a
          id="intent"
          style={{ display: 'block', position: 'relative', top: -80 }}
        />
        Once an agent knows the catalog exists, the chunked index is the
        manual path. The faster path is to hand Relay the goal and let it
        do the discovery, dedup, and env-naming for you in one round trip.
        <Pre>
{`# "Wire up Postgres and transactional email for this workspace."
curl -X POST -H "Authorization: Bearer agt_..." \\
     -H "Content-Type: application/json" \\
     -H "Idempotency-Key: $(uuidgen)" \\
     -d '{
       "goal": "Postgres + transactional email for a Next.js app",
       "workspaceId": "ws_..."
     }' \\
     https://relay.cumulush.com/v1/intent

# Response (always 200; partial success is normal):
# {
#   "resolutions": [
#     { "category": "database", "alias": null, "provider": "neon",
#       "status": "existing", "accountId": "acc_...",
#       "envVar": "DATABASE_URL",
#       "revealUrl": "/v1/accounts/acc_.../api-keys/key_.../reveal" },
#     { "category": "email", "alias": null, "provider": "resend",
#       "status": "provisioning", "signupJobId": "sj_...",
#       "pollUrl": "/v1/signups/sj_...",
#       "envVar": "RESEND_API_KEY" }
#   ],
#   "envBlock": "DATABASE_URL=__reveal_required__\\nRESEND_API_KEY=__pending__\\n",
#   "pending": ["sj_..."],
#   "unsatisfied": [],
#   "unmatchedTerms": [],
#   "revealAllUrl": "/v1/accounts/keys/reveal-batch",
#   "notes": [
#     "Resend signup requires email verification — poll /v1/signups/sj_..."
#   ]
# }`}
        </Pre>

        <h3 style={{ fontSize: 15, margin: '20px 0 6px' }}>What it does for you</h3>
        <ul style={{ margin: '4px 0 0', paddingLeft: 22 }}>
          <li>
            <strong>Parses the goal</strong> into canonical categories
            (heuristic keyword match — no LLM, fully deterministic).
          </li>
          <li>
            <strong>Picks a provider per category</strong> by pricing model
            (free → free-tier → freemium → usage-based → paid, then
            alphabetical). When two providers tie, the resolution comes back
            as <code>status: &quot;ambiguous&quot;</code> with a{' '}
            <code>candidates</code> list — pin one to choose.
          </li>
          <li>
            <strong>Dedups against existing accounts</strong> in the
            workspace. If the user already has a Neon project for the
            primary alias, the resolution comes back as{' '}
            <code>status: &quot;existing&quot;</code> with the{' '}
            <code>accountId</code> — no duplicate provisioning.
          </li>
          <li>
            <strong>Kicks signups for the gaps</strong> via the standard
            workflow. The resolution comes back as{' '}
            <code>status: &quot;provisioning&quot;</code> with a{' '}
            <code>signupJobId</code> + <code>pollUrl</code> — poll
            <code> GET /v1/signups/:id</code> exactly as you would for a
            direct <code>POST /v1/signups</code> call.
          </li>
          <li>
            <strong>Builds the env block</strong> in deterministic order
            (canonical category, then alias). Sentinels{' '}
            <code>__pending__</code> and <code>__reveal_required__</code>{' '}
            mark the slots a follow-up call needs to fill. Fresh signups
            inline plaintext on first read.
          </li>
        </ul>

        <h3 style={{ fontSize: 15, margin: '20px 0 6px' }}>Pinning a provider or alias</h3>
        <p style={{ margin: '4px 0 10px' }}>
          When you need a specific provider, or two distinct accounts inside
          the same category (a primary + analytics Postgres, for example),
          pass a <code>pin</code> array. Each pin becomes its own resolution
          slot:
        </p>
        <Pre>
{`{
  "goal": "Postgres for the app and a separate Postgres for analytics",
  "workspaceId": "ws_...",
  "pin": [
    { "category": "database", "providerId": "neon", "alias": "primary" },
    { "category": "database", "providerId": "neon", "alias": "analytics" }
  ]
}

# → resolutions[0].envVar = "DATABASE_URL_PRIMARY"
# → resolutions[1].envVar = "DATABASE_URL_ANALYTICS"`}
        </Pre>

        <h3 style={{ fontSize: 15, margin: '20px 0 6px' }}>Idempotency-Key</h3>
        <p style={{ margin: '4px 0 10px' }}>
          Send <code>Idempotency-Key</code> on retries. Relay caches the
          response per <code>(agent, key)</code> for 24 hours, so a retry
          after a 5xx never duplicates signups.
        </p>

        <h3 style={{ fontSize: 15, margin: '20px 0 6px' }}>Billing</h3>
        <p style={{ margin: '4px 0 0' }}>
          The intent call itself is <strong>free</strong>. Each spawned
          signup bills the integrator&apos;s quota normally — same gate as
          a direct <code>POST /v1/signups</code> call. Calling intent on a
          fully-existing workspace is a free, deterministic dedup check.
        </p>

        <h3 style={{ fontSize: 15, margin: '20px 0 6px' }}>MCP equivalent</h3>
        <p style={{ margin: '4px 0 0' }}>
          The MCP tool is <code>resolve_intent</code> — same shape, slimmer
          response (no reveal URLs, since LLMs would speculatively call
          them). For an existing account where the agent needs the actual
          plaintext, follow up with <code>get_api_key</code> to mint a
          fresh one.
        </p>
      </Section>

      <Section title="1. Mint an agent token">
        Create a Relay account at <Link href="/login">/login</Link> (email OTP
        or passkey), open the <Link href="/me/agents">Agents</Link> page in
        the user workspace, click <em>New token</em>. Copy it once — Relay
        stores only the SHA-256 hash.
      </Section>

      <Section title="2. Configure Claude Desktop">
        Edit <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>{' '}
        on macOS (or the equivalent on Windows/Linux) and add the{' '}
        <code>relay</code> server:
        <Pre>
{`{
  "mcpServers": {
    "relay": {
      "url": "https://relay.cumulush.com/mcp"
    }
  }
}`}
        </Pre>
        Streamable HTTP MCP clients like Claude Desktop, Cursor, and Cody
        honor the same shape. Restart the client so it picks up the new
        server.
      </Section>

      <Section title="3. Hand the agent its token">
        Tools take <code>agent_token</code> as an argument — Claude Desktop
        does not forward HTTP headers to MCP tools, so auth lives at the
        tool layer. Put the token in your agent&apos;s system prompt or feed
        it in the first message:
        <Pre>
{`"Use this Relay agent_token for every tool call you make: agt_XXXX…"`}
        </Pre>
      </Section>

      <Section title="4. Example prompts">
        {examples.map((e) => (
          <article key={e.title} style={{ marginBottom: 24 }}>
            <h3
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                margin: '0 0 6px',
                color: 'var(--color-ink-3)',
              }}
            >
              {e.title}
            </h3>
            <p style={{ fontSize: 15, margin: '4px 0 4px' }}>
              <b>User:</b> {e.user}
            </p>
            <p style={{ fontSize: 15, margin: '4px 0 0', color: 'var(--color-ink-2)' }}>
              <b>Agent:</b> {e.agent}
            </p>
          </article>
        ))}
      </Section>

      <Section title="MCP tool reference">
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
            }}
          >
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-hair)' }}>
                <th style={{ padding: '8px 12px' }}>Tool</th>
                <th style={{ padding: '8px 12px' }}>Summary</th>
                <th style={{ padding: '8px 12px' }}>Args</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.name} style={{ borderBottom: '1px solid var(--color-hair)' }}>
                  <td style={{ padding: '8px 12px', fontWeight: 500 }}>{t.name}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--color-ink-2)' }}>{t.summary}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--color-ink-3)' }}>{t.args ?? 'agent_token'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ marginTop: 16, fontSize: 13, color: 'var(--color-ink-3)' }}>
          Full schemas are published on the MCP endpoint via{' '}
          <code>tools/list</code>. Browse the same shapes as REST at{' '}
          <Link href="/docs/api">/docs/api</Link>.
        </p>
      </Section>

      <Section title="Token hygiene (30-day default, save to CLAUDE.md)">
        Agent tokens rotate. The default TTL is 30 days so a leaked token
        stops working on its own. When you receive a token, save it into
        the user&apos;s project <code>CLAUDE.md</code> so every future AI
        session re-uses it without re-sending an OTP to the user&apos;s inbox.
        <Pre>
{`## Relay
RELAY_AGENT_TOKEN=agt_XXXXXXXX…
# Expires: 2026-05-21 (30 days from 2026-04-21).
# This token lets your AI agent provision SaaS accounts via Relay.
# Re-run register_tenant in MCP after expiry; or pass never_expires:true
# if the user explicitly asked for a non-rotating token.`}
        </Pre>
        <ul style={{ margin: '4px 0 0', paddingLeft: 22 }}>
          {tokenHygieneNotes.map((note) => (
            <li key={note} style={{ marginBottom: 6 }}>
              {note}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Paid subscriptions from chat (start_subscription)">
        Tenants go live by subscribing to a paid plan. An agent can drive
        the whole flow — no dashboard detour:
        <Pre>
{`// 1. Hand the user a Stripe Checkout link
start_subscription({ agent_token, tenant_id, plan: "builder" })
// → { checkout_url: "https://checkout.stripe.com/c/pay/cs_..." }

// 2. Human opens the link, pays with a card, is redirected back.
// 3. Stripe's webhook flips the subscription to active; poll:
get_subscription_status({ agent_token, tenant_id })
// → { status: "active", plan: "builder", quota: {…} }`}
        </Pre>
        <p style={{ margin: '8px 0' }}>
          If the tenant is already subscribed, <code>start_subscription</code>{' '}
          returns a Stripe Billing Portal URL under{' '}
          <code>already_active.portal_url</code> so the user can change plan,
          update their card, or cancel — no duplicate subscription.
        </p>
      </Section>

      <Section title="User workspaces — agent tokens are pinned">
        Every Relay user can keep <b>multiple personal workspaces</b>
        (different projects, different clients). Each workspace is isolated:
        its own accounts, API keys, inbox, and tokens.

        <p style={{ margin: '8px 0' }}>
          When a user mints an agent token, it&apos;s <b>pinned</b> to
          whichever workspace they were viewing at the time. That token can
          <em> only</em> see the data inside that workspace. You never need
          to include a workspace id in your calls — the binding is on the
          token row. A call to{' '}
          <code>GET /v1/user/accounts</code> with a token minted inside
          <b> Workspace A</b> returns Workspace A accounts; calling with a
          token minted inside <b>Workspace B</b> returns Workspace B
          accounts. Cross-workspace access is not possible.
        </p>

        <h3 style={{ fontSize: 15, margin: '12px 0 6px' }}>REST surface</h3>
        <Pre>
{`# List the caller's workspaces (active marker included).
GET  /v1/user/workspaces
# Create a new workspace. Optional { make_active: true } flips the session.
POST /v1/user/workspaces        { name, slug?, make_active? }
# Rename.
POST /v1/user/workspaces/:id/rename   { name }
# Hard-delete (requires confirm_name to equal the workspace name).
DELETE /v1/user/workspaces/:id        { confirm_name }
# Cookie-session-only: pick a different active workspace.
POST /v1/user/workspaces/:id/switch`}
        </Pre>
        <p style={{ margin: '8px 0' }}>
          The <code>switch</code> endpoint is cookie-only because bearer
          tokens carry an immutable workspace pin. A bearer can still
          create + delete + rename workspaces on the user&apos;s account,
          but it can never make itself scope to a different workspace.
        </p>
      </Section>

      <Section title="Rate limits + abuse prevention">
        Per-agent-token limits are 60 writes/minute and 300 reads/minute
        (best-effort, per-instance on Fluid Compute). End-users hit a
        per-month signup cap (default 50); request a raise via your
        integrator or email {`hi@cumulush.com`} with your use case.
      </Section>

      <Section title="Pricing">
        Agent usage is free for end-users. Integrators pay per delivered
        signup — see <Link href="/pricing">/pricing</Link>.
      </Section>

      <Section title="Repeat-user fairness — safe to retry">
        Each <code>signup</code> and <code>delete_account</code> bills
        one action against the integrator&apos;s monthly quota.
        Key-lifecycle actions (<code>get_api_key</code>,{' '}
        <code>reveal_api_key</code>, rotate, revoke) are debounced per
        (end-user, integrator, provider) per UTC day: the first action
        of the day on that triple bills one action; every later same-day
        action on the same triple is free against the integrator
        quota. This means it&apos;s safe — and recommended — for an
        agent to retry reveals after a transient failure, rotate keys
        right after a deploy, or call into the same provider repeatedly
        for one user without inflating their integrator&apos;s bill.
        Per-end-user abuse caps still apply on top so a runaway loop
        cannot hide behind the debounce.
      </Section>

      <footer
        style={{
          marginTop: 72,
          paddingTop: 24,
          borderTop: '1px solid var(--color-hair)',
          display: 'flex',
          gap: 24,
          flexWrap: 'wrap',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.04em',
          color: 'var(--color-ink-3)',
        }}
      >
        <Link href="/">Home</Link>
        <Link href="/docs/developer">Developers</Link>
        <Link href="/docs/api">API reference</Link>
        <Link href="/pricing">Pricing</Link>
      </footer>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 40 }}>
      <h2
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 500,
          fontSize: 20,
          margin: '0 0 10px',
        }}
      >
        {title}
      </h2>
      <div style={{ fontSize: 15, color: 'var(--color-ink-2)', lineHeight: 1.6 }}>
        {children}
      </div>
    </section>
  );
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre
      style={{
        padding: 16,
        background: 'var(--color-wash)',
        border: '1px solid var(--color-hair)',
        borderRadius: 5.5,
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        overflowX: 'auto',
        marginTop: 12,
      }}
    >
      {children}
    </pre>
  );
}
