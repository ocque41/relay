/**
 * Mint a user + agent token for use by the eval suite.
 *
 * Idempotent — reuses the seed user if it exists. Prints the token on stdout
 * so the caller can `export AGENT_TOKEN=$(npx tsx scripts/seed-eval-token.ts)`.
 *
 * Does NOT create a tenant — eval-suite tests that need one should read
 * TENANT_ID separately or call `register_tenant` themselves.
 */
import { eq } from 'drizzle-orm';
import { db } from '../src/server/db/index';
import { users, user_workspaces, tenants } from '../src/server/db/schema';
import { mintAgentToken } from '../src/server/auth/mint-token';

const SEED_EMAIL = 'eval-suite@example.com';

async function main(): Promise<void> {
  // Upsert user
  let [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, SEED_EMAIL))
    .limit(1);
  if (!user) {
    [user] = await db
      .insert(users)
      .values({ email: SEED_EMAIL, name: 'Eval Suite' })
      .returning({ id: users.id });
  }

  // Ensure a default workspace exists
  let [ws] = await db
    .select({ id: user_workspaces.id })
    .from(user_workspaces)
    .where(eq(user_workspaces.user_id, user.id))
    .limit(1);
  if (!ws) {
    [ws] = await db
      .insert(user_workspaces)
      .values({
        user_id: user.id,
        name: 'Default',
        slug: 'default',
        is_default: true,
      })
      .returning({ id: user_workspaces.id });
  }

  // Ensure a tenant exists so tier-2 billing checks have something to read.
  let [tenant] = await db
    .select({ id: tenants.id, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.owner_user_id, user.id))
    .limit(1);
  if (!tenant) {
    [tenant] = await db
      .insert(tenants)
      .values({
        owner_user_id: user.id,
        name: 'Eval Suite',
        slug: `eval-suite-${Date.now().toString(36)}`,
      })
      .returning({ id: tenants.id, slug: tenants.slug });
  }

  // Mint a 7-day token for the suite.
  const minted = await mintAgentToken({
    userId: user.id,
    userWorkspaceId: ws.id,
    label: 'eval-suite',
    scopes: ['*'],
    expiry: { days: 7 },
  });

  // Stdout is only the bits callers need — everything else on stderr.
  console.error(
    `seeded user=${user.id} workspace=${ws.id} tenant=${tenant.id} (${tenant.slug})`,
  );
  console.error(
    `TOKEN_ID=${minted.agentId} expires_at=${minted.expiresAt?.toISOString() ?? 'never'}`,
  );
  console.error(`export TENANT_ID=${tenant.id}`);
  console.log(minted.token);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('seed failed:', err);
    process.exit(1);
  });
