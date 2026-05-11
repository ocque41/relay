/**
 * Create two demo accounts in prod for live testing the dual-workspace UI:
 *
 *   1. End-user account  — just a user + agent token, no tenant.
 *   2. Developer account — a user + a tenant they own + agent token.
 *
 * Both users use Gmail "+tag" aliasing so verification mail still routes back
 * to the operator's real inbox if they later use email-OTP login.
 *
 * Prints both agent tokens (plaintext) ONCE — Relay only persists their hash.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

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
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {}
}
loadDotEnv(resolve(process.cwd(), '.env'));

interface Args {
  baseEmail: string;
  tenantName: string;
  tenantSlug?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-email') out.baseEmail = argv[++i];
    else if (a === '--tenant-name') out.tenantName = argv[++i];
    else if (a === '--tenant-slug') out.tenantSlug = argv[++i];
  }
  if (!out.baseEmail || !out.tenantName) {
    console.error(
      'usage: npx tsx scripts/create-demo-accounts.ts --base-email <a@b.com> --tenant-name "<name>" [--tenant-slug slug]',
    );
    process.exit(1);
  }
  return out as Args;
}

function plusTag(base: string, tag: string): string {
  const at = base.indexOf('@');
  if (at < 0) throw new Error(`invalid email: ${base}`);
  return `${base.slice(0, at)}+${tag}${base.slice(at)}`;
}

function aliasLocal(email: string): string {
  return (
    email
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 20) || 'user'
  );
}

function slugify(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
  return base || 'tenant';
}

async function main(): Promise<void> {
  const args = parseArgs();
  // Dynamic imports so loadDotEnv() runs BEFORE @neondatabase/serverless reads
  // DATABASE_URL out of the environment.
  const { eq } = await import('drizzle-orm');
  const { db } = await import('../src/server/db/index');
  const { agents, tenants, users } = await import('../src/server/db/schema');
  const { generateToken, hashToken } = await import('../src/server/crypto');

  const catchallDomain = process.env.CATCHALL_DOMAIN ?? 'mail.example.com';

  async function uniqueAlias(seedEmail: string): Promise<string> {
    const local = aliasLocal(seedEmail);
    for (let i = 0; i < 5; i++) {
      const candidate = `${local}-${randomBytes(2).toString('hex')}`;
      const [clash] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.inbox_alias, candidate))
        .limit(1);
      if (!clash) return candidate;
    }
    return `user-${randomBytes(4).toString('hex')}`;
  }

  async function uniqueSlug(seed: string): Promise<string> {
    const base = slugify(seed);
    const [clash] = await db
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.slug, base))
      .limit(1);
    if (!clash) return base;
    return `${base}-${randomBytes(2).toString('hex')}`;
  }

  async function getOrCreateUser(
    email: string,
  ): Promise<{ id: string; created: boolean; alias: string | null }> {
    const [existing] = await db
      .select({ id: users.id, inbox_alias: users.inbox_alias })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing) return { id: existing.id, created: false, alias: existing.inbox_alias };
    const inbox_alias = await uniqueAlias(email);
    const [inserted] = await db
      .insert(users)
      .values({ email, inbox_alias, last_login_at: new Date() })
      .returning({ id: users.id });
    return { id: inserted.id, created: true, alias: inbox_alias };
  }

  async function mintAgentToken(
    userId: string,
    label: string,
  ): Promise<{ id: string; token: string }> {
    const token = generateToken();
    const [row] = await db
      .insert(agents)
      .values({
        user_id: userId,
        token_hash: hashToken(token),
        label,
        scopes: [], // user-level only — never `admin`
      })
      .returning({ id: agents.id });
    return { id: row.id, token };
  }

  // ---- 1. End-user account ------------------------------------------------
  const userEmail = plusTag(args.baseEmail, 'enduser');
  const u = await getOrCreateUser(userEmail);
  const userToken = await mintAgentToken(u.id, 'demo-enduser');

  // ---- 2. Developer account ----------------------------------------------
  const devEmail = plusTag(args.baseEmail, 'dev');
  const d = await getOrCreateUser(devEmail);

  const slug = await uniqueSlug(args.tenantSlug ?? args.tenantName);
  const [tenant] = await db
    .insert(tenants)
    .values({ owner_user_id: d.id, name: args.tenantName, slug })
    .returning({ id: tenants.id, slug: tenants.slug, name: tenants.name });

  const devToken = await mintAgentToken(d.id, 'demo-dev');

  // ---- Output ------------------------------------------------------------
  const fmt = (s: string) => `\x1b[1m${s}\x1b[0m`;
  console.log('\n' + fmt('Demo accounts created') + '\n');

  console.log(fmt('1) End-user account'));
  console.log(`   email:        ${userEmail}`);
  console.log(`   user_id:      ${u.id}  ${u.created ? '(new)' : '(existing — token added)'}`);
  console.log(`   inbox:        ${u.alias ?? '(none)'}@${catchallDomain}`);
  console.log(`   agent_token:  ${userToken.token}`);
  console.log(`   workspace:    /me`);
  console.log();

  console.log(fmt('2) Developer account'));
  console.log(`   email:        ${devEmail}`);
  console.log(`   user_id:      ${d.id}  ${d.created ? '(new)' : '(existing — tenant + token added)'}`);
  console.log(`   inbox:        ${d.alias ?? '(none)'}@${catchallDomain}`);
  console.log(`   tenant:       ${tenant.name}  (slug: ${tenant.slug}, id: ${tenant.id})`);
  console.log(`   agent_token:  ${devToken.token}`);
  console.log(`   workspace:    /dev (and /me via the workspace switcher)`);
  console.log();

  console.log(fmt('Browser login:'));
  console.log(`   Visit https://relay.cumulush.com/login and request OTP for either email.`);
  console.log(`   Gmail "+tag" addresses route back to your real inbox.`);
  console.log();
  console.log(fmt('CLI quick-start (developer token):'));
  console.log(`   mkdir -p ~/.relay && cat > ~/.relay/config.json <<'EOF'`);
  console.log(
    `   { "base_url": "https://relay.cumulush.com", "agent_token": "${devToken.token}",`,
  );
  console.log(
    `     "user": { "id": "${d.id}", "email": "${devEmail}", "inbox_alias": "${d.alias}" } }`,
  );
  console.log(`   EOF`);
  console.log(`   chmod 600 ~/.relay/config.json`);
  console.log(`   relay whoami`);
  console.log(`   relay workspace list`);
  console.log();
  console.log(fmt('Tokens are shown ONCE. Save them now.'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
