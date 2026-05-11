/**
 * One-shot: apply migration 0026 (intent dedup) directly. Idempotent — uses
 * IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout, so safe to re-run.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../src/server/db/index';
import { sql } from 'drizzle-orm';

async function main() {
  const path = join(process.cwd(), 'migrations', '0026_intent_dedup.sql');
  const text = readFileSync(path, 'utf8');
  const statements = text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`[0026] applying ${statements.length} statement(s)`);
  for (const stmt of statements) {
    const preview = stmt.split('\n')[0].slice(0, 80);
    console.log(`  → ${preview}`);
    await db.execute(sql.raw(stmt));
  }
  console.log('[0026] done.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
