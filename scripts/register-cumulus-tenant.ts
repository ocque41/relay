/**
 * One-shot: register cumulus.cumulush.com as a Relay tenant and mint the
 * integrator-scoped bearer Cumulus will use to call /v1/integrator/* routes.
 * Direct DB insert (no agent bearer needed) because this is the first-ever
 * tenant of the drop-in flow — before this runs, there's no tenant to
 * charge against.
 *
 * Idempotent: if the tenant already exists, reuses the row. If an active
 * integrator key already exists, this script stops without printing a fake
 * plaintext key. Use `--rotate` when you explicitly want to revoke active
 * Cumulus integrator keys and mint a fresh plaintext key.
 *
 * Usage:
 *   npx tsx scripts/register-cumulus-tenant.ts
 *   npx tsx scripts/register-cumulus-tenant.ts --rotate
 *
 * Output: copy the printed env block verbatim into Cumulus Vercel settings.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

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
loadDotEnv(resolve(process.cwd(), '.env.production'));
loadDotEnv(resolve(process.cwd(), '.env'));

const SHOULD_ROTATE = process.argv.includes('--rotate');

const OWNER_EMAIL = 'ocquema@gmail.com';
const NAME = 'Cumulus';
const SLUG = 'cumulus';
const DOMAIN = 'cumulush.com';
const RP_ID = 'cumulush.com';
const ALLOWED_ORIGINS = ['https://cumulush.com', 'https://www.cumulush.com'];

function generateToken(): string {
  return 'agt_' + randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(url);

  // 1) Owner user.
  const [user] = await sql`
    INSERT INTO users (email) VALUES (${OWNER_EMAIL})
    ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
    RETURNING id, email
  ` as unknown as Array<{ id: string; email: string }>;
  console.log(`owner user: ${user.email} (${user.id})`);

  // 2) Tenant.
  const [tenant] = await sql`
    INSERT INTO tenants (owner_user_id, name, slug, domain, rp_id, allowed_origins)
    VALUES (${user.id}, ${NAME}, ${SLUG}, ${DOMAIN}, ${RP_ID}, ${JSON.stringify(ALLOWED_ORIGINS)}::jsonb)
    ON CONFLICT (slug) DO UPDATE SET
      name            = EXCLUDED.name,
      domain          = EXCLUDED.domain,
      rp_id           = EXCLUDED.rp_id,
      allowed_origins = EXCLUDED.allowed_origins
    RETURNING id, slug, name, domain
  ` as unknown as Array<{ id: string; slug: string; name: string; domain: string | null }>;
  console.log(`tenant: ${tenant.slug} (${tenant.id})`);

  // 3) Integrator-scoped agent bearer.
  const activeKeys = await sql`
    SELECT id, created_at FROM agents
    WHERE tenant_id = ${tenant.id}
      AND scopes @> '["integrator"]'::jsonb
      AND revoked_at IS NULL
    ORDER BY created_at DESC
  ` as unknown as Array<{ id: string; created_at: Date }>;

  if (activeKeys.length > 0 && !SHOULD_ROTATE) {
    console.log(
      `active integrator key already exists: ${activeKeys[0].id} (${activeKeys.length} active total)`,
    );
    console.log('Plaintext keys are only shown at mint time and cannot be recovered.');
    console.log('Run with --rotate to revoke active Cumulus integrator keys and mint a new one.');
    console.log('No RELAY_INTEGRATOR_KEY value was printed.');
    return;
  }

  if (activeKeys.length > 0 && SHOULD_ROTATE) {
    const ids = activeKeys.map((k) => k.id);
    await sql`
      UPDATE agents
      SET revoked_at = now()
      WHERE id = ANY(${ids}::uuid[])
    `;
    console.log(`revoked ${ids.length} active integrator key(s)`);
  }

  const integratorKey = generateToken();
  const [minted] = await sql`
    INSERT INTO agents (user_id, tenant_id, token_hash, label, scopes, expires_at)
    VALUES (${user.id}, ${tenant.id}, ${hashToken(integratorKey)}, ${NAME + ' — server key'}, '["integrator"]'::jsonb, NULL)
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  const integratorKeyId = minted.id;

  const [verification] = await sql`
    SELECT id FROM agents
    WHERE id = ${integratorKeyId}
      AND token_hash = ${hashToken(integratorKey)}
      AND revoked_at IS NULL
    LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (!verification) {
    throw new Error('minted integrator key did not verify against agents.token_hash');
  }

  // 4) Print the env block Cumulus needs.
  console.log('\n================ COPY THIS INTO CUMULUS VERCEL ENV ================');
  console.log(`RELAY_ENDPOINT=https://relay.cumulush.com/v1`);
  console.log(`RELAY_ISSUER=https://relay.cumulush.com`);
  console.log(`RELAY_TENANT_ID=${tenant.id}`);
  console.log(`RELAY_TENANT_SLUG=${tenant.slug}`);
  console.log(`RELAY_INTEGRATOR_KEY=${integratorKey}`);
  console.log(`RELAY_INTEGRATOR_KEY_ID=${integratorKeyId}`);
  console.log('===================================================================\n');

  console.log('Also update public/.well-known/relay.json:');
  console.log(`  "tenantId": "${tenant.id}"`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
