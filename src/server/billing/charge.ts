/**
 * Billing middleware — integrator-only revenue.
 *
 * End-users are free; integrators pay a subscription with included action
 * quota and overage. This file keeps the tenant-side guards: subscription
 * state gate, per-month Actions quota, and the three-mode enforcement toggle.
 */
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { tenant_subscriptions } from '../db/schema';

// --- Errors ---------------------------------------------------------------

/** 503 Service Unavailable — tenant subscription missing / canceled / expired. */
export class TenantInactive extends Error {
  readonly status = 503 as const;
  override readonly name = 'TenantInactive';
  constructor(
    public readonly tenantId: string,
    public readonly state: string,
  ) {
    super(`tenant ${tenantId} subscription is ${state}`);
  }
}

/**
 * 429 Too Many Requests — tenant has burned through its per-month Action
 * quota past the 110 % soft cap. Within the soft cap,
 * `requireActionsQuotaAvailable` still returns `{ overage: true }` and the
 * execute path keeps running.
 */
export class ActionQuotaExceeded extends Error {
  readonly status = 429 as const;
  override readonly name = 'ActionQuotaExceeded';
  constructor(
    public readonly tenantId: string,
    public readonly current: number,
    public readonly included: number,
  ) {
    super(
      `tenant ${tenantId} action quota exceeded: used ${current}/${included}`,
    );
  }
}

// --- Tenant subscription cache (30s TTL) ----------------------------------

const TENANT_TTL_MS = 30_000;

interface TenantSub {
  status: string;
  plan: string;
  current_period_end: Date | null;
  trial_ends_at: Date | null;
}

const subCache = new Map<string, { at: number; sub: TenantSub | null }>();

async function loadActiveSubscription(tenantId: string): Promise<TenantSub | null> {
  const cached = subCache.get(tenantId);
  if (cached && Date.now() - cached.at < TENANT_TTL_MS) return cached.sub;
  const [row] = await db
    .select({
      status: tenant_subscriptions.status,
      plan: tenant_subscriptions.plan,
      current_period_end: tenant_subscriptions.current_period_end,
      trial_ends_at: tenant_subscriptions.trial_ends_at,
    })
    .from(tenant_subscriptions)
    .where(eq(tenant_subscriptions.tenant_id, tenantId))
    .orderBy(desc(tenant_subscriptions.created_at))
    .limit(1);
  const sub: TenantSub | null = row
    ? {
        status: row.status,
        plan: row.plan,
        current_period_end: row.current_period_end,
        trial_ends_at: row.trial_ends_at,
      }
    : null;
  subCache.set(tenantId, { at: Date.now(), sub });
  return sub;
}

/** Drop a cached subscription — called by the Stripe webhook on state changes. */
export function invalidateTenantCache(tenantId: string): void {
  subCache.delete(tenantId);
}

/**
 * Throws `TenantInactive` unless the tenant has an active or trialing
 * subscription with a future `current_period_end` / `trial_ends_at`.
 */
export async function requireActiveTenantSubscription(tenantId: string): Promise<void> {
  const sub = await loadActiveSubscription(tenantId);
  if (!sub) throw new TenantInactive(tenantId, 'none');
  if (sub.status === 'canceled' || sub.status === 'past_due') {
    throw new TenantInactive(tenantId, sub.status);
  }
  const periodEnd =
    sub.status === 'trialing' ? sub.trial_ends_at : sub.current_period_end;
  if (periodEnd && periodEnd.getTime() < Date.now()) {
    throw new TenantInactive(tenantId, 'expired');
  }
}

// --- Enforcement mode -----------------------------------------------------

/** Reads `process.env.BILLING_ENFORCEMENT`. Defaults to `off` when unset. */
export function billingMode(): 'off' | 'warn' | 'enforce' {
  const v = process.env.BILLING_ENFORCEMENT;
  if (v === 'enforce') return 'enforce';
  if (v === 'warn') return 'warn';
  return 'off';
}

/**
 * Reads `process.env.BILLING_METER`. Defaults to `signups` so production
 * behaviour is unchanged until ops deliberately flips a tenant onto the
 * action meter. `actions` mode charges the integrator quota for every
 * billable operation (signup + reveal + revoke + delete); `signups` only
 * charges signups.
 */
export function billingMeter(): 'signups' | 'actions' {
  const v = process.env.BILLING_METER;
  if (v === 'actions') return 'actions';
  return 'signups';
}

// --- Actions API: per-month volume quota gate -----------------------------

const ACTIONS_SOFT_CAP_PCT = 110; // soft cap before 429

interface ActionQuotaResult {
  /** Counter value after this call (includes self). */
  used: number;
  /** Cap from tenant_subscriptions.actions_included (-1 == unlimited). */
  included: number;
  /** True when `used > included` but still within the 110 % soft cap. */
  overage: boolean;
}

/**
 * Atomically claims one slot against the tenant's monthly action quota.
 *
 * The UPDATE rolls `period_resets_at` forward if it has passed (so we
 * don't need a separate reset cron) and increments `actions_used_period`
 * in the same statement. When the plan is unlimited (`actions_included =
 * -1`) or the counter is strictly below the cap, the row is updated and
 * returned. Past `actions_included` but within the 110 % soft cap, the
 * row is still updated — callers should mark the invocation `status =
 * 'overage'` and bill via the overage ledger. Past 110 %, no row is
 * returned and we throw `ActionQuotaExceeded` → 429.
 *
 * Callers should invoke this AFTER `requireActiveTenantSubscription()`
 * so canceled / past-due tenants see 503 first.
 */
export async function requireActionsQuotaAvailable(
  tenantId: string,
): Promise<ActionQuotaResult> {
  const cap = ACTIONS_SOFT_CAP_PCT / 100;
  const result = await db.execute(sql`
    UPDATE tenant_subscriptions
       SET actions_used_period = CASE
             WHEN COALESCE(period_resets_at, '1970-01-01'::timestamptz) <= now()
             THEN 1
             ELSE actions_used_period + 1
           END,
           period_resets_at = CASE
             WHEN COALESCE(period_resets_at, '1970-01-01'::timestamptz) <= now()
             THEN now() + interval '30 days'
             ELSE period_resets_at
           END,
           updated_at = now()
     WHERE id = (
       SELECT id FROM tenant_subscriptions
        WHERE tenant_id = ${tenantId}
          AND status IN ('active','trialing')
        ORDER BY created_at DESC
        LIMIT 1
     )
       AND (
         actions_included = -1
         OR (CASE
               WHEN COALESCE(period_resets_at, '1970-01-01'::timestamptz) <= now()
               THEN 1
               ELSE actions_used_period + 1
             END) <= actions_included * ${cap}
       )
    RETURNING actions_used_period, actions_included
  `);

  const row = (result as unknown as {
    rows?: Array<{ actions_used_period: number | string; actions_included: number | string }>;
  }).rows?.[0];

  if (!row) {
    // Either no active subscription or the soft cap was crossed. Load the
    // latest row to surface a useful error body.
    const [latest] = await db
      .select({
        actions_used_period: tenant_subscriptions.actions_used_period,
        actions_included: tenant_subscriptions.actions_included,
      })
      .from(tenant_subscriptions)
      .where(eq(tenant_subscriptions.tenant_id, tenantId))
      .orderBy(desc(tenant_subscriptions.created_at))
      .limit(1);
    throw new ActionQuotaExceeded(
      tenantId,
      latest?.actions_used_period ?? 0,
      latest?.actions_included ?? 0,
    );
  }

  const used = Number(row.actions_used_period);
  const included = Number(row.actions_included);
  const overage = included !== -1 && used > included;
  return { used, included, overage };
}
