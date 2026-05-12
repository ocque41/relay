/**
 * Integrator action-quota enforcement.
 *
 * Originally a signup-only meter, now generalised to any billable
 * action (signup + reveal + revoke + delete) gated by
 * `BILLING_METER=actions`. The signup path still passes its
 * `signup_jobs.id` as the idempotency key; reveal/revoke/delete pass
 * a generated UUID.
 *
 * The flow:
 *   1. requireIntegratorQuota({ tenantId, idempotencyKey }) before the
 *      action dispatches. Atomic decrement of
 *      tenant_quota_state.included_remaining. If the counter was zero,
 *      the helper queues a row in stripe_pending_invoice_items (overage)
 *      and bumps tenant_quota_state.overage_count. A tenant with no
 *      quota state at all falls through to the Founders-trial bootstrap.
 *   2. If the action fails, the caller invokes
 *      refundIntegratorQuota({ tenantId, idempotencyKey }) to credit
 *      the slot back. Idempotent on idempotency_key.
 *
 * Concurrency: both helpers use single-statement UPDATEs with a guard
 * clause in the WHERE, so races between two concurrent dispatches can't
 * over-decrement a counter. The overage insert is ON CONFLICT DO NOTHING
 * on idempotency_key so a retry after a partial failure is safe.
 *
 * Plan catalog lookup is cached with a 60 s TTL mirroring charge.ts's
 * subCache pattern.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import {
  action_credit_consumptions,
  action_credits,
  plan_catalog,
  stripe_pending_invoice_items,
  tenant_quota_state,
  tenant_subscriptions,
} from '../db/schema';
import { billingMode } from './charge';

// --- Errors ---------------------------------------------------------------

/**
 * Thrown when a tenant's plan is hard-capped (Enterprise placeholder with
 * overage_price_cents=0) and the quota has been exhausted. Routes map this
 * to HTTP 429.
 */
export class IntegratorQuotaExhausted extends Error {
  readonly status = 429 as const;
  override readonly name = 'IntegratorQuotaExhausted';
  constructor(
    public readonly tenantId: string,
    public readonly plan: string,
  ) {
    super(`tenant ${tenantId} has no remaining action quota on plan ${plan}`);
  }
}

// --- Plan catalog cache (60s TTL) -----------------------------------------

interface PlanRow {
  id: string;
  display_name: string;
  price_cents: number;
  included_actions: number;
  overage_price_cents: number;
  trial_actions: number | null;
  trial_days: number | null;
  sla_target: string | null;
}

const PLAN_TTL_MS = 60_000;
let planCache: { at: number; plans: Map<string, PlanRow> } | null = null;

async function loadPlanCatalog(): Promise<Map<string, PlanRow>> {
  if (planCache && Date.now() - planCache.at < PLAN_TTL_MS) {
    return planCache.plans;
  }
  const rows = await db.select().from(plan_catalog);
  const plans = new Map<string, PlanRow>();
  for (const r of rows) {
    plans.set(r.id, {
      id: r.id,
      display_name: r.display_name,
      price_cents: r.price_cents,
      included_actions: r.included_actions,
      overage_price_cents: r.overage_price_cents,
      trial_actions: r.trial_actions,
      trial_days: r.trial_days,
      sla_target: r.sla_target,
    });
  }
  planCache = { at: Date.now(), plans };
  return plans;
}

/** Drop the plan cache — call from the Stripe webhook on plan_catalog edits. */
export function invalidatePlanCatalogCache(): void {
  planCache = null;
}

/** Look up a plan by id; returns null if the plan was deleted. */
export async function getPlan(planId: string): Promise<PlanRow | null> {
  const plans = await loadPlanCatalog();
  return plans.get(planId) ?? null;
}

// --- Active subscription lookup ------------------------------------------

async function latestSubscription(tenantId: string): Promise<{
  plan: string;
  stripe_subscription_id: string | null;
} | null> {
  const [row] = await db
    .select({
      plan: tenant_subscriptions.plan,
      stripe_subscription_id: tenant_subscriptions.stripe_subscription_id,
    })
    .from(tenant_subscriptions)
    .where(eq(tenant_subscriptions.tenant_id, tenantId))
    .orderBy(desc(tenant_subscriptions.created_at))
    .limit(1);
  return row ?? null;
}

// --- Enforcement ---------------------------------------------------------

export interface QuotaClaim {
  /**
   * True when the claim was free against the integrator's bill — either
   * it consumed a plan-included slot (`source: 'plan'`) or a prepaid
   * credit-pack action (`source: 'credits'`). False only when an
   * overage row was queued.
   */
  included: boolean;
  /**
   * Which tier of the ladder absorbed the claim:
   *   - 'plan'     → debited tenant_quota_state.included_remaining
   *   - 'credits'  → debited action_credits.actions_remaining (FIFO)
   *   - 'overage'  → queued a stripe_pending_invoice_items row
   */
  source: 'plan' | 'credits' | 'overage';
  /** Included slots left after this claim. Zero when credits/overage kicked in. */
  includedRemaining: number;
  /** Number of overage actions queued so far this period. */
  overageCount: number;
  /** Sum of actions_remaining across unexpired credit packs (post-claim). */
  creditsRemaining: number;
}

export interface ClaimArgs {
  tenantId: string;
  /**
   * Unique key for the overage-row idempotency check. Signup callers
   * pass `signup_jobs.id`; reveal/revoke/delete pass a generated UUID
   * scoped to that operation. `signupJobId` is accepted as a backwards-
   * compatible alias for the same thing.
   */
  idempotencyKey?: string;
  /** @deprecated use idempotencyKey. Kept for the signup call site. */
  signupJobId?: string;
}

function resolveKey(args: ClaimArgs): string {
  const k = args.idempotencyKey ?? args.signupJobId;
  if (!k) throw new Error('quota claim requires idempotencyKey or signupJobId');
  return k;
}

/**
 * Sum of actions_remaining across unexpired credit packs for the tenant.
 * Used to fill out the QuotaClaim summary. Cheap thanks to the partial
 * index from migration 0025.
 */
async function sumCreditsRemaining(tenantId: string): Promise<number> {
  const out = await db.execute(sql`
    SELECT COALESCE(SUM(actions_remaining), 0) AS total
      FROM action_credits
     WHERE tenant_id = ${tenantId}
       AND actions_remaining > 0
       AND expires_at > now()
  `);
  const row = (out as unknown as { rows?: Array<{ total: number | string }> }).rows?.[0];
  return row ? Number(row.total) : 0;
}

/**
 * Atomically claim one action slot for this tenant. Returns a `QuotaClaim`
 * describing which tier of the ladder absorbed the claim:
 *   - plan-included pool
 *   - credit packs (FIFO by expiry)
 *   - overage queue
 * Throws `IntegratorQuotaExhausted` when ALL three are exhausted on a
 * hard-capped plan (no overage_price_cents). No-op when
 * `BILLING_ENFORCEMENT=off`.
 */
export async function requireIntegratorQuota(args: ClaimArgs): Promise<QuotaClaim | null> {
  if (billingMode() === 'off') return null;
  const key = resolveKey(args);

  // 1. Try to consume one plan-included slot atomically.
  const included = await db.execute(sql`
    UPDATE tenant_quota_state
       SET included_remaining = included_remaining - 1,
           updated_at         = now()
     WHERE tenant_id = ${args.tenantId}
       AND included_remaining > 0
    RETURNING included_remaining, overage_count
  `);
  const row0 = (included as unknown as {
    rows?: Array<{ included_remaining: number; overage_count: number }>;
  }).rows?.[0];

  if (row0) {
    const creditsRemaining = await sumCreditsRemaining(args.tenantId);
    return {
      included: true,
      source: 'plan',
      includedRemaining: Number(row0.included_remaining),
      overageCount: Number(row0.overage_count),
      creditsRemaining,
    };
  }

  // 2. Plan pool empty — try credit packs FIFO by expiry.
  //    Atomic UPDATE on the earliest-expiring unexpired row with
  //    actions_remaining > 0. SKIP LOCKED keeps two concurrent claims
  //    from picking the same row.
  const credit = await db.execute(sql`
    UPDATE action_credits
       SET actions_remaining = actions_remaining - 1,
           updated_at        = now()
     WHERE id = (
       SELECT id
         FROM action_credits
        WHERE tenant_id = ${args.tenantId}
          AND actions_remaining > 0
          AND expires_at > now()
        ORDER BY expires_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, actions_remaining
  `);
  const creditRow = (credit as unknown as {
    rows?: Array<{ id: string; actions_remaining: number | string }>;
  }).rows?.[0];

  if (creditRow) {
    // Audit the consumption so refundIntegratorQuota can find the same
    // row by idempotency_key. UNIQUE on idempotency_key makes this
    // idempotent.
    await db
      .insert(action_credit_consumptions)
      .values({
        tenant_id: args.tenantId,
        action_credit_id: creditRow.id,
        idempotency_key: key,
      })
      .onConflictDoNothing({ target: action_credit_consumptions.idempotency_key });

    // Read the current quota state (we didn't mutate it; pull it for
    // the receipt).
    const stateOut = await db.execute(sql`
      SELECT included_remaining, overage_count
        FROM tenant_quota_state
       WHERE tenant_id = ${args.tenantId}
       LIMIT 1
    `);
    const stateRow = (stateOut as unknown as {
      rows?: Array<{ included_remaining: number; overage_count: number }>;
    }).rows?.[0];
    const creditsRemaining = await sumCreditsRemaining(args.tenantId);
    return {
      included: true,
      source: 'credits',
      includedRemaining: stateRow ? Number(stateRow.included_remaining) : 0,
      overageCount: stateRow ? Number(stateRow.overage_count) : 0,
      creditsRemaining,
    };
  }

  // 3. Plan + credits exhausted — check the plan's overage policy.
  const sub = await latestSubscription(args.tenantId);
  const planId = sub?.plan ?? 'founders';
  const plan = await getPlan(planId);

  // No catalog row or no overage allowed → hard cap.
  if (!plan || plan.overage_price_cents <= 0) {
    throw new IntegratorQuotaExhausted(args.tenantId, planId);
  }

  // 4. Queue an overage invoice item. ON CONFLICT DO NOTHING makes this
  //    idempotent on idempotency_key (retries are safe). signup_job_id
  //    is populated only when the caller passed one (signup path); for
  //    other actions it stays NULL.
  await db
    .insert(stripe_pending_invoice_items)
    .values({
      tenant_id: args.tenantId,
      signup_job_id: args.signupJobId ?? null,
      idempotency_key: key,
      amount_cents: plan.overage_price_cents,
      stripe_subscription_id: sub?.stripe_subscription_id ?? null,
    })
    .onConflictDoNothing({ target: stripe_pending_invoice_items.idempotency_key });

  const overage = await db.execute(sql`
    UPDATE tenant_quota_state
       SET overage_count = overage_count + 1,
           updated_at    = now()
     WHERE tenant_id = ${args.tenantId}
    RETURNING included_remaining, overage_count
  `);
  const row1 = (overage as unknown as {
    rows?: Array<{ included_remaining: number; overage_count: number }>;
  }).rows?.[0];

  return {
    included: false,
    source: 'overage',
    includedRemaining: row1 ? Number(row1.included_remaining) : 0,
    overageCount: row1 ? Number(row1.overage_count) : 1,
    creditsRemaining: 0,
  };
}

/**
 * Reverse a prior claim. Idempotent on the idempotency key. Unwinds in
 * the same order requireIntegratorQuota would have charged:
 *
 *   1. If a pending overage row exists for this key, delete it and
 *      decrement overage_count.
 *   2. Else if a credit-pack consumption record exists for this key,
 *      restore the slot on the same action_credits row.
 *   3. Else assume the claim consumed a plan-included slot and credit
 *      that back.
 *
 * No-op when `BILLING_ENFORCEMENT=off`.
 */
export async function refundIntegratorQuota(args: ClaimArgs): Promise<void> {
  if (billingMode() === 'off') return;
  const key = resolveKey(args);

  // 1. Was this claim on the overage queue and not yet flushed to Stripe?
  const deleted = await db
    .delete(stripe_pending_invoice_items)
    .where(
      and(
        eq(stripe_pending_invoice_items.tenant_id, args.tenantId),
        eq(stripe_pending_invoice_items.idempotency_key, key),
      ),
    )
    .returning({ id: stripe_pending_invoice_items.id });

  if (deleted.length > 0) {
    await db.execute(sql`
      UPDATE tenant_quota_state
         SET overage_count = GREATEST(overage_count - 1, 0),
             updated_at    = now()
       WHERE tenant_id = ${args.tenantId}
    `);
    return;
  }

  // 2. Was this claim consumed from a credit pack? Restore on the same
  //    action_credits row, then delete the consumption record so this
  //    refund is idempotent against repeat calls.
  const restored = await db.execute(sql`
    WITH consumption AS (
      DELETE FROM action_credit_consumptions
       WHERE tenant_id = ${args.tenantId}
         AND idempotency_key = ${key}
      RETURNING action_credit_id
    )
    UPDATE action_credits
       SET actions_remaining = LEAST(
             actions_remaining + 1,
             actions_purchased
           ),
           updated_at = now()
     WHERE id IN (SELECT action_credit_id FROM consumption)
    RETURNING id
  `);
  const restoredRow = (restored as unknown as { rows?: Array<{ id: string }> }).rows?.[0];
  if (restoredRow) return;

  // 3. Otherwise it must have consumed a plan-included slot.
  await db.execute(sql`
    UPDATE tenant_quota_state
       SET included_remaining = included_remaining + 1,
           updated_at         = now()
     WHERE tenant_id = ${args.tenantId}
  `);
}

// --- Quota reset on subscription webhook ---------------------------------

/**
 * Called from the Stripe webhook when a billing period starts or a plan
 * changes. Upserts `tenant_quota_state` with the fresh `included_actions`
 * from `plan_catalog`, anchoring the period to the subscription's
 * current_period_end. Overage counter resets to zero with the new period.
 */
export async function resetQuotaForPeriod(args: {
  tenantId: string;
  planId: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<void> {
  const plan = await getPlan(args.planId);
  // Unknown plan id → seed with Founders trial so the dispatch path doesn't
  // explode in prod. The operator will notice via Sentry when this happens.
  const included = plan?.included_actions ?? 100;

  await db
    .insert(tenant_quota_state)
    .values({
      tenant_id: args.tenantId,
      period_start: args.periodStart,
      period_end: args.periodEnd,
      included_remaining: included,
      overage_count: 0,
    })
    .onConflictDoUpdate({
      target: tenant_quota_state.tenant_id,
      set: {
        period_start: args.periodStart,
        period_end: args.periodEnd,
        included_remaining: included,
        overage_count: 0,
        updated_at: new Date(),
      },
    });
}
