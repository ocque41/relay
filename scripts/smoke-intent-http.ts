/**
 * HTTP-level smoke test for /v1/intent.
 *
 * Picks a real user + workspace + agent token from the DB, hits the live
 * dev server with both bearer + body, and asserts the response contract.
 * This is the end-to-end check that proves bearerAuth + writeRateLimit +
 * the OpenAPI Zod parser + the route handler all line up correctly.
 */
import { db } from '../src/server/db/index';
import { sql } from 'drizzle-orm';
import { mintAgentToken } from '../src/server/auth/mint-token';
import { signup_jobs, intent_resolutions } from '../src/server/db/schema';

const BASE_URL = process.env.HTTP_SMOKE_BASE ?? 'http://localhost:3000';

function pass(name: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}
function fail(name: string, detail: string): never {
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
  process.exit(1);
}

async function main() {
  console.log(`[setup] HTTP smoke against ${BASE_URL}`);

  // Pick a user with a workspace, mint a fresh agent token for them.
  const r = await db.execute(sql`
    SELECT u.id AS user_id, w.id AS workspace_id
    FROM users u
    JOIN user_workspaces w ON w.user_id = u.id
    LIMIT 1
  `);
  if (r.rows.length === 0) fail('setup', 'no user+workspace in DB');
  const { user_id: userId, workspace_id: workspaceId } = r.rows[0] as {
    user_id: string;
    workspace_id: string;
  };
  console.log(`[setup]   user=${userId.slice(0, 8)} ws=${workspaceId.slice(0, 8)}`);

  const minted = await mintAgentToken({
    userId,
    userWorkspaceId: workspaceId,
    label: 'smoke-intent-http',
    scopes: [],
    expiry: { days: 1 },
  });
  const token = minted.token;
  const agentId = minted.agentId;
  console.log(`[setup]   agent=${agentId.slice(0, 8)} token=${token.slice(0, 12)}...`);

  // ---- Test 1: 401 without bearer ---------------------------------------
  const noAuth = await fetch(`${BASE_URL}/v1/intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal: 'postgres', workspaceId }),
  });
  if (noAuth.status !== 401) fail('401 without bearer', `got ${noAuth.status}`);
  pass('401 without bearer token');

  // ---- Test 2: 200 with valid bearer + body ----------------------------
  const ok = await fetch(`${BASE_URL}/v1/intent`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      goal: 'postgres + transactional email for a Next.js app',
      workspaceId,
    }),
  });
  if (ok.status !== 200) {
    const body = await ok.text();
    fail('200 with valid body', `status=${ok.status} body=${body}`);
  }
  pass('200 with valid bearer + body');

  const body = (await ok.json()) as {
    resolutions: Array<{
      category: string;
      provider: string;
      status: string;
      envVar?: string;
      accountId?: string;
      signupJobId?: string;
    }>;
    envBlock: string;
    pending: string[];
    unsatisfied: Array<{ category: string; reason: string }>;
    unmatchedTerms: string[];
    notes: string[];
  };

  const dbRes = body.resolutions.find((x) => x.category === 'database');
  if (!dbRes) fail('database resolution exists', JSON.stringify(body));
  if (dbRes.provider !== 'neon') fail('database → neon', `got ${dbRes.provider}`);
  pass(`database resolution → neon (status=${dbRes.status})`);

  const emailRes = body.resolutions.find((x) => x.category === 'email');
  if (!emailRes) fail('email resolution exists', JSON.stringify(body));
  if (emailRes.provider !== 'resend') fail('email → resend', `got ${emailRes.provider}`);
  pass(`email resolution → resend (status=${emailRes.status})`);

  if (!body.envBlock.includes('DATABASE_URL=')) {
    fail('envBlock contains DATABASE_URL line', body.envBlock);
  }
  if (!body.envBlock.includes('RESEND_API_KEY=')) {
    fail('envBlock contains RESEND_API_KEY line', body.envBlock);
  }
  pass('envBlock contains DATABASE_URL + RESEND_API_KEY');

  // ---- Test 3: 400 on unsupported envStyle -----------------------------
  const badStyle = await fetch(`${BASE_URL}/v1/intent`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ goal: 'postgres', workspaceId, envStyle: 'next' }),
  });
  if (badStyle.status !== 400) fail('400 on bad envStyle', `got ${badStyle.status}`);
  const badStyleBody = (await badStyle.json()) as { error: string };
  if (!badStyleBody.error.includes('envStyle')) {
    fail('400 error mentions envStyle', JSON.stringify(badStyleBody));
  }
  pass(`400 on envStyle="next" with friendly error`);

  // ---- Test 4: 404 on unknown workspaceId ------------------------------
  const badWs = await fetch(`${BASE_URL}/v1/intent`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      goal: 'postgres',
      workspaceId: 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee',
    }),
  });
  if (badWs.status !== 404) fail('404 on unknown workspaceId', `got ${badWs.status}`);
  pass('404 on unknown workspaceId');

  // ---- Test 5: Idempotency-Key cache replay ----------------------------
  const idemKey = `smoke-${Date.now()}`;
  const first = await fetch(`${BASE_URL}/v1/intent`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idemKey,
    },
    body: JSON.stringify({ goal: 'postgres', workspaceId }),
  });
  if (first.status !== 200) fail('idempotency first call 200', `got ${first.status}`);
  const firstBody = (await first.json()) as {
    pending: string[];
    resolutions: Array<{ signupJobId?: string; category: string }>;
  };

  const replay = await fetch(`${BASE_URL}/v1/intent`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idemKey,
    },
    // Different goal — if the cache works, the response should still match
    // the first call's resolution (no fresh signup spawned).
    body: JSON.stringify({ goal: 'completely different', workspaceId }),
  });
  if (replay.status !== 200) fail('idempotency replay 200', `got ${replay.status}`);
  const replayBody = (await replay.json()) as {
    pending: string[];
    resolutions: Array<{ signupJobId?: string; category: string }>;
  };

  // Strong signal: same signup_job_id IDs → no new signup was kicked.
  const firstJobs = firstBody.pending.slice().sort();
  const replayJobs = replayBody.pending.slice().sort();
  if (JSON.stringify(firstJobs) !== JSON.stringify(replayJobs)) {
    console.log('  first.pending:  ', firstJobs);
    console.log('  replay.pending: ', replayJobs);
    fail(
      'idempotency replay reuses the same signup_job_ids',
      `first ≠ replay (cache miss)`,
    );
  }
  // And the resolution shape (categories present) must match — proves the
  // cached body was returned, not a fresh resolution of the new goal.
  const firstCats = firstBody.resolutions.map((r) => r.category).sort();
  const replayCats = replayBody.resolutions.map((r) => r.category).sort();
  if (JSON.stringify(firstCats) !== JSON.stringify(replayCats)) {
    fail(
      'idempotency replay returns same categories',
      `first=${firstCats} replay=${replayCats}`,
    );
  }
  pass('Idempotency-Key replay returns cached body (no duplicate signups)');

  // ---- Cleanup ---------------------------------------------------------
  console.log('[teardown] removing artifacts');
  await db.execute(sql`
    DELETE FROM intent_resolutions WHERE agent_id = ${agentId}
  `);
  await db.execute(sql`
    DELETE FROM signup_jobs WHERE calling_agent_id = ${agentId}
  `);
  await db.execute(sql`
    UPDATE agents SET revoked_at = NOW() WHERE id = ${agentId}
  `);

  console.log('\n\x1b[32mall HTTP smoke checks passed.\x1b[0m');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n\x1b[31mHTTP smoke failed:\x1b[0m', e);
    process.exit(1);
  });
