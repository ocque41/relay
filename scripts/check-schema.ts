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
  const rows = (await db.execute(
    sql`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
  )).rows as { tablename: string }[];
  console.log('public tables:', rows.map((r) => r.tablename).join(', '));

  const agents_cols = (await db.execute(
    sql`SELECT column_name FROM information_schema.columns WHERE table_name='agents' AND table_schema='public' ORDER BY ordinal_position`,
  )).rows as { column_name: string }[];
  console.log('agents columns:', agents_cols.map((r) => r.column_name).join(', '));

  try {
    const migr = (await db.execute(
      sql`SELECT hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at`,
    )).rows;
    console.log('drizzle migrations applied:', migr.length);
    for (const m of migr) console.log('  -', m);
  } catch {
    console.log('drizzle.__drizzle_migrations: not found');
  }
};

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
