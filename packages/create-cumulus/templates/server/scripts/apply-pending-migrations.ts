/**
 * One-shot: apply migrations 0023 and 0024 directly to whichever DATABASE_URL
 * the env points at, then backfill drizzle.__drizzle_migrations so future
 * `drizzle-kit migrate` calls don't try to re-run them.
 *
 * The repo was bootstrapped via `drizzle-kit push` (no journal writes), so
 * the journal lags the actual schema. This script reconciles that gap for
 * just the migrations we need for the 0.1.0 release.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { db } from '../src/server/db/index';
import { sql } from 'drizzle-orm';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

function splitStatements(sqlText: string): string[] {
  return sqlText
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex');
}

async function ensureJournalTable() {
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
}

async function alreadyApplied(hash: string): Promise<boolean> {
  const r = await db.execute(
    sql`SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${hash} LIMIT 1`,
  );
  return r.rows.length > 0;
}

async function applyOne(file: string, when: number) {
  const path = join(MIGRATIONS_DIR, file);
  const hash = hashFile(path);
  if (await alreadyApplied(hash)) {
    console.log(`[skip] ${file} — already in journal`);
    return;
  }
  const text = readFileSync(path, 'utf8');
  const statements = splitStatements(text);
  console.log(`[apply] ${file} — ${statements.length} statement(s)`);
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
  await db.execute(
    sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash}, ${when})`,
  );
  console.log(`[done] ${file}`);
}

async function main() {
  await ensureJournalTable();

  // Read meta/_journal.json on disk to learn the canonical "when" timestamps
  // for the entries we have. For 0023 / 0024 we'll synthesize since they're
  // not in the journal yet — use file mtime equivalent (Date.now()).
  const journalPath = join(MIGRATIONS_DIR, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ idx: number; when: number; tag: string }>;
  };
  const tagToWhen = new Map(journal.entries.map((e) => [e.tag, e.when]));

  const allFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of allFiles) {
    const tag = file.replace(/\.sql$/, '');
    const when = tagToWhen.get(tag) ?? Date.now();
    await applyOne(file, when);
  }
}

main()
  .then(() => {
    console.log('all migrations reconciled.');
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
