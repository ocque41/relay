/**
 * One-shot backfill for migration 0005 (dual-workspace foundation).
 *
 * Populates the new ownership FKs on rows that existed before the migration:
 *   signup_jobs.user_id         ← via audit_log[action='signup_create'] → agents.user_id
 *   signup_jobs.calling_agent_id ← same chain
 *   signup_jobs.provider_slug    ← audit_log.metadata.provider
 *   signup_jobs.tenant_id        ← tenant_providers.tenant_id when the provider_slug matches
 *   accounts.user_id             ← signup_jobs.user_id (after the above)
 *   accounts.tenant_id           ← signup_jobs.tenant_id (after the above)
 *   audit_log.user_id            ← agents.user_id
 *   audit_log.tenant_id          ← derived from the action's target when it's a signup/account whose tenant_id is known
 *
 * Usage:
 *   npx tsx scripts/backfill-dual-workspace.ts           # dry-run, prints plan
 *   npx tsx scripts/backfill-dual-workspace.ts --apply   # actually update rows
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

import { neon } from '@neondatabase/serverless';

interface Counts {
  signup_jobs_user: number;
  signup_jobs_agent: number;
  signup_jobs_provider: number;
  signup_jobs_tenant: number;
  accounts_user: number;
  accounts_tenant: number;
  audit_log_user: number;
  audit_log_tenant: number;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const sql = neon(process.env.DATABASE_URL!) as unknown as NeonClient;

  console.log(apply ? '=== APPLYING backfill ===' : '=== DRY RUN (use --apply to commit) ===');

  const before: Counts = await countsNull(sql);
  console.log('\nNULL counts BEFORE backfill:');
  printCounts(before);

  // ---- 1. audit_log.user_id: every audit row with an agent_id
  const step1 = `
    UPDATE audit_log al
    SET user_id = a.user_id
    FROM agents a
    WHERE al.agent_id = a.id
      AND al.user_id IS NULL
      AND a.user_id IS NOT NULL
  `;

  // ---- 2. signup_jobs.user_id + calling_agent_id + provider_slug
  // Derive via the signup_create audit row for each job.
  const step2 = `
    UPDATE signup_jobs sj
    SET
      user_id          = COALESCE(sj.user_id, a.user_id),
      calling_agent_id = COALESCE(sj.calling_agent_id, al.agent_id),
      provider_slug    = COALESCE(sj.provider_slug, al.metadata->>'provider')
    FROM audit_log al
    JOIN agents a ON al.agent_id = a.id
    WHERE al.action = 'signup_create'
      AND al.target = sj.id::text
      AND (sj.user_id IS NULL OR sj.calling_agent_id IS NULL OR sj.provider_slug IS NULL)
  `;

  // ---- 3. signup_jobs.tenant_id: match provider_slug against tenant_providers
  const step3 = `
    UPDATE signup_jobs sj
    SET tenant_id = tp.tenant_id
    FROM tenant_providers tp
    WHERE sj.provider_slug = tp.slug
      AND sj.tenant_id IS NULL
  `;

  // ---- 4. accounts.user_id + tenant_id: pull through signup_jobs
  const step4 = `
    UPDATE accounts acc
    SET
      user_id   = COALESCE(acc.user_id, sj.user_id),
      tenant_id = COALESCE(acc.tenant_id, sj.tenant_id)
    FROM signup_jobs sj
    WHERE sj.account_id = acc.id
      AND (acc.user_id IS NULL OR acc.tenant_id IS NULL)
  `;

  // ---- 5. audit_log.tenant_id: derive from target when it points at a
  // signup_job we now know the tenant for.
  const step5 = `
    UPDATE audit_log al
    SET tenant_id = sj.tenant_id
    FROM signup_jobs sj
    WHERE al.target = sj.id::text
      AND sj.tenant_id IS NOT NULL
      AND al.tenant_id IS NULL
  `;

  // ---- 6. audit_log.tenant_id for account_delete / key_* events pointing at
  // an account row whose tenant_id is now populated.
  const step6 = `
    UPDATE audit_log al
    SET tenant_id = acc.tenant_id
    FROM accounts acc
    WHERE al.target = acc.id::text
      AND acc.tenant_id IS NOT NULL
      AND al.tenant_id IS NULL
  `;

  const steps = [
    ['audit_log.user_id ← agents.user_id', step1],
    ['signup_jobs.user_id / calling_agent_id / provider_slug ← audit_log chain', step2],
    ['signup_jobs.tenant_id ← tenant_providers', step3],
    ['accounts.user_id / tenant_id ← signup_jobs', step4],
    ['audit_log.tenant_id ← signup_jobs (by target)', step5],
    ['audit_log.tenant_id ← accounts (by target)', step6],
  ] as const;

  for (const [label, stmt] of steps) {
    if (apply) {
      const result = (await sql.query(stmt)) as { rowCount?: number };
      const n = result?.rowCount ?? 0;
      console.log(`  ✓ ${label}: ${n} rows updated`);
    } else {
      console.log(`  (would run) ${label}`);
    }
  }

  if (apply) {
    const after = await countsNull(sql);
    console.log('\nNULL counts AFTER backfill:');
    printCounts(after);
    console.log('\nDone. Remaining NULLs are expected for:');
    console.log('  - built-in providers not tied to tenants (accounts.tenant_id)');
    console.log('  - legacy signup rows created before agent-audit was wired up');
  } else {
    console.log('\nDry run only. Re-run with --apply to commit.');
  }
}

// The Neon HTTP client's generic parameters vary by construction, so use a
// minimal structural type here to keep the helper generic across TS versions.
type NeonClient = { query: (stmt: string) => Promise<unknown> };

async function countOne(sql: NeonClient, stmt: string): Promise<number> {
  const rows = (await sql.query(stmt)) as
    | { count: string | number }[]
    | { rows?: { count: string | number }[] };
  const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
  return Number(list[0]?.count ?? 0);
}

async function countsNull(sql: NeonClient): Promise<Counts> {
  return {
    signup_jobs_user: await countOne(sql, `SELECT count(*)::int AS count FROM signup_jobs WHERE user_id IS NULL`),
    signup_jobs_agent: await countOne(sql, `SELECT count(*)::int AS count FROM signup_jobs WHERE calling_agent_id IS NULL`),
    signup_jobs_provider: await countOne(sql, `SELECT count(*)::int AS count FROM signup_jobs WHERE provider_slug IS NULL`),
    signup_jobs_tenant: await countOne(sql, `SELECT count(*)::int AS count FROM signup_jobs WHERE tenant_id IS NULL`),
    accounts_user: await countOne(sql, `SELECT count(*)::int AS count FROM accounts WHERE user_id IS NULL`),
    accounts_tenant: await countOne(sql, `SELECT count(*)::int AS count FROM accounts WHERE tenant_id IS NULL`),
    audit_log_user: await countOne(sql, `SELECT count(*)::int AS count FROM audit_log WHERE user_id IS NULL`),
    audit_log_tenant: await countOne(sql, `SELECT count(*)::int AS count FROM audit_log WHERE tenant_id IS NULL`),
  };
}

function printCounts(c: Counts): void {
  console.log(`  signup_jobs.user_id:           ${c.signup_jobs_user}`);
  console.log(`  signup_jobs.calling_agent_id:  ${c.signup_jobs_agent}`);
  console.log(`  signup_jobs.provider_slug:     ${c.signup_jobs_provider}`);
  console.log(`  signup_jobs.tenant_id:         ${c.signup_jobs_tenant}`);
  console.log(`  accounts.user_id:              ${c.accounts_user}`);
  console.log(`  accounts.tenant_id:            ${c.accounts_tenant}`);
  console.log(`  audit_log.user_id:             ${c.audit_log_user}`);
  console.log(`  audit_log.tenant_id:           ${c.audit_log_tenant}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
