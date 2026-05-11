// One-shot: apply migration 0025 to DATABASE_URL.
//
// The repo's larger apply-pending-migrations.ts wants to backfill the
// drizzle journal from migration 0005, which already ran via
// drizzle-kit push. This is a focused script that applies just the
// 0025 statements (idempotent — skips on 'already exists').
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }
  const sql = neon(process.env.DATABASE_URL);
  const text = readFileSync('migrations/0025_billing_interval_and_credits.sql', 'utf8');
  const stmts = text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of stmts) {
    const meaningful = stmt
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim();
    if (!meaningful) continue;
    console.log(`\n--- ${meaningful.slice(0, 100).replace(/\s+/g, ' ')}…`);
    try {
      const result = await sql.query(meaningful);
      console.log(
        '  ok',
        result && typeof result === 'object' && 'rowCount' in result
          ? `(rowCount=${(result as { rowCount: number | null }).rowCount ?? '?'})`
          : '',
      );
    } catch (err) {
      const msg = (err as Error).message;
      if (/already exists/i.test(msg)) {
        console.log('  skip — already exists');
      } else {
        console.error('  error:', msg);
        process.exit(1);
      }
    }
  }
  console.log('\nMigration 0025 complete.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
