/**
 * Smoke-test the tenant provider factory end-to-end WITHOUT touching the
 * HTTP API stack. Runs an in-process echo webhook server, seeds a
 * tenant + tenant_provider row pointing at it, invokes the factory's
 * methods directly, and verifies responses + HMAC signatures.
 *
 * Usage:  npx tsx scripts/smoke-tenant-provider.ts
 */
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
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

// Dynamic imports so loadDotEnv runs before the db module evaluates.
const { eq } = await import('drizzle-orm');
const { db } = await import('../src/server/db/index.js');
const { users, tenants, tenant_providers } = await import('../src/server/db/schema.js');
const { encrypt } = await import('../src/server/crypto.js');
const { tenantProviderFromRow } = await import('../src/server/providers/tenant.js');
const { getProvider, listProviders } = await import('../src/server/providers/index.js');

const PORT = 7777;
const SECRET = 'smoke-secret-' + Date.now().toString(36);

type CapturedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  parsed: Record<string, unknown>;
};

const captured: CapturedRequest[] = [];

function startEcho(): Promise<() => void> {
  return new Promise((resolveReady) => {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body);
      } catch {}
      captured.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : (v ?? '')]),
        ),
        body,
        parsed,
      });

      // Verify the HMAC
      const sig = req.headers['x-relay-signature'] as string | undefined;
      const expected = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
      if (sig !== expected) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad signature', got: sig, expected }));
        return;
      }

      const kind = parsed.kind;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (kind === 'signup') {
        res.end(
          JSON.stringify({
            accountId: 'integrator-user-42',
            apiKey: 'demo-live-key-abcdef123',
            externalId: 'user_42',
          }),
        );
      } else if (kind === 'create_api_key') {
        res.end(JSON.stringify({ key: 'demo-live-key-new', providerKeyId: 'pk-new' }));
      } else if (kind === 'revoke_api_key') {
        res.end(JSON.stringify({ revoked: true }));
      } else if (kind === 'teardown') {
        res.end(JSON.stringify({ deleted: true }));
      } else {
        res.end(JSON.stringify({}));
      }
    });
    server.listen(PORT, '127.0.0.1', () => {
      resolveReady(() => {
        server.close();
      });
    });
  });
}

async function main(): Promise<void> {
  console.log('Starting echo webhook on http://127.0.0.1:' + PORT);
  const stop = await startEcho();

  let userId: string | undefined;
  let tenantId: string | undefined;
  let providerRowId: string | undefined;

  try {
    // Seed a user + tenant + provider row
    const uniq = Date.now().toString(36);
    const email = `smoke-${uniq}@example.com`;
    const [u] = await db.insert(users).values({ email }).returning({ id: users.id });
    userId = u.id;

    const slug = `smoke-${uniq}`;
    const [t] = await db
      .insert(tenants)
      .values({ owner_user_id: userId, name: 'Smoke Tenant', slug })
      .returning({ id: tenants.id });
    tenantId = t.id;

    const [row] = await db
      .insert(tenant_providers)
      .values({
        tenant_id: tenantId,
        slug,
        display_name: 'Smoke Tenant Provider',
        signup_webhook_url: `http://127.0.0.1:${PORT}/hook`,
        webhook_secret_enc: encrypt(SECRET),
        input_schema: { type: 'object' },
        needs_email_verification: false,
      })
      .returning();
    providerRowId = row.id;
    console.log('Seeded tenant_provider:', slug, providerRowId);

    // 1. getProvider(slug) should materialize the factory
    const p = await getProvider(slug);
    if (!p) throw new Error('getProvider returned undefined');
    console.log('  ✓ getProvider resolved tenant provider, id=' + p.id);

    // 2. listProviders should include it
    const all = await listProviders();
    const summary = all.find((x) => x.id === slug);
    if (!summary) throw new Error('listProviders did not include tenant provider');
    if (summary.kind !== 'tenant') throw new Error(`kind=${summary.kind}, expected 'tenant'`);
    console.log('  ✓ listProviders includes tenant provider with kind=tenant');

    // 3. signup → verify response + verify echo captured HMAC + body
    const outcome = await p.signup(
      { db },
      { name: 'smoke' },
      'user@example.com',
    );
    if (outcome.needsEmail) throw new Error('expected needsEmail=false');
    if (outcome.externalId !== 'user_42') throw new Error(`externalId=${outcome.externalId}`);
    if (outcome.credentials !== 'demo-live-key-abcdef123') throw new Error('credentials mismatch');
    const signupReq = captured.at(-1);
    if (signupReq?.parsed.kind !== 'signup') throw new Error('echo did not see kind=signup');
    if (signupReq?.parsed.email !== 'user@example.com') throw new Error('email not forwarded');
    console.log('  ✓ signup() dispatched + HMAC verified + response parsed');

    // 4. createApiKey('initial', account) returns the cached key without hitting the webhook
    const beforeCount = captured.length;
    const init = await p.createApiKey({ db }, outcome.account, 'initial');
    if (init.key !== 'demo-live-key-abcdef123') throw new Error('initial key mismatch');
    if (captured.length !== beforeCount) throw new Error('createApiKey(initial) should not hit the webhook');
    console.log('  ✓ createApiKey("initial") reused the signup response key');

    // 5. createApiKey('other') DOES hit the webhook
    const extra = await p.createApiKey({ db }, { accountId: 'integrator-user-42' }, 'second');
    if (extra.key !== 'demo-live-key-new') throw new Error('extra key mismatch');
    console.log('  ✓ createApiKey("second") dispatched and returned new key');

    // 6. revokeApiKey + teardown dispatch correctly
    await p.revokeApiKey({ db }, { accountId: 'integrator-user-42' }, 'pk-new');
    const revokeReq = captured.at(-1);
    if (revokeReq?.parsed.kind !== 'revoke_api_key') throw new Error('revoke missed');
    console.log('  ✓ revokeApiKey dispatched kind=revoke_api_key');

    if (p.teardown) {
      await p.teardown({ db }, { accountId: 'integrator-user-42' });
      const tdReq = captured.at(-1);
      if (tdReq?.parsed.kind !== 'teardown') throw new Error('teardown missed');
      console.log('  ✓ teardown dispatched kind=teardown');
    }

    // 7. Bad signature: if secret changes, webhook returns 401 and factory throws
    const wrong = tenantProviderFromRow({ ...row, webhook_secret_enc: encrypt('wrong-secret') });
    let threw = false;
    try {
      await wrong.signup({ db }, {}, 'user@example.com');
    } catch (e) {
      threw = true;
      console.log('  ✓ bad secret rejected:', (e as Error).message.slice(0, 80));
    }
    if (!threw) throw new Error('expected throw on bad signature');

    console.log('\nAll tenant-provider smoke checks passed.');
  } finally {
    // Cleanup: FK order — tenant_providers → tenants → users
    if (providerRowId) {
      await db.delete(tenant_providers).where(eq(tenant_providers.id, providerRowId));
    }
    if (tenantId) {
      await db.delete(tenants).where(eq(tenants.id, tenantId));
    }
    if (userId) {
      await db.delete(users).where(eq(users.id, userId));
    }
    stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\nFAILED:', e);
    process.exit(1);
  });
