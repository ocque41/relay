/**
 * Diagnostic: surface (user_workspace_id, provider_id) tuples that have more
 * than one non-failed accounts row. These existed before migration 0026
 * introduced the partial unique index, so they need a backfill (or to be
 * marked failed) before the index can be created.
 */
import { db } from '../src/server/db/index';
import { sql } from 'drizzle-orm';

async function main() {
  const r = await db.execute(sql`
    SELECT
      user_workspace_id,
      provider_id,
      COUNT(*) AS n,
      array_agg(id ORDER BY created_at) AS account_ids,
      array_agg(status ORDER BY created_at) AS statuses,
      array_agg(created_at ORDER BY created_at) AS createds
    FROM accounts
    WHERE status != 'failed'
      AND user_workspace_id IS NOT NULL
    GROUP BY user_workspace_id, provider_id, COALESCE(alias, '')
    HAVING COUNT(*) > 1
    ORDER BY n DESC
  `);
  console.log(`duplicate tuples: ${r.rows.length}`);
  for (const row of r.rows) {
    console.log(JSON.stringify(row, null, 2));
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
