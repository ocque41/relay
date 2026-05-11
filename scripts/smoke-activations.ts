/**
 * scripts/smoke-activations.ts
 *
 * End-to-end smoke test for the activation tracking loop.
 *
 * 1. Insert a synthetic signup_jobs row owned by the seed tenant, with
 *    handoff_at stamped 2 hours ago.
 * 2. Compute the HMAC signature the @cumulus/track SDK would
 *    produce and POST /v1/activations with valid headers.
 * 3. Re-POST with the same idempotency_key — expect duplicate=true.
 * 4. POST with a busted signature — expect 401.
 * 5. POST with a stale timestamp — expect 400.
 *
 * Required env (read from .env):
 *   DATABASE_URL  RELAY_BASE_URL=http://localhost:3000
 *   TENANT_ID  PUBLIC_ID  SECRET
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';

function loadDotEnv(path: string): void {
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {}
}
loadDotEnv(resolve(process.cwd(), '.env'));

import { db } from '../src/server/db/index';
import { signup_jobs } from '../src/server/db/schema';

const BASE_URL = process.env.RELAY_BASE_URL ?? 'http://localhost:3000';
const TENANT_ID = process.env.TENANT_ID;
const PUBLIC_ID = process.env.PUBLIC_ID;
const SECRET = process.env.SECRET;

if (!TENANT_ID || !PUBLIC_ID || !SECRET) {
  console.error('Set TID, PID, SECRET (from seed-tracking-secret) before running');
  process.exit(2);
}

const TID: string = TENANT_ID;
const PID: string = PUBLIC_ID;
const SEC: string = SECRET;

function sign(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function main(): Promise<void> {
  // 1. Synthetic signup_job with handoff_at 2 hours ago.
  const handoffAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const [job] = await db
    .insert(signup_jobs)
    .values({
      tenant_id: TID,
      provider_slug: 'smoke-test',
      status: 'complete',
      handoff_at: handoffAt,
      credentials_delivered_at: handoffAt,
    })
    .returning({ id: signup_jobs.id });
  console.log(`signup_id=${job.id} handoff_at=${handoffAt.toISOString()}`);

  // 2. Happy-path POST /v1/activations.
  const idempotencyKey = `smoke-${randomUUID()}`;
  const occurredAt = new Date(handoffAt.getTime() + 30 * 60 * 1000).toISOString(); // 30 min after handoff → within 24h
  const body = JSON.stringify({
    signup_id: job.id,
    occurred_at: occurredAt,
    idempotency_key: idempotencyKey,
    event_name: 'authenticated_api_call_succeeded',
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(SEC, ts, body);

  const okRes = await fetch(`${BASE_URL}/v1/activations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-secret-id': PID,
      'x-relay-timestamp': ts,
      'x-relay-signature': sig,
    },
    body,
  });
  console.log(`[1] happy path: ${okRes.status} ${await okRes.text()}`);

  // 3. Duplicate key.
  const ts2 = String(Math.floor(Date.now() / 1000));
  const sig2 = sign(SEC, ts2, body);
  const dupRes = await fetch(`${BASE_URL}/v1/activations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-secret-id': PID,
      'x-relay-timestamp': ts2,
      'x-relay-signature': sig2,
    },
    body,
  });
  console.log(`[2] duplicate idempotency_key: ${dupRes.status} ${await dupRes.text()}`);

  // 4. Bad signature.
  const ts3 = String(Math.floor(Date.now() / 1000));
  const badSig = '0'.repeat(64);
  const badRes = await fetch(`${BASE_URL}/v1/activations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-secret-id': PID,
      'x-relay-timestamp': ts3,
      'x-relay-signature': badSig,
    },
    body,
  });
  console.log(`[3] bad signature: ${badRes.status} ${await badRes.text()}`);

  // 5. Stale timestamp.
  const tsStale = String(Math.floor(Date.now() / 1000) - 7200);
  const sigStale = sign(SEC, tsStale, body);
  const staleRes = await fetch(`${BASE_URL}/v1/activations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-secret-id': PID,
      'x-relay-timestamp': tsStale,
      'x-relay-signature': sigStale,
    },
    body,
  });
  console.log(`[4] stale timestamp: ${staleRes.status} ${await staleRes.text()}`);

  // 6. Verify the row landed correctly.
  console.log('OK if [1]=202 received:true, [2]=202 duplicate:true, [3]=401, [4]=400');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
