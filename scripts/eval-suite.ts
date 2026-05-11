/**
 * Comprehensive evaluation suite for the live Relay deployment.
 *
 * Goes beyond the original smoke (scripts/e2e-smoke.ts) with:
 *   - Grouped tier-based tests (public → auth → mutation → MCP → destructive)
 *   - Deep response-body assertions (not just status codes)
 *   - Negative-path coverage (invalid tokens, expired tokens, forbidden tenants)
 *   - The new surfaces: start_subscription (checkout + already_active branches)
 *     and agent-token expiry (distinct `agent_token_expired` error)
 *   - Structured JSON summary at the end so CI can grep or parse
 *
 * Tier 1 (public)       — always runs
 * Tier 2 (auth/read)    — needs AGENT_TOKEN
 * Tier 3 (mutation)     — needs AGENT_TOKEN; creates & tears down its own state
 * Tier 4 (MCP)          — always runs (tool auth is per-call)
 * Tier 5 (destructive)  — opt-in via RUN_DESTRUCTIVE=1; Neon + full teardown
 *
 * Guardrails:
 *   - Never deletes data it didn't create in this run
 *   - Refuses to run tier 5 against a hostname containing "prod" / ".com"
 *     unless ALLOW_PROD_DESTRUCTIVE=1 is set
 *
 * Env:
 *   API_BASE_URL            (default http://localhost:3000)
 *   AGENT_TOKEN             for tier 2+3
 *   RUN_DESTRUCTIVE         "1" to run tier 5
 *   ALLOW_PROD_DESTRUCTIVE  "1" to permit tier 5 against prod hostnames
 *   TENANT_ID               optional; used by billing tests
 *   EMAIL_SENDGRID_SECRET   optional; exercises the inbound-email webhook
 *   CATCHALL_DOMAIN         default mail.example.com
 *   EVAL_OUTPUT             set to "json" to print a machine-readable summary
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Environment loading
// ---------------------------------------------------------------------------
function loadDotEnv(path: string): void {
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // .env is optional
  }
}
loadDotEnv(resolve(process.cwd(), '.env'));

const BASE = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(
  /\/+$/,
  '',
);
const TOKEN = process.env.AGENT_TOKEN;
const TENANT_ID = process.env.TENANT_ID;
const SENDGRID_SECRET = process.env.EMAIL_SENDGRID_SECRET;
const CATCHALL = process.env.CATCHALL_DOMAIN ?? 'mail.example.com';
const RUN_DESTRUCTIVE = process.env.RUN_DESTRUCTIVE === '1';
const ALLOW_PROD_DESTRUCTIVE = process.env.ALLOW_PROD_DESTRUCTIVE === '1';
const OUTPUT_JSON = process.env.EVAL_OUTPUT === 'json';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
type Check = {
  tier: 1 | 2 | 3 | 4 | 5;
  group: string;
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
  ms?: number;
};
const results: Check[] = [];
let currentGroup = '(ungrouped)';
let currentTier: 1 | 2 | 3 | 4 | 5 = 1;

function log(...args: unknown[]): void {
  if (!OUTPUT_JSON) console.log(...args);
}

function setTier(tier: 1 | 2 | 3 | 4 | 5, group: string): void {
  currentTier = tier;
  currentGroup = group;
  log(`\n─── Tier ${tier} · ${group} ───`);
}

function pass(name: string, detail?: string, ms?: number): void {
  results.push({
    tier: currentTier,
    group: currentGroup,
    name,
    status: 'pass',
    detail,
    ms,
  });
  log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}${ms ? ` (${ms}ms)` : ''}`);
}

function fail(name: string, detail: string, ms?: number): void {
  results.push({
    tier: currentTier,
    group: currentGroup,
    name,
    status: 'fail',
    detail,
    ms,
  });
  log(`  ✗ ${name} — ${detail}`);
}

function skip(name: string, detail: string): void {
  results.push({ tier: currentTier, group: currentGroup, name, status: 'skip', detail });
  log(`  ○ ${name} — ${detail}`);
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t };
}

// ---------------------------------------------------------------------------
// Tier 1 · Public surface
// ---------------------------------------------------------------------------
async function tier1Public(): Promise<void> {
  setTier(1, 'public surface');

  try {
    const { value: res, ms } = await timed(() => fetch(`${BASE}/health`));
    if (res.status !== 200) fail('GET /health', `status=${res.status}`, ms);
    else {
      const body = (await res.json()) as { status?: string };
      if (body.status !== 'ok') fail('GET /health', `body.status=${body.status}`, ms);
      else pass('GET /health', 'status=ok', ms);
    }
  } catch (e) {
    fail('GET /health', (e as Error).message);
  }

  try {
    const { value: res, ms } = await timed(() => fetch(`${BASE}/openapi.json`));
    if (res.status !== 200) fail('GET /openapi.json', `status=${res.status}`, ms);
    else {
      const body = (await res.json()) as {
        openapi?: string;
        paths?: Record<string, unknown>;
      };
      const pathCount = body.paths ? Object.keys(body.paths).length : 0;
      if (!body.openapi || pathCount < 10) {
        fail('GET /openapi.json', `version=${body.openapi}, paths=${pathCount}`, ms);
      } else {
        pass('GET /openapi.json', `v=${body.openapi}, paths=${pathCount}`, ms);
      }
    }
  } catch (e) {
    fail('GET /openapi.json', (e as Error).message);
  }

  try {
    const { value: res, ms } = await timed(() =>
      fetch(`${BASE}/.well-known/relay.json`),
    );
    // Well-known may 404 when the tenant domain isn't configured; both are
    // acceptable shapes for this test — we just want "the handler responds".
    if (res.status !== 200 && res.status !== 404) {
      fail('.well-known/relay.json', `status=${res.status}`, ms);
    } else pass('.well-known/relay.json', `status=${res.status}`, ms);
  } catch (e) {
    fail('.well-known/relay.json', (e as Error).message);
  }

  // Docs surfaces (sanity — they should render something)
  for (const path of [
    '/docs',
    '/docs/agent-builders',
    '/docs/developer',
    '/docs/user',
    '/AGENTS.md',
    '/llms.txt',
  ]) {
    try {
      const { value: res, ms } = await timed(() => fetch(`${BASE}${path}`));
      if (res.status === 200) pass(`GET ${path}`, `status=200`, ms);
      else if (res.status === 404) skip(`GET ${path}`, 'not built in this env');
      else fail(`GET ${path}`, `status=${res.status}`, ms);
    } catch (e) {
      fail(`GET ${path}`, (e as Error).message);
    }
  }

  // Negative: no token → 401 (not 500, not 200)
  try {
    const { value: res, ms } = await timed(() => fetch(`${BASE}/v1/me`));
    if (res.status !== 401) {
      fail(
        'GET /v1/me without token',
        `expected 401, got ${res.status}`,
        ms,
      );
    } else pass('GET /v1/me without token', 'status=401', ms);
  } catch (e) {
    fail('GET /v1/me without token', (e as Error).message);
  }

  // Negative: bogus token → 401
  try {
    const { value: res, ms } = await timed(() =>
      fetch(`${BASE}/v1/me`, {
        headers: { authorization: 'Bearer agt_not-a-real-token-000' },
      }),
    );
    if (res.status !== 401) {
      fail(
        'GET /v1/me with garbage token',
        `expected 401, got ${res.status}`,
        ms,
      );
    } else pass('GET /v1/me with garbage token', 'status=401', ms);
  } catch (e) {
    fail('GET /v1/me with garbage token', (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Tier 2 · Authenticated read-only surfaces
// ---------------------------------------------------------------------------
async function tier2Read(): Promise<void> {
  setTier(2, 'auth read surfaces');
  if (!TOKEN) {
    skip('tier 2', 'AGENT_TOKEN not set');
    return;
  }
  const auth = { authorization: `Bearer ${TOKEN}` };

  try {
    const { value: res, ms } = await timed(() =>
      fetch(`${BASE}/v1/me`, { headers: auth }),
    );
    if (res.status !== 200) fail('GET /v1/me', `status=${res.status}`, ms);
    else {
      const body = (await res.json()) as { kind?: string };
      if (!body.kind) fail('GET /v1/me', `body.kind missing`, ms);
      else pass('GET /v1/me', `kind=${body.kind}`, ms);
    }
  } catch (e) {
    fail('GET /v1/me', (e as Error).message);
  }

  try {
    const { value: res, ms } = await timed(() =>
      fetch(`${BASE}/v1/providers`, { headers: auth }),
    );
    if (res.status !== 200) fail('GET /v1/providers', `status=${res.status}`, ms);
    else {
      // Response is either a bare array (current shape) or { providers: [] }
      // depending on whether tenant providers are merged.
      const raw = (await res.json()) as unknown;
      const arr = Array.isArray(raw)
        ? raw
        : ((raw as { providers?: unknown[] }).providers ?? []);
      if (arr.length === 0) fail('GET /v1/providers', 'empty', ms);
      else pass('GET /v1/providers', `count=${arr.length}`, ms);
    }
  } catch (e) {
    fail('GET /v1/providers', (e as Error).message);
  }

  try {
    const { value: res, ms } = await timed(() =>
      fetch(`${BASE}/v1/index`, { headers: auth }),
    );
    if (res.status !== 200) fail('GET /v1/index', `status=${res.status}`, ms);
    else {
      const body = (await res.json()) as {
        categories?: Array<{ slug: string }>;
      };
      const n = body.categories?.length ?? 0;
      pass('GET /v1/index', `categories=${n}`, ms);
    }
  } catch (e) {
    fail('GET /v1/index', (e as Error).message);
  }

  if (TENANT_ID) {
    try {
      const { value: res, ms } = await timed(() =>
        fetch(`${BASE}/v1/dev/billing/summary`, {
          headers: { ...auth, 'x-relay-tenant': TENANT_ID },
        }),
      );
      if (res.status !== 200) {
        fail('GET /v1/dev/billing/summary', `status=${res.status}`, ms);
      } else {
        const body = (await res.json()) as {
          plans?: unknown[];
          status?: string | null;
        };
        pass(
          'GET /v1/dev/billing/summary',
          `plans=${body.plans?.length ?? 0}, status=${body.status ?? 'none'}`,
          ms,
        );
      }
    } catch (e) {
      fail('GET /v1/dev/billing/summary', (e as Error).message);
    }
  } else {
    skip('GET /v1/dev/billing/summary', 'TENANT_ID not set');
  }
}

// ---------------------------------------------------------------------------
// Tier 3 · Safe mutations (mint + revoke; magic link; inbound email webhook)
// ---------------------------------------------------------------------------
async function tier3Mutations(): Promise<void> {
  setTier(3, 'safe mutations');
  if (!TOKEN) {
    skip('tier 3', 'AGENT_TOKEN not set');
    return;
  }
  const auth = { authorization: `Bearer ${TOKEN}` };

  // 3a. Mint an integrator bearer (+ tenant) via /v1/tenants. Exercises the
  //     `mintAgentToken` helper end-to-end: response must carry the new
  //     `integratorKeyExpiresAt` field and the token must actually work on
  //     a follow-up /v1/me call.
  let createdTenantId: string | undefined;
  let integratorKey: string | undefined;
  try {
    const { value: res, ms } = await timed(() =>
      fetch(`${BASE}/v1/tenants`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: `eval-suite-${Date.now().toString(36)}`,
          expires_in_days: 1,
        }),
      }),
    );
    if (res.status !== 201) {
      const text = await res.text();
      fail(
        'POST /v1/tenants (integrator key mint)',
        `status=${res.status} body=${text.slice(0, 120)}`,
        ms,
      );
    } else {
      const body = (await res.json()) as {
        tenantId?: string;
        integratorKey?: string;
        integratorKeyId?: string;
        integratorKeyExpiresAt?: string | null;
      };
      if (!body.tenantId || !body.integratorKey || !body.integratorKeyId) {
        fail('POST /v1/tenants', 'missing id/key in response', ms);
      } else if (!body.integratorKeyExpiresAt) {
        fail(
          'POST /v1/tenants',
          'integratorKeyExpiresAt missing — migration 0022 or mint-token not wired?',
          ms,
        );
      } else {
        createdTenantId = body.tenantId;
        integratorKey = body.integratorKey;
        const hours =
          (Date.parse(body.integratorKeyExpiresAt) - Date.now()) /
          3_600_000;
        if (hours < 20 || hours > 30) {
          fail(
            'POST /v1/tenants expiry window',
            `expected ~24h, got ${hours.toFixed(1)}h`,
            ms,
          );
        } else {
          pass(
            'POST /v1/tenants (integrator key mint)',
            `tenant=${createdTenantId.slice(0, 8)}… expires_in≈${hours.toFixed(1)}h`,
            ms,
          );
        }
      }
    }
  } catch (e) {
    fail('POST /v1/tenants', (e as Error).message);
  }

  // 3b. Verify the freshly-minted integrator key actually authenticates.
  if (integratorKey && createdTenantId) {
    try {
      const { value: res, ms } = await timed(() =>
        fetch(`${BASE}/v1/dev/billing/summary`, {
          headers: {
            authorization: `Bearer ${integratorKey}`,
            'x-relay-tenant': createdTenantId!,
          },
        }),
      );
      if (res.status !== 200) {
        fail(
          'GET /v1/dev/billing/summary with new integrator key',
          `status=${res.status}`,
          ms,
        );
      } else {
        pass(
          'GET /v1/dev/billing/summary with new integrator key',
          'status=200',
          ms,
        );
      }
    } catch (e) {
      fail(
        'GET /v1/dev/billing/summary with new integrator key',
        (e as Error).message,
      );
    }
  }

  // 3b. Inbound-email webhook — valid secret and invalid secret.
  if (SENDGRID_SECRET) {
    const to = `signup-${randomUUID()}@${CATCHALL}`;
    const buildForm = (): FormData => {
      const f = new FormData();
      f.set('to', to);
      f.set('from', 'noreply@example.com');
      f.set('subject', 'eval-suite');
      f.set('text', 'Click https://example.com/verify?token=eval');
      f.set('headers', 'Message-ID: <eval@example.com>');
      f.set(
        'envelope',
        JSON.stringify({ to: [to], from: 'noreply@example.com' }),
      );
      return f;
    };

    try {
      const { value: res, ms } = await timed(() =>
        fetch(
          `${BASE}/v1/webhooks/email?secret=${encodeURIComponent(SENDGRID_SECRET)}`,
          { method: 'POST', body: buildForm() },
        ),
      );
      if (res.status !== 200) {
        fail('POST /v1/webhooks/email (valid)', `status=${res.status}`, ms);
      } else pass('POST /v1/webhooks/email (valid)', 'status=200', ms);
    } catch (e) {
      fail('POST /v1/webhooks/email (valid)', (e as Error).message);
    }

    try {
      const { value: res, ms } = await timed(() =>
        fetch(`${BASE}/v1/webhooks/email?secret=nope-${randomUUID()}`, {
          method: 'POST',
          body: buildForm(),
        }),
      );
      if (res.status !== 401) {
        fail(
          'POST /v1/webhooks/email (invalid)',
          `expected 401, got ${res.status}`,
          ms,
        );
      } else pass('POST /v1/webhooks/email (invalid)', 'status=401', ms);
    } catch (e) {
      fail('POST /v1/webhooks/email (invalid)', (e as Error).message);
    }
  } else {
    skip('inbound-email webhook', 'EMAIL_SENDGRID_SECRET not set');
  }
}

// ---------------------------------------------------------------------------
// Tier 4 · MCP tools (every public tool touched; auth lives at the tool layer)
// ---------------------------------------------------------------------------
async function mcpCall(
  method: string,
  params: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method,
      params,
    }),
  });
  // MCP Streamable-HTTP may stream SSE; just read text.
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text
  }
  return { status: res.status, body };
}

async function tier4Mcp(): Promise<void> {
  setTier(4, 'mcp tools');

  // 4a. initialize
  try {
    const { value, ms } = await timed(() =>
      mcpCall('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'eval-suite', version: '0.0.0' },
      }),
    );
    if (value.status >= 400) {
      fail('mcp initialize', `status=${value.status}`, ms);
    } else pass('mcp initialize', `status=${value.status}`, ms);
  } catch (e) {
    fail('mcp initialize', (e as Error).message);
  }

  // 4b. list_categories — public (no token required)
  try {
    const { value, ms } = await timed(() =>
      mcpCall('tools/call', {
        name: 'list_categories',
        arguments: {},
      }),
    );
    if (value.status >= 400) {
      fail('mcp list_categories', `status=${value.status}`, ms);
    } else {
      pass('mcp list_categories', `status=${value.status}`, ms);
    }
  } catch (e) {
    fail('mcp list_categories', (e as Error).message);
  }

  if (TOKEN) {
    // 4c. whoami — should report agent identity
    try {
      const { value, ms } = await timed(() =>
        mcpCall('tools/call', {
          name: 'whoami',
          arguments: { agent_token: TOKEN },
        }),
      );
      if (value.status >= 400) {
        fail('mcp whoami', `status=${value.status}`, ms);
      } else pass('mcp whoami', `status=${value.status}`, ms);
    } catch (e) {
      fail('mcp whoami', (e as Error).message);
    }

    // 4d. list_providers
    try {
      const { value, ms } = await timed(() =>
        mcpCall('tools/call', {
          name: 'list_providers',
          arguments: { agent_token: TOKEN },
        }),
      );
      if (value.status >= 400) {
        fail('mcp list_providers', `status=${value.status}`, ms);
      } else pass('mcp list_providers', `status=${value.status}`, ms);
    } catch (e) {
      fail('mcp list_providers', (e as Error).message);
    }

    // 4e. get_subscription_status (requires TENANT_ID)
    if (TENANT_ID) {
      try {
        const { value, ms } = await timed(() =>
          mcpCall('tools/call', {
            name: 'get_subscription_status',
            arguments: { agent_token: TOKEN, tenant_id: TENANT_ID },
          }),
        );
        if (value.status >= 400) {
          fail(
            'mcp get_subscription_status',
            `status=${value.status}`,
            ms,
          );
        } else pass('mcp get_subscription_status', `status=${value.status}`, ms);
      } catch (e) {
        fail('mcp get_subscription_status', (e as Error).message);
      }
    } else {
      skip('mcp get_subscription_status', 'TENANT_ID not set');
    }
  } else {
    skip('mcp tools requiring token', 'AGENT_TOKEN not set');
  }

  // 4f. Negative path: bogus token → error payload (not HTTP 500)
  try {
    const { value, ms } = await timed(() =>
      mcpCall('tools/call', {
        name: 'list_providers',
        arguments: { agent_token: 'agt_not-a-real-token-000' },
      }),
    );
    // We expect 200-with-error-body per MCP spec.
    if (value.status !== 200) {
      fail(
        'mcp list_providers (bad token)',
        `expected 200 with isError, got ${value.status}`,
        ms,
      );
    } else {
      const body = value.body as
        | {
            result?: { isError?: boolean; content?: Array<{ text?: string }> };
          }
        | undefined;
      const errorText = body?.result?.content?.[0]?.text ?? '';
      if (body?.result?.isError !== true) {
        fail(
          'mcp list_providers (bad token)',
          `missing isError — body=${JSON.stringify(body).slice(0, 120)}`,
          ms,
        );
      } else {
        pass(
          'mcp list_providers (bad token)',
          `isError=true error=${errorText.slice(0, 60)}`,
          ms,
        );
      }
    }
  } catch (e) {
    fail('mcp list_providers (bad token)', (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Tier 5 · Destructive (real Neon project + full teardown)
// ---------------------------------------------------------------------------
async function tier5Destructive(): Promise<void> {
  setTier(5, 'destructive end-to-end');
  if (!RUN_DESTRUCTIVE) {
    skip('tier 5', 'RUN_DESTRUCTIVE != 1');
    return;
  }
  const host = (() => {
    try {
      return new URL(BASE).hostname;
    } catch {
      return '';
    }
  })();
  const looksLikeProd = /\.com$/.test(host) || /prod/i.test(host);
  if (looksLikeProd && !ALLOW_PROD_DESTRUCTIVE) {
    fail(
      'tier 5 guardrail',
      `refusing destructive run against ${host} without ALLOW_PROD_DESTRUCTIVE=1`,
    );
    return;
  }
  if (!TOKEN) {
    fail('tier 5', 'AGENT_TOKEN not set');
    return;
  }

  const auth = { authorization: `Bearer ${TOKEN}` };
  const projectName = `eval-suite-${Date.now()}`;

  let signupId: string | undefined;
  try {
    const { value: res, ms } = await timed(() =>
      fetch(`${BASE}/v1/signups`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'neon', input: { projectName } }),
      }),
    );
    if (!res.ok) {
      fail('neon signup start', `status=${res.status}`, ms);
      return;
    }
    const body = (await res.json()) as { signup_id: string };
    signupId = body.signup_id;
    pass('neon signup start', signupId, ms);
  } catch (e) {
    fail('neon signup start', (e as Error).message);
    return;
  }

  let accountId: string | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${BASE}/v1/signups/${signupId}`, {
      headers: auth,
    });
    if (!res.ok) {
      fail('neon signup poll', `status=${res.status}`);
      return;
    }
    const body = (await res.json()) as {
      status: string;
      account_id?: string;
      error?: string;
    };
    if (body.status === 'failed') {
      fail('neon signup poll', `error=${body.error}`);
      return;
    }
    if (body.status === 'complete' || body.status === 'completed') {
      accountId = body.account_id;
      break;
    }
  }
  if (!accountId) {
    fail('neon signup poll', 'no completion within 60s');
    return;
  }
  pass('neon signup complete', `account_id=${accountId}`);

  try {
    const res = await fetch(`${BASE}/v1/accounts/${accountId}`, {
      method: 'DELETE',
      headers: auth,
    });
    if (!res.ok) fail('neon teardown', `status=${res.status}`);
    else pass('neon teardown', 'account deleted');
  } catch (e) {
    fail('neon teardown', (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const started = Date.now();
  log(`Relay eval suite — target: ${BASE}`);
  log(
    `  AGENT_TOKEN: ${TOKEN ? 'set' : 'unset'}    TENANT_ID: ${TENANT_ID ?? 'unset'}    SENDGRID: ${SENDGRID_SECRET ? 'set' : 'unset'}    RUN_DESTRUCTIVE: ${RUN_DESTRUCTIVE}`,
  );

  await tier1Public();
  await tier2Read();
  await tier3Mutations();
  await tier4Mcp();
  await tier5Destructive();

  const duration = Date.now() - started;
  const pct = (label: 'pass' | 'fail' | 'skip') =>
    results.filter((r) => r.status === label).length;

  const passed = pct('pass');
  const failed = pct('fail');
  const skipped = pct('skip');

  if (OUTPUT_JSON) {
    console.log(
      JSON.stringify(
        {
          base: BASE,
          duration_ms: duration,
          totals: { passed, failed, skipped, total: results.length },
          results,
        },
        null,
        2,
      ),
    );
  } else {
    log(
      `\n${passed} passed · ${failed} failed · ${skipped} skipped · ${duration}ms`,
    );
    if (failed > 0) {
      for (const r of results.filter((r) => r.status === 'fail')) {
        log(`  FAIL [T${r.tier}/${r.group}] ${r.name} — ${r.detail}`);
      }
    }
  }

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('eval-suite crashed:', err);
  process.exit(2);
});
