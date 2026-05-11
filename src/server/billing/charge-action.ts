/**
 * Single entry point for "charge this action against the integrator
 * quota." Wraps:
 *   - tenants.paused_at kill switch (manual pause → 503)
 *   - requireActiveTenantSubscription (canceled / past_due → 503)
 *   - BILLING_METER gate (signups → no-op for non-signup actions)
 *   - checkUserActionLimit (per-user-month cap → 429 in enforce)
 *   - BILLING_FAIRNESS debounce (same (user, tenant, provider) UTC day
 *     → key-lifecycle action collapses to one integrator-quota debit)
 *   - requireIntegratorQuota (claims slot or queues overage → 429 if hard-capped)
 *
 * Routes call `chargeAction({ tenantId, userId, providerId, action })`
 * before performing the operation, then `refundAction(...)` if anything
 * downstream fails. The returned `claim` is null when billing is off,
 * `BILLING_METER=signups` skipped the charge, or the fairness debounce
 * absorbed the day's repeat traffic — callers don't need to inspect it.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { tenants } from '../db/schema';
import { TenantInactive, billingMeter, requireActiveTenantSubscription } from './charge';
import {
  refundIntegratorQuota,
  requireIntegratorQuota,
  type QuotaClaim,
} from './quota';
import { checkUserActionLimit, decrementUserActionLimit } from '../abuse/signup-limit';

export type BillableAction =
  | 'signup'
  | 'mint'
  | 'reveal'
  | 'rotate'
  | 'revoke'
  | 'delete';

/**
 * Key-lifecycle actions that get debounced under BILLING_FAIRNESS=on.
 * Signups and deletes deliberately stay outside this set so each one
 * always bills.
 */
const DEBOUNCEABLE: ReadonlySet<BillableAction> = new Set([
  'mint',
  'reveal',
  'rotate',
  'revoke',
]);

function isDebounceable(action: BillableAction): boolean {
  return DEBOUNCEABLE.has(action);
}

/**
 * Reads `process.env.BILLING_FAIRNESS`. Defaults to `on` so 0.1.0
 * ships with the repeat-user debounce enabled. Operators can flip to
 * `off` to revert to "every action bills" if a regression appears.
 */
export function billingFairness(): 'on' | 'off' {
  return process.env.BILLING_FAIRNESS === 'off' ? 'off' : 'on';
}

function currentYmdUtc(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface ChargeActionArgs {
  /**
   * Tenant whose integrator quota gets debited. Null for accounts that
   * belong to built-in providers (neon/vercel/resend) — those have no
   * integrator backing them, so the integrator quota path is skipped
   * but the per-user-month action cap still applies. The fairness
   * debounce is also skipped when tenantId is null.
   */
  tenantId: string | null;
  userId: string;
  /**
   * Identifier of the provider this action targets (e.g. `neon`,
   * `vercel`, or a tenant-defined product slug). Required so the
   * fairness debounce can key per-(user, tenant, provider, day).
   */
  providerId: string;
  action: BillableAction;
  /**
   * Optional caller-supplied idempotency key. Signup callers pass
   * `signup_jobs.id`; non-signup callers can leave it blank to get a
   * generated UUID.
   */
  idempotencyKey?: string;
}

export interface ChargeReceipt {
  /** Idempotency key used; pass to refundAction on rollback. */
  idempotencyKey: string;
  /** Quota claim, or null when the charge was skipped. */
  claim: QuotaClaim | null;
  /** True when the action's user-counter was bumped. */
  userCounterBumped: boolean;
  /**
   * True when the fairness debounce absorbed this action — the
   * (user, tenant, provider, day) triple was already paid for today
   * so the integrator-quota path was skipped. `claim` will be null.
   */
  debouncedAway: boolean;
}

async function ensureNotPaused(tenantId: string): Promise<void> {
  const [row] = await db
    .select({ paused_at: tenants.paused_at })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (row?.paused_at) throw new TenantInactive(tenantId, 'paused');
}

/**
 * Charge one action against the integrator's quota and the user's cap.
 * Throws TenantInactive (503), UserRateLimited (429), or
 * IntegratorQuotaExhausted (429). On success, the returned receipt
 * lets the caller refund the slot if the action fails downstream.
 *
 * tenantId=null skips the integrator-quota and tenant-gate paths
 * (built-in provider accounts have no tenant). The per-user-month cap
 * still applies.
 *
 * Fairness debounce: when BILLING_FAIRNESS=on, a debounceable action
 * (mint/reveal/rotate/revoke) on a triple `(userId, tenantId, providerId)`
 * that has already been billed for today's UTC date will skip the
 * integrator-quota debit and return `debouncedAway: true`. Per-user
 * abuse caps still run on top so a runaway user can't hide behind
 * the debounce.
 */
export async function chargeAction(args: ChargeActionArgs): Promise<ChargeReceipt> {
  const idempotencyKey = args.idempotencyKey ?? randomUUID();
  const meter = billingMeter();
  const isSignup = args.action === 'signup';
  const debounceable = isDebounceable(args.action);

  // 1. Kill switch + active subscription gate (tenant-scoped only).
  if (args.tenantId) {
    await ensureNotPaused(args.tenantId);
    await requireActiveTenantSubscription(args.tenantId);
  }

  // 2. Per-user-month action cap (always on; covers all billable
  //    actions). Signup-specific cap stays where it is.
  // checkUserActionLimit returns null when ABUSE_ENFORCEMENT=off
  // (no row was bumped) — only mark the counter "bumped" when it
  // actually ticked.
  let userCounterBumped = false;
  if (!isSignup) {
    const count = await checkUserActionLimit(args.userId);
    userCounterBumped = count != null;
  }

  // 3. Fairness debounce. Atomically bump the day-counter for the
  //    (user, tenant, provider, ymd_utc) triple. The first hit of the
  //    day returns count=1 and falls through to the integrator-quota
  //    claim. Subsequent same-day hits return count>1 and short-circuit
  //    (no integrator-quota debit, no claim returned).
  let debouncedAway = false;
  if (
    args.tenantId &&
    debounceable &&
    meter === 'actions' &&
    billingFairness() === 'on'
  ) {
    const ymd = currentYmdUtc();
    const result = await db.execute(sql`
      INSERT INTO user_provider_action_days
        (user_id, tenant_id, provider_id, ymd_utc, action_count, first_action_at)
      VALUES (${args.userId}, ${args.tenantId}, ${args.providerId}, ${ymd}, 1, now())
      ON CONFLICT (user_id, tenant_id, provider_id, ymd_utc) DO UPDATE
        SET action_count = user_provider_action_days.action_count + 1
      RETURNING action_count
    `);
    const row = (result as unknown as { rows?: Array<{ action_count: number | string }> })
      .rows?.[0];
    const count = row ? Number(row.action_count) : 1;
    if (count > 1) {
      debouncedAway = true;
      return {
        idempotencyKey,
        claim: null,
        userCounterBumped,
        debouncedAway,
      };
    }
  }

  // 4. Integrator quota claim. Skip when there's no tenant, or when
  //    the meter is in `signups` mode and the action isn't a signup
  //    (soft-launch path keeps existing tenants on the legacy meter).
  let claim: QuotaClaim | null = null;
  if (args.tenantId && (isSignup || meter === 'actions')) {
    try {
      claim = await requireIntegratorQuota({
        tenantId: args.tenantId,
        idempotencyKey,
      });
    } catch (err) {
      // Claim failed — undo the user-counter bump so the user isn't
      // taxed for an action that never charged. Also unwind the
      // fairness day-counter if we just inserted today's first row;
      // otherwise the next attempt would silently debounce as if it
      // had already been billed.
      if (userCounterBumped) {
        await decrementUserActionLimit(args.userId).catch(() => {});
      }
      if (
        args.tenantId &&
        debounceable &&
        meter === 'actions' &&
        billingFairness() === 'on'
      ) {
        const ymd = currentYmdUtc();
        await db
          .execute(sql`
            UPDATE user_provider_action_days
               SET action_count = GREATEST(action_count - 1, 0)
             WHERE user_id = ${args.userId}
               AND tenant_id = ${args.tenantId}
               AND provider_id = ${args.providerId}
               AND ymd_utc = ${ymd}
          `)
          .catch(() => {});
      }
      throw err;
    }
  }

  return { idempotencyKey, claim, userCounterBumped, debouncedAway };
}

/**
 * Reverse a prior `chargeAction`. Idempotent on idempotencyKey. Calls
 * decrementUserActionLimit only when the original charge bumped the
 * user counter (i.e. non-signup actions). Signup refunds are still
 * the responsibility of the signup workflow's own decrement helper.
 */
export async function refundAction(
  args: { tenantId: string | null; userId: string; receipt: ChargeReceipt },
): Promise<void> {
  if (args.tenantId && args.receipt.claim) {
    await refundIntegratorQuota({
      tenantId: args.tenantId,
      idempotencyKey: args.receipt.idempotencyKey,
    }).catch(() => {});
  }
  if (args.receipt.userCounterBumped) {
    await decrementUserActionLimit(args.userId).catch(() => {});
  }
}
