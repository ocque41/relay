/**
 * Per-tenant user cap enforced at attest time.
 *
 * Every plan carries a `users_limit` on `tenant_subscriptions`. When an agent
 * calls `/v1/integrator/auth/attest` and WOULD insert a new row in
 * `user_external_identities`, this check runs first. Past the cap we return
 * 429 with an upgrade pointer; already-bound users re-attest normally.
 *
 * Resolution order:
 *   1. `tenant_subscriptions.users_limit` for the latest row (0 = "fallback")
 *   2. Hardcoded per-plan default (Founders 30-signup trial; Builder 100;
 *      Starter 500; Growth 3000; Scale -1; Enterprise -1).
 *
 * -1 == unlimited.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { tenant_subscriptions, user_external_identities } from '../db/schema';
import { desc } from 'drizzle-orm';

const FALLBACK_PLAN_USERS: Record<string, number> = {
  founders: 30,
  builder: 100,
  starter: 500,
  growth: 3000,
  scale: -1,
  enterprise: -1,
};

export class UserCapExceeded extends Error {
  readonly status = 429 as const;
  override readonly name = 'UserCapExceeded';
  constructor(
    public readonly tenantId: string,
    public readonly current: number,
    public readonly limit: number,
  ) {
    super(`tenant ${tenantId} user cap reached: ${current}/${limit}`);
  }
}

function resolveFallbackUsersLimit(plan: string): number {
  return FALLBACK_PLAN_USERS[plan] ?? FALLBACK_PLAN_USERS.founders;
}

/**
 * Checks whether this tenant can accept ONE new user. Returns silently when
 * capacity exists. Throws `UserCapExceeded` when the cap is reached. No-op
 * for already-bound users — the caller must check the existing identity
 * mapping first and skip this when found.
 */
export async function requireTenantUserCapacity(tenantId: string): Promise<void> {
  const [sub] = await db
    .select({
      plan: tenant_subscriptions.plan,
      users_limit: tenant_subscriptions.users_limit,
    })
    .from(tenant_subscriptions)
    .where(and(eq(tenant_subscriptions.tenant_id, tenantId)))
    .orderBy(desc(tenant_subscriptions.created_at))
    .limit(1);

  const plan = sub?.plan ?? 'founders';
  const column = sub?.users_limit ?? 0;
  const effectiveLimit =
    column > 0 || column === -1 ? column : resolveFallbackUsersLimit(plan);

  if (effectiveLimit === -1) return; // unlimited

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(user_external_identities)
    .where(eq(user_external_identities.tenant_id, tenantId));
  const current = Number(count ?? 0);

  if (current >= effectiveLimit) {
    throw new UserCapExceeded(tenantId, current, effectiveLimit);
  }
}
