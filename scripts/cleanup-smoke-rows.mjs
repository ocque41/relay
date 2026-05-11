import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const sjs = await sql`DELETE FROM signup_jobs WHERE provider_slug IN ('smoke-test', 'track-sdk-smoke', 'track-sdk-pub-smoke') RETURNING id`;
const acts = await sql`SELECT count(*)::int FROM activations`;
console.log('deleted signup_jobs:', sjs.length, 'remaining activations:', acts[0].count);
