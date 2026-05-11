/**
 * One-shot: apply migrations 0023 (action metering) and 0024 (repeat-user
 * fairness) to whichever DATABASE_URL the env points at.
 *
 * The repo was bootstrapped via drizzle-kit push, so the drizzle journal
 * is out of sync with the actual schema. Drizzle-kit migrate cannot be
 * trusted here. This script just runs the SQL directly; both files are
 * written idempotently (CREATE TABLE IF NOT EXISTS, ALTER ... ADD COLUMN
 * IF NOT EXISTS, etc.) so it's safe to re-run if needed. The two RENAME
 * COLUMN statements in 0023 are guarded by a manual existence check.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../src/server/db/index';
import { sql } from 'drizzle-orm';

function splitStatements(sqlText: string): string[] {
  return sqlText
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function hasColumn(table: string, column: string): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
     WHERE table_name = ${table} AND column_name = ${column}
     LIMIT 1
  `);
  return r.rows.length > 0;
}

async function apply(file: string) {
  const path = join(process.cwd(), 'migrations', file);
  const text = readFileSync(path, 'utf8');
  const statements = splitStatements(text);
  console.log(`\n=== ${file} (${statements.length} statements) ===`);

  for (const stmt of statements) {
    // Skip the two RENAME COLUMN ops in 0023 if the rename already happened.
    if (
      file === '0023_action_metering.sql' &&
      stmt.includes('RENAME COLUMN "included_signups"')
    ) {
      if (!(await hasColumn('plan_catalog', 'included_signups'))) {
        console.log('[skip rename] plan_catalog.included_signups already renamed');
        continue;
      }
    }
    if (
      file === '0023_action_metering.sql' &&
      stmt.includes('RENAME COLUMN "trial_signups"')
    ) {
      if (!(await hasColumn('plan_catalog', 'trial_signups'))) {
        console.log('[skip rename] plan_catalog.trial_signups already renamed');
        continue;
      }
    }

    const preview = stmt.split('\n')[0].slice(0, 90);
    process.stdout.write(`  -> ${preview} ... `);
    try {
      await db.execute(sql.raw(stmt));
      console.log('ok');
    } catch (e: unknown) {
      const msg = (e as Error).message ?? String(e);
      console.log(`FAILED: ${msg}`);
      throw e;
    }
  }
}

async function main() {
  await apply('0023_action_metering.sql');
  await apply('0024_repeat_user_fairness.sql');
  console.log('\n✅ migrations 0023 + 0024 applied.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
