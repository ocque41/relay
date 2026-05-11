/**
 * Backfill the `drizzle.__drizzle_migrations` journal so `drizzle-kit migrate`
 * stays consistent with what was applied via `scripts/apply-migration.ts`.
 *
 * Context: the initial migration (0000) was applied via `drizzle-kit push`
 * (schema.ts → DB) during early setup, and subsequent migrations (0001–0004)
 * via our custom `apply-migration.ts` helper because the Neon websocket hung
 * `drizzle-kit migrate`. Neither path writes to `drizzle.__drizzle_migrations`,
 * so from drizzle-kit's POV the DB is at "zero migrations applied".
 *
 * This script inserts the correct journal rows so future runs of
 * `drizzle-kit migrate` see all applied migrations and no-op.
 *
 * Usage:
 *   DATABASE_URL=… npx tsx scripts/backfill-drizzle-journal.ts
 *
 * Idempotent — reads the journal before inserting; safe to re-run.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
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

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

async function main(): Promise<void> {
  const db = neon(process.env.DATABASE_URL!);

  // Read journal to get the official order + timestamps
  const journalPath = resolve(process.cwd(), 'migrations', 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: JournalEntry[];
  };

  // Ensure the drizzle schema + tracking table exist
  await db`CREATE SCHEMA IF NOT EXISTS drizzle`;
  await db`
    CREATE TABLE IF NOT EXISTS drizzle."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT
    )
  `;

  // Fetch current state
  const existing = (await db`SELECT hash FROM drizzle."__drizzle_migrations"`) as { hash: string }[];
  const haveHashes = new Set(existing.map((r) => r.hash));
  console.log(`Existing journal rows: ${existing.length}`);

  let inserted = 0;
  for (const entry of journal.entries) {
    const sqlPath = resolve(process.cwd(), 'migrations', `${entry.tag}.sql`);
    const sqlText = readdirSync(resolve(process.cwd(), 'migrations'))
      .filter((f) => f.startsWith(entry.tag) && f.endsWith('.sql'))[0];
    if (!sqlText) {
      console.error(`SKIP ${entry.tag}: sql file missing`);
      continue;
    }
    const raw = readFileSync(resolve(process.cwd(), 'migrations', sqlText), 'utf8');
    const hash = createHash('sha256').update(raw).digest('hex');

    if (haveHashes.has(hash)) {
      console.log(`  skip ${entry.tag} (already recorded, hash=${hash.slice(0, 12)})`);
      continue;
    }

    await db`
      INSERT INTO drizzle."__drizzle_migrations" (hash, created_at)
      VALUES (${hash}, ${entry.when})
    `;
    console.log(`  insert ${entry.tag} (hash=${hash.slice(0, 12)}, when=${new Date(entry.when).toISOString()})`);
    inserted++;
  }

  console.log(`\nBackfilled ${inserted} journal rows. Total now: ${existing.length + inserted}.`);
  console.log('`npx drizzle-kit migrate` will now no-op on this DB.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
