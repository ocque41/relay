/**
 * Pre-migration safety check for migrations/0015_drop_user_wallet.sql.
 *
 * Asserts that no real money / tokens live in the user wallet tables. Because
 * BILLING_ENFORCEMENT has always defaulted to `off` in production, every row
 * that exists should be an idempotent seed (free_grant) or a log-only event
 * with tokens_delta = 0.
 *
 * Run this BEFORE applying 0015. Exits non-zero and prints the offending
 * aggregates if anything looks wrong. A clean run prints "OK: safe to drop."
 *
 * Usage:
 *   npx tsx scripts/verify-pre-0015.ts
 *   DATABASE_URL=postgres://... npx tsx scripts/verify-pre-0015.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { neon } from '@neondatabase/serverless';

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

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

const sql = neon(url);

async function tableExists(name: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${name}
    LIMIT 1
  `;
  return rows.length > 0;
}

async function main(): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // 1. Wallet totals must be zero across every user.
  if (await tableExists('token_balances')) {
    const rows = (await sql`
      SELECT
        COALESCE(SUM(balance), 0) AS paid_sum,
        COALESCE(SUM(total_spent), 0) AS spent_sum,
        COUNT(*) AS rows
      FROM token_balances
    `) as Array<{ paid_sum: number | string; spent_sum: number | string; rows: number | string }>;
    const r = rows[0] ?? { paid_sum: 0, spent_sum: 0, rows: 0 };
    const paid = Number(r.paid_sum);
    const spent = Number(r.spent_sum);
    const ok = paid === 0 && spent === 0;
    checks.push({
      name: 'token_balances has no paid balance or lifetime spend',
      ok,
      detail: `rows=${r.rows} paid_sum=${paid} total_spent=${spent}`,
    });
  } else {
    checks.push({
      name: 'token_balances table exists',
      ok: true,
      detail: 'not present — already dropped',
    });
  }

  // 2. No real charges in the ledger.
  if (await tableExists('usage_events')) {
    const rows = (await sql`
      SELECT COUNT(*) AS charges
      FROM usage_events
      WHERE kind = 'charge' AND tokens_delta <> 0
    `) as Array<{ charges: number | string }>;
    const r = rows[0] ?? { charges: 0 };
    const charges = Number(r.charges);
    checks.push({
      name: 'usage_events has no nonzero charges',
      ok: charges === 0,
      detail: `nonzero_charges=${charges}`,
    });
  } else {
    checks.push({
      name: 'usage_events table exists',
      ok: true,
      detail: 'not present — already dropped',
    });
  }

  // 3. No successful SPT payments.
  if (await tableExists('mpp_payments')) {
    const rows = (await sql`
      SELECT COUNT(*) AS succeeded
      FROM mpp_payments
      WHERE status = 'succeeded'
    `) as Array<{ succeeded: number | string }>;
    const r = rows[0] ?? { succeeded: 0 };
    const succeeded = Number(r.succeeded);
    checks.push({
      name: 'mpp_payments has no succeeded rows',
      ok: succeeded === 0,
      detail: `succeeded=${succeeded}`,
    });
  } else {
    checks.push({
      name: 'mpp_payments table exists',
      ok: true,
      detail: 'not present — already dropped',
    });
  }

  // 4. No active shared payment tokens.
  if (await tableExists('user_shared_payment_tokens')) {
    const rows = (await sql`
      SELECT COUNT(*) AS active
      FROM user_shared_payment_tokens
      WHERE status = 'active'
    `) as Array<{ active: number | string }>;
    const r = rows[0] ?? { active: 0 };
    const active = Number(r.active);
    checks.push({
      name: 'user_shared_payment_tokens has no active rows',
      ok: active === 0,
      detail: `active=${active}`,
    });
  } else {
    checks.push({
      name: 'user_shared_payment_tokens table exists',
      ok: true,
      detail: 'not present — already dropped',
    });
  }

  // 5. No issued cards.
  if (await tableExists('user_issued_cards')) {
    const rows = (await sql`
      SELECT COUNT(*) AS active
      FROM user_issued_cards
      WHERE status = 'active'
    `) as Array<{ active: number | string }>;
    const r = rows[0] ?? { active: 0 };
    const active = Number(r.active);
    checks.push({
      name: 'user_issued_cards has no active rows',
      ok: active === 0,
      detail: `active=${active}`,
    });
  } else {
    checks.push({
      name: 'user_issued_cards table exists',
      ok: true,
      detail: 'not present — already dropped',
    });
  }

  console.log('Pre-0015 safety check:');
  for (const c of checks) {
    const icon = c.ok ? '✓' : '✗';
    console.log(`  ${icon} ${c.name} — ${c.detail}`);
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error(
      `\nABORT: ${failed.length} check(s) failed. Do NOT apply migrations/0015_drop_user_wallet.sql until the discrepancy is explained.`,
    );
    process.exit(1);
  }

  console.log('\nOK: safe to drop user-wallet schema.');
}

main().catch((err) => {
  console.error('verify-pre-0015 failed:', err);
  process.exit(2);
});
