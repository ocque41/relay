import Link from 'next/link';
import { Kicker } from '@/app/components/Kicker';
import { Row } from '@/app/components/Row';

const codePadding = {
  padding: 16,
  background: 'var(--color-wash)',
  border: '1px solid var(--color-hair)',
  borderRadius: 5.5,
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  overflowX: 'auto' as const,
};

const inlineCode = {
  padding: '1px 5px',
  background: 'var(--color-wash)',
  borderRadius: 5.5,
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
};

export default function DeveloperDocs() {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '96px 24px 96px',
        display: 'grid',
        gap: 48,
      }}
    >
      <Link
        href="/docs"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: 'var(--color-ink-3)',
        }}
      >
        ← Docs
      </Link>
      <header>
        <Kicker>Developer</Kicker>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 300,
            fontSize: 60,
            lineHeight: 0.95,
            letterSpacing: '-0.035em',
            margin: 0,
          }}
        >
          Developer docs.
        </h1>
        <p
          style={{
            marginTop: 20,
            fontFamily: 'var(--font-display)',
            fontSize: 14,
            color: 'var(--color-ink-2)',
            lineHeight: 1.6,
            maxWidth: 540,
          }}
        >
          Relay is an on-ramp for AI agents. Keep your existing auth. Add one
          webhook. Agents signing users up call Relay, Relay HMAC-signs a POST
          to your webhook, you create the user and return an API key, Relay
          forwards the key to the agent in-chat and forgets it.
        </p>
      </header>

      <Row label="60-second integration">
        1. <code style={inlineCode}>npx create-cumulus@latest my-app</code>
        <br />
        2. Choose the hosted Relay agent-auth mode.
        <br />
        3. Register the product at{' '}
        <Link href="/dev/products">/dev/products</Link>.
        <br />
        4. Copy the webhook secret into <code style={inlineCode}>RELAY_WEBHOOK_SECRET</code>.
        <br />
        5. Fill in <code style={inlineCode}>onSignup</code>. Return{' '}
        <code style={inlineCode}>{'{ accountId, apiKey }'}</code> or{' '}
        <code style={inlineCode}>{'{ accountId, credentials }'}</code>.
        <br />
        6. <code style={inlineCode}>relay scan &lt;slug&gt;</code> verifies reachability + signature enforcement.
      </Row>

      <Row label="Discoverability — show up in the chunked index">
        The canonical category vocabulary is <code style={inlineCode}>database</code>,{' '}
        <code style={inlineCode}>hosting</code>, <code style={inlineCode}>email</code>,{' '}
        <code style={inlineCode}>newsletter</code>, <code style={inlineCode}>auth</code>,{' '}
        <code style={inlineCode}>storage</code>, <code style={inlineCode}>analytics</code>,{' '}
        <code style={inlineCode}>payments</code>, <code style={inlineCode}>cms</code>,{' '}
        <code style={inlineCode}>observability</code>, <code style={inlineCode}>ai</code>,{' '}
        <code style={inlineCode}>search</code>, <code style={inlineCode}>saas</code>.
        During the validation sprint, <code style={inlineCode}>ai</code> and{' '}
        <code style={inlineCode}>database</code> are featured in the public{' '}
        <code style={inlineCode}>/v1/index</code> overview; registration
        still accepts the full vocabulary.
        Supply these when you register:
        <pre style={{ ...codePadding, marginTop: 14 }}>{`POST /v1/dev/products
{
  slug: 'my-product',
  display_name: 'My Product',
  signup_webhook_url: 'https://...',

  // Discoverability
  description: 'One-line of what you do.',
  docs_url: 'https://...',
  homepage: 'https://...',
  npm_package: '@me/sdk',
  categories: ['database'],          // canonical; aliases auto-resolved
  capabilities: ['postgres', 'serverless'],
  pricing_model: 'free-tier',        // free | free-tier | paid | usage-based | freemium
  pricing_url: 'https://.../pricing',
  free_tier_summary: '500MB storage forever.',
}`}</pre>
        Aliases like <code style={inlineCode}>hoster</code> →{' '}
        <code style={inlineCode}>hosting</code> are resolved server-side.
        Unknown categories fail with <code style={inlineCode}>invalid_categories</code>{' '}
        and the full canonical list so your registration script can retry.
        The same fields are accepted by the MCP{' '}
        <code style={inlineCode}>register_tenant_product</code> tool.
      </Row>

      <Row label="Webhook payload">
        Every call carries <code style={inlineCode}>X-Relay-Signature: sha256=&lt;hex&gt;</code> (HMAC
        of the raw body using your secret) and{' '}
        <code style={inlineCode}>X-Relay-Provider: &lt;slug&gt;</code>.
        <pre style={{ ...codePadding, marginTop: 14 }}>{`// kind === 'signup'
{
  kind: 'signup',
  signupId: '<uuid>',
  email: 'user@example.com',
  input: { /* whatever the agent passed */ },
  provider_slug: 'your-slug',
}
// response
{
  accountId: '<your internal id>',
  apiKey: 'plaintext_key',
  externalId?: '<stable id>',
}

// structured handoff response, for providers with multiple credentials
{
  accountId: '<your internal id>',
  credentials: {
    endpoint: 'https://...',
    database_id: 'db_...',
    data_token: '...',
    admin_token: '...'
  },
  externalId?: '<stable id>',
}

// kind === 'create_api_key'
{ kind: 'create_api_key', account_id: '<id>', label: 'key-...' }
// response
{ key: 'plaintext_key', providerKeyId?: '<id>' }

// kind === 'revoke_api_key'
{ kind: 'revoke_api_key', account_id: '<id>', key_id: '<id>' }

// kind === 'teardown'
{ kind: 'teardown', account_id: '<id>' }`}</pre>
      </Row>

      <Row label="Zero retention">
        Relay does <strong>not</strong> persist third-party API keys. Your
        webhook returns the plaintext once; Relay hands it straight back to the
        calling agent and only retains a bookkeeping row (alias + your{' '}
        <code style={inlineCode}>providerKeyId</code>) so future revocations
        have a handle.
      </Row>

      <Row label="CLI">
        <code style={inlineCode}>relay products</code> — list tenant products + this-week counters
        <br />
        <code style={inlineCode}>relay products rotate &lt;slug&gt;</code> — rotate webhook secret
        <br />
        <code style={inlineCode}>relay stats</code> — weekly status rollup
        <br />
        <code style={inlineCode}>relay users</code> — end-users who signed up
        <br />
        <code style={inlineCode}>relay logs</code> — recent signup_jobs
        <br />
        <code style={inlineCode}>relay scan &lt;slug&gt;</code> — reachability + signature check
      </Row>

      <Row label="Rate limits">
        Per-token fixed-window best-effort limits apply to{' '}
        <code style={inlineCode}>/v1/*</code> writes (~60/min) and reads
        (~300/min). The ceiling is per serverless instance rather than
        globally synchronized — true traffic can burst N × the limit across
        N warm instances. It&apos;s a safety net against runaway loops, not
        a hard global quota.
      </Row>

      <Row label="What does Relay cost during the founding-partner phase?">
        One offer: <Link href="/pricing">$2,500 prepaid for a 30-day
        founding partner sprint</Link>. Renewal at $2,500/month,
        month-to-month, decided after the day-30 cohort report. End-users
        pay nothing. There are no per-action meters, tiers, or credit
        packs surfaced during this phase — those mechanics exist in the
        codebase but are dormant while we&apos;re still proving the
        channel with a small handful of integrators.
        <br />
        <br />
        Operational guardrails are still in place to protect both sides:
        a per-end-user signup soft cap (50/month), a per-end-user action
        soft cap (200/month), and the per-instance rate limits on the
        Relay API itself (60 writes/min, 300 reads/min). Read-only
        operations (list accounts, fetch status, browse the catalog) are
        never billed. None of these are sales surfaces — they exist
        purely to keep a runaway agent from causing damage.
      </Row>

      <Row label="The decision — should I integrate with Relay?">
        Use Relay when you want AI agents to be able to onboard your
        end-users into your product without you building the
        agent-side wiring yourself. You keep your own auth (Supabase,
        Clerk, your own session table — anything) and your own user
        records; Relay only vouches for identity and brokers the
        agent-callable signup endpoint your existing webhook handles.
        Pricing is fully integrator-paid: end-users see no card, no
        meter, no upgrade prompt. Your only ongoing cost is the
        monthly action quota you choose at{' '}
        <Link href="/pricing">/pricing</Link>. The fairness debounce
        means you can plan capacity from total monthly{' '}
        <em>onboardings + key-lifecycle days</em>, not from raw call
        volume — much easier to forecast.
      </Row>

      <Row label="Provider note: Neon revoke">
        Neon does not expose a way to revoke a single connection URI.
        When you call <code style={inlineCode}>revoke</code> on a Neon
        key, Relay updates its own state but cannot invalidate the
        connection string at the provider — to truly revoke access, reset
        the project&apos;s database password through the Neon Console or
        the Neon Management API. Other providers (Vercel, Resend,
        tenant-defined products) revoke server-side as expected.
      </Row>

      <Row label="Delete a workspace">
        When you no longer need a developer workspace you can delete it from{' '}
        <Link href="/dev/settings">/dev/settings</Link> → <b>Danger zone</b>.
        Only the workspace owner sees the option. You&apos;ll be asked to type
        the workspace name to confirm — once submitted, the deletion is
        immediate and cannot be undone.
        <br />
        <br />
        Deleting a workspace <b>permanently removes</b> every team member,
        registered product, feature flag, integrator key, and subscription
        history tied to it. End-user account rows and signup history are{' '}
        <b>kept</b>, but they lose their link to this workspace.
        <br />
        <br />
        If you have a live subscription, cancel it first at{' '}
        <Link href="/dev/billing">/dev/billing</Link>. Relay blocks
        deletion while Stripe considers the workspace <code style={inlineCode}>trialing</code>,{' '}
        <code style={inlineCode}>active</code>, or{' '}
        <code style={inlineCode}>past_due</code> to protect against
        accidental loss of billing state.
      </Row>

      <Row label="Reference">
        <Link href="/docs/api">OpenAPI / Swagger UI →</Link>
        <br />
        <Link href="/openapi.json">Raw spec →</Link>
      </Row>
    </main>
  );
}
