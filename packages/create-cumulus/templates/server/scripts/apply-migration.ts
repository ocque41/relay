/**
 * Apply a migration file's statements one at a time via the configured Relay
 * database driver.
 *
 * Usage: npx tsx scripts/apply-migration.ts migrations/0001_cold_brood.sql
 *
 * Splits on `--> statement-breakpoint` (Drizzle's separator). Each statement is
 * executed in its own query. Does not update __drizzle_migrations — the project
 * convention has historically used `drizzle-kit push`, not the migration
 * journal, so we stay consistent with that.
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

import { sql } from 'drizzle-orm';
import { db } from '../src/server/db/index';

const main = async () => {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: apply-migration.ts <path-to-migration.sql>');
    process.exit(1);
  }
  const sqlText = readFileSync(resolve(process.cwd(), file), 'utf8');

  // Drizzle files use `--> statement-breakpoint`. Raw SQL migrations (the
  // Some migration sets rely on semicolons. Split on the Drizzle marker first;
  // if that yielded a single chunk, fall back to splitting on `;` at
  // statement termination, ignoring anything inside a dollar-quoted block
  // (Postgres function bodies don't appear in Relay migrations but a naive
  // scanner is robust enough for what we ship).
  function splitOnSemicolons(text: string): string[] {
    const out: string[] = [];
    let buf = '';
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '-' && text[i + 1] === '-') {
        // Line comment — swallow until newline, but keep so the head-line
        // log shows context.
        const end = text.indexOf('\n', i);
        const stop = end === -1 ? text.length : end;
        buf += text.slice(i, stop);
        i = stop;
        continue;
      }
      if (ch === "'" || ch === '"') {
        const end = text.indexOf(ch, i + 1);
        const stop = end === -1 ? text.length : end + 1;
        buf += text.slice(i, stop);
        i = stop;
        continue;
      }
      if (ch === ';') {
        buf += ';';
        out.push(buf);
        buf = '';
        i++;
        continue;
      }
      buf += ch;
      i++;
    }
    if (buf.trim()) out.push(buf);
    return out
      .map((s) => s.trim())
      .map((s) => {
        // Strip leading comment-only lines so the log head is informative.
        const lines = s.split('\n').filter((l) => !l.trim().startsWith('--') && l.trim().length > 0);
        return lines.length === 0 ? '' : s;
      })
      .filter((s) => s.length > 0);
  }

  let statements = sqlText
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (statements.length <= 1) {
    statements = splitOnSemicolons(sqlText);
  }

  console.log(`Applying ${statements.length} statements from ${file}`);

  let i = 0;
  for (const stmt of statements) {
    i++;
    const head = stmt.slice(0, 80).replace(/\s+/g, ' ');
    try {
      await db.execute(sql.raw(stmt));
      console.log(`  [${i}/${statements.length}] ok: ${head}…`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/already exists|duplicate/i.test(msg)) {
        console.log(`  [${i}/${statements.length}] skip (already applied): ${head}…`);
        continue;
      }
      console.error(`  [${i}/${statements.length}] FAILED: ${head}…`);
      console.error(`      ${msg}`);
      process.exit(2);
    }
  }
  console.log('All statements applied.');
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
