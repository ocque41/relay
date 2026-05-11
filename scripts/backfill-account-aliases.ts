/**
 * Pre-flight for migration 0026: backfill `accounts.alias` so the
 * partial unique index on (user_workspace_id, provider_id, COALESCE(alias, ''))
 * can be created.
 *
 * Strategy:
 *   - For each (user_workspace_id, provider_id) tuple with N>1 non-failed
 *     accounts and NULL alias on all of them, keep the OLDEST row as the
 *     primary (alias stays NULL) and stamp every newer row with
 *     `alias = id::text`. UUIDs are guaranteed unique → satisfies the index.
 *   - Idempotent: re-running it is a no-op (the second pass finds no NULL-
 *     alias dupes).
 */
import { db } from '../src/server/db/index';
import { sql } from 'drizzle-orm';

async function main() {
  // Single-statement update via CTE so we don't have to round-trip ids
  // through Drizzle's ANY() parameterization (which mangles uuid[]).
  const r = await db.execute(sql`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY user_workspace_id, provider_id, COALESCE(alias, '')
          ORDER BY created_at, id
        ) AS rn,
        COUNT(*) OVER (
          PARTITION BY user_workspace_id, provider_id, COALESCE(alias, '')
        ) AS n
      FROM accounts
      WHERE status != 'failed'
        AND user_workspace_id IS NOT NULL
    )
    UPDATE accounts a
    SET alias = a.id::text
    FROM ranked r
    WHERE a.id = r.id
      AND r.rn > 1
      AND r.n > 1
      AND a.alias IS NULL
    RETURNING a.id
  `);
  console.log(`[backfill] stamped ${r.rows.length} duplicate row(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
