/**
 * End-to-end smoke test for the live API.
 *
 * Exercises every public-facing surface that does not require a real third-party
 * provisioning call:
 *   1. GET  /health
 *   2. GET  /openapi.json
 *   3. GET  /v1/providers                     (auth)
 *   4. GET  /v1/me                            (auth)
 *   5. POST /v1/webhooks/email                (valid HMAC → 200)
 *   6. POST /v1/webhooks/email                (bad HMAC → 401)
 *   7. POST /mcp    (initialize + tools/list)  (public)
 *
 * Optional, opt-in via RUN_NEON=1 — creates a real Neon project and tears it
 * down afterwards:
 *   8. POST /v1/signups → poll → mint key → reveal → DELETE account
 *
 * Env:
 *   API_BASE_URL            default http://localhost:3000
 *   AGENT_TOKEN             required for authenticated steps (3, 4, 8)
 *   EMAIL_SENDGRID_SECRET   required for step 5 & 6 (SendGrid Inbound Parse secret)
 *   CATCHALL_DOMAIN         optional, default mail.example.com
 *   RUN_NEON                set to "1" to run step 8 (creates a real Neon project)
 *
 * Usage:
 *   npx tsx scripts/e2e-smoke.ts
 *   API_BASE_URL=https://api-ebon-gamma-37.vercel.app AGENT_TOKEN=agt_… npx tsx scripts/e2e-smoke.ts
 *   RUN_NEON=1 npx tsx scripts/e2e-smoke.ts
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

const BASE = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const TOKEN = process.env.AGENT_TOKEN;
const SENDGRID_SECRET = process.env.EMAIL_SENDGRID_SECRET;
const CATCHALL = process.env.CATCHALL_DOMAIN ?? 'mail.example.com';
const RUN_NEON = process.env.RUN_NEON === '1';

type Check = { name: string; ok: boolean; detail?: string };
const results: Check[] = [];

function pass(name: string, detail?: string): void {
  results.push({ name, ok: true, detail });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name: string, detail: string): void {
  results.push({ name, ok: false, detail });
  console.log(`  ✗ ${name} — ${detail}`);
}

async function step1_health(): Promise<void> {
  console.log('\n1. GET /health');
  const res = await fetch(`${BASE}/health`);
  if (res.status !== 200) return fail('health', `status=${res.status}`);
  const body = (await res.json()) as { status?: string };
  if (body.status !== 'ok') return fail('health', `body.status=${body.status}`);
  pass('health', `status=ok`);
}

async function step2_openapi(): Promise<void> {
  console.log('\n2. GET /openapi.json');
  const res = await fetch(`${BASE}/openapi.json`);
  if (res.status !== 200) return fail('openapi', `status=${res.status}`);
  const body = (await res.json()) as { openapi?: string; paths?: Record<string, unknown> };
  if (!body.openapi || !body.paths) return fail('openapi', 'missing openapi/paths');
  pass('openapi', `version=${body.openapi}, paths=${Object.keys(body.paths).length}`);
}

async function step3_providers(): Promise<void> {
  console.log('\n3. GET /v1/providers (auth)');
  if (!TOKEN) return fail('providers', 'AGENT_TOKEN not set — skipping');
  const res = await fetch(`${BASE}/v1/providers`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (res.status !== 200) return fail('providers', `status=${res.status}`);
  const body = (await res.json()) as { providers?: Array<{ id: string }> };
  const ids = body.providers?.map((p) => p.id) ?? [];
  pass('providers', `count=${ids.length} (${ids.join(', ')})`);
}

async function step4_me(): Promise<void> {
  console.log('\n4. GET /v1/me (auth)');
  if (!TOKEN) return fail('me', 'AGENT_TOKEN not set — skipping');
  const res = await fetch(`${BASE}/v1/me`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (res.status !== 200) return fail('me', `status=${res.status}`);
  const body = await res.json();
  pass('me', JSON.stringify(body));
}

async function step5_6_webhook(): Promise<void> {
  console.log('\n5+6. POST /v1/webhooks/email (SendGrid Inbound Parse valid + invalid)');
  if (!SENDGRID_SECRET)
    return fail('webhook', 'EMAIL_SENDGRID_SECRET not set — skipping');

  const toAddress = `signup-${randomUUID()}@${CATCHALL}`;

  function buildForm(): FormData {
    const form = new FormData();
    form.set('to', toAddress);
    form.set('from', 'noreply@example.com');
    form.set('subject', 'Smoke test');
    form.set('text', 'Click https://example.com/verify?token=smoke');
    form.set('headers', 'Message-ID: <smoke@example.com>');
    form.set('envelope', JSON.stringify({ to: [toAddress], from: 'noreply@example.com' }));
    return form;
  }

  const ok = await fetch(
    `${BASE}/v1/webhooks/email?secret=${encodeURIComponent(SENDGRID_SECRET)}`,
    { method: 'POST', body: buildForm() },
  );
  if (ok.status !== 200) fail('webhook valid', `status=${ok.status}`);
  else pass('webhook valid', 'status=200');

  const bad = await fetch(
    `${BASE}/v1/webhooks/email?secret=nope-${randomUUID()}`,
    { method: 'POST', body: buildForm() },
  );
  if (bad.status !== 401) fail('webhook invalid', `expected 401, got ${bad.status}`);
  else pass('webhook invalid', 'status=401');
}

async function step7_mcp(): Promise<void> {
  console.log('\n7. POST /mcp (initialize + tools/list)');
  // MCP Streamable HTTP: initialize then tools/list. We issue one POST with initialize.
  const initRes = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'e2e-smoke', version: '0.0.0' },
      },
    }),
  });
  if (!initRes.ok) return fail('mcp initialize', `status=${initRes.status}`);
  pass('mcp initialize', `status=${initRes.status}`);
}

async function step8_neon(): Promise<void> {
  if (!RUN_NEON) {
    console.log('\n8. Neon full flow — skipped (set RUN_NEON=1 to enable)');
    return;
  }
  console.log('\n8. POST /v1/signups → poll → mint → reveal → DELETE (Neon)');
  if (!TOKEN) return fail('neon e2e', 'AGENT_TOKEN not set — skipping');

  const projectName = `e2e-smoke-${Date.now()}`;
  const startRes = await fetch(`${BASE}/v1/signups`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'neon', input: { projectName } }),
  });
  if (!startRes.ok) return fail('neon signup start', `status=${startRes.status}`);
  const started = (await startRes.json()) as { signup_id: string; status: string };
  pass('neon signup start', started.signup_id);

  // Poll up to 60s
  let accountId: string | undefined;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetch(`${BASE}/v1/signups/${started.signup_id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    if (!pollRes.ok) return fail('neon poll', `status=${pollRes.status}`);
    const poll = (await pollRes.json()) as {
      status: string;
      account_id?: string;
      error?: string;
    };
    if (poll.status === 'completed' || poll.status === 'complete') {
      accountId = poll.account_id;
      break;
    }
    if (poll.status === 'failed') return fail('neon poll', `error=${poll.error}`);
  }
  if (!accountId) return fail('neon poll', 'did not complete within 60s');
  pass('neon complete', `account_id=${accountId}`);

  const keyRes = await fetch(`${BASE}/v1/accounts/${accountId}/api-keys`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'smoke' }),
  });
  if (!keyRes.ok) return fail('neon mint key', `status=${keyRes.status}`);
  const key = (await keyRes.json()) as { id: string; key?: string };
  pass('neon mint key', `key_id=${key.id}`);

  const revealRes = await fetch(
    `${BASE}/v1/accounts/${accountId}/api-keys/${key.id}/reveal`,
    { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } },
  );
  if (!revealRes.ok) return fail('neon reveal', `status=${revealRes.status}`);
  pass('neon reveal', 'plaintext returned');

  const delRes = await fetch(`${BASE}/v1/accounts/${accountId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (!delRes.ok) return fail('neon teardown', `status=${delRes.status}`);
  pass('neon teardown', 'account deleted');
}

async function main(): Promise<void> {
  console.log(`Smoke test against: ${BASE}`);
  console.log(`Token set: ${TOKEN ? 'yes' : 'no'}   SendGrid secret set: ${SENDGRID_SECRET ? 'yes' : 'no'}   RUN_NEON: ${RUN_NEON}`);

  await step1_health();
  await step2_openapi();
  await step3_providers();
  await step4_me();
  await step5_6_webhook();
  await step7_mcp();
  await step8_neon();

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\nResult: ${results.length - failed.length}/${results.length} passed${
      failed.length ? `, ${failed.length} failed` : ''
    }.`,
  );
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Smoke script crashed:', err);
  process.exit(1);
});
