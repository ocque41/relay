/**
 * Mint a per-tenant low-privilege HMAC tracking secret for use with
 * @cumulus/track. The secret is for a single purpose:
 * authenticating POST /v1/activations from the integrator's
 * key-validation middleware. It cannot mint API keys, read accounts,
 * or call any other route.
 *
 * Idempotent on (tenant_id, label): re-running with the same label
 * does NOT create a new row; instead it prints the existing public_id
 * (and re-emits the secret_value if --reveal is passed).
 *
 * Usage:
 *   npx tsx scripts/seed-tracking-secret.ts --tenant-id <uuid> [--label production]
 *
 * Output:
 *   Stdout: PUBLIC_ID=relay_track_…\nSECRET=relay_track_secret_…
 *   The plaintext secret is printed exactly once. Save it; if lost,
 *   rotate (which gives you a new pair).
 *
 * Rotation policy (manual):
 *   1. Run this script with the same --label to get a new pair.
 *      The script will reuse the existing row; pass --rotate to
 *      mint a NEW row alongside the existing one with grace_until
 *      set 30 days ahead.
 *   2. Update the integrator's middleware to use the new pair.
 *   3. After 30 days, the old row's grace_until expires and it
 *      is rejected.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../src/server/db/index';
import { tenant_tracking_secrets, tenants } from '../src/server/db/schema';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function publicId(): string {
  return 'relay_track_' + randomBytes(8).toString('hex');
}
function secretValue(): string {
  return 'relay_track_secret_' + randomBytes(32).toString('base64url');
}

async function main(): Promise<void> {
  const tenantId = arg('tenant-id');
  const label = arg('label') ?? 'default';
  const rotate = flag('rotate');

  if (!tenantId) {
    console.error('Usage: --tenant-id <uuid> [--label name] [--rotate]');
    process.exit(2);
  }

  const [tenant] = await db
    .select({ id: tenants.id, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) {
    console.error(`tenant ${tenantId} not found`);
    process.exit(1);
  }

  if (!rotate) {
    const existing = await db
      .select({
        id: tenant_tracking_secrets.id,
        public_id: tenant_tracking_secrets.public_id,
      })
      .from(tenant_tracking_secrets)
      .where(
        and(
          eq(tenant_tracking_secrets.tenant_id, tenantId),
          eq(tenant_tracking_secrets.label, label),
          isNull(tenant_tracking_secrets.revoked_at),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      console.error(
        `secret with label "${label}" already exists for tenant. Pass --rotate to mint a new one alongside it.`,
      );
      console.log(`PUBLIC_ID=${existing[0].public_id}`);
      console.log('SECRET=<not re-emittable>');
      process.exit(0);
    }
  }

  const newPublic = publicId();
  const newSecret = secretValue();
  const graceUntil = rotate
    ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    : null;

  // If rotating, mark all existing non-revoked rows for this tenant+label
  // with the same grace_until so they expire together.
  if (rotate) {
    await db
      .update(tenant_tracking_secrets)
      .set({ grace_until: graceUntil })
      .where(
        and(
          eq(tenant_tracking_secrets.tenant_id, tenantId),
          eq(tenant_tracking_secrets.label, label),
          isNull(tenant_tracking_secrets.revoked_at),
        ),
      );
  }

  await db.insert(tenant_tracking_secrets).values({
    tenant_id: tenantId,
    public_id: newPublic,
    secret_value: newSecret,
    label,
    grace_until: null,
  });

  console.error(`tenant=${tenant.slug} label=${label}${rotate ? ' (rotated)' : ''}`);
  console.log(`PUBLIC_ID=${newPublic}`);
  console.log(`SECRET=${newSecret}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('seed-tracking-secret failed:', err);
    process.exit(1);
  });
