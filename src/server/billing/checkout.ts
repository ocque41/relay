/**
 * Stripe checkout + billing portal helpers.
 *
 * Shared code path for the HTTP routes (/v1/dev/billing/subscribe,
 * /v1/dev/billing/portal) and the MCP tool (start_subscription). Callers pass
 * identity (tenantId, actingUserId) and this module handles:
 *
 *   - plan → Stripe price id lookup via env vars
 *   - tenant-owner email resolution (with caller-email fallback)
 *   - Stripe Checkout (mode=subscription) session creation
 *   - Stripe Billing Portal session creation (for already-subscribed tenants)
 *   - "already active?" probe so start_subscription can return a portal URL
 *     instead of creating a second subscription
 *
 * Failure modes are surfaced via a small `BillingCheckoutFailure` class rather
 * than raw Stripe errors so upstream HTTP and MCP layers return consistent
 * structured bodies.
 */
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index';
import { tenant_subscriptions, tenants, users } from '../db/schema';
import { stripe } from './stripe';

export type PlanId = 'founders' | 'builder' | 'starter' | 'growth' | 'scale';

/** Subscription billing cadence. Founders is a free trial; only paid plans
 *  expose the yearly toggle. */
export type BillingInterval = 'monthly' | 'yearly';

/** Plan ids that map to a Stripe `STRIPE_PRICE_*` env var. */
export const CHECKOUT_PLANS: readonly PlanId[] = [
  'builder',
  'starter',
  'growth',
  'scale',
] as const;

/** Plans that can be purchased on a yearly cadence. Founders is monthly-only. */
export const YEARLY_PLANS: readonly PlanId[] = [
  'builder',
  'starter',
  'growth',
  'scale',
] as const;

export type BillingFailureKind =
  | 'plan_not_configured'
  | 'no_stripe_customer'
  | 'stripe_no_url'
  | 'pack_not_configured'
  | 'no_active_subscription';

export class BillingCheckoutFailure extends Error {
  constructor(
    readonly kind: BillingFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'BillingCheckoutFailure';
  }
}

/**
 * Resolve the Stripe Price ID for a given plan + interval combination.
 * Returns `null` when the matching env var is unset (e.g. `founders` has
 * no Stripe price; yearly env vars unset on a fresh install).
 */
export function priceIdForPlan(
  plan: PlanId,
  interval: BillingInterval = 'monthly',
): string | null {
  if (interval === 'yearly') {
    switch (plan) {
      case 'founders':
        return null; // Founders is a free trial; no yearly Stripe price.
      case 'builder':
        return process.env.STRIPE_PRICE_BUILDER_YEARLY ?? null;
      case 'starter':
        return process.env.STRIPE_PRICE_STARTER_YEARLY ?? null;
      case 'growth':
        return process.env.STRIPE_PRICE_GROWTH_YEARLY ?? null;
      case 'scale':
        return process.env.STRIPE_PRICE_SCALE_YEARLY ?? null;
    }
  }
  switch (plan) {
    case 'founders':
      return process.env.STRIPE_PRICE_FOUNDERS ?? null;
    case 'builder':
      return process.env.STRIPE_PRICE_BUILDER ?? null;
    case 'starter':
      return process.env.STRIPE_PRICE_STARTER ?? null;
    case 'growth':
      return process.env.STRIPE_PRICE_GROWTH ?? null;
    case 'scale':
      return process.env.STRIPE_PRICE_SCALE ?? null;
  }
}

export function appBaseUrl(): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (host) return `https://${host.replace(/^https?:\/\//, '')}`;
  return 'http://localhost:3000';
}

/** Latest subscription row for a tenant. */
export async function getLatestSubscription(tenantId: string): Promise<{
  id: string;
  status: string;
  plan: string;
  stripeCustomerId: string | null;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  canceledAt: Date | null;
} | null> {
  const [row] = await db
    .select({
      id: tenant_subscriptions.id,
      status: tenant_subscriptions.status,
      plan: tenant_subscriptions.plan,
      stripe_customer_id: tenant_subscriptions.stripe_customer_id,
      current_period_end: tenant_subscriptions.current_period_end,
      trial_ends_at: tenant_subscriptions.trial_ends_at,
      canceled_at: tenant_subscriptions.canceled_at,
    })
    .from(tenant_subscriptions)
    .where(eq(tenant_subscriptions.tenant_id, tenantId))
    .orderBy(desc(tenant_subscriptions.created_at))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    plan: row.plan,
    stripeCustomerId: row.stripe_customer_id ?? null,
    currentPeriodEnd: row.current_period_end ?? null,
    trialEndsAt: row.trial_ends_at ?? null,
    canceledAt: row.canceled_at ?? null,
  };
}

/**
 * Status values that mean "Stripe already has this tenant on the hook for a
 * recurring charge; do not create a second checkout session, open the Billing
 * Portal instead." `past_due` is included because Stripe already owns the
 * dunning loop — pushing the user through a second Checkout flow would leave
 * both subscriptions live.
 */
export function isSubscriptionActive(status: string | null | undefined): boolean {
  return status === 'trialing' || status === 'active' || status === 'past_due';
}

/**
 * Resolve the best email to prefill on the Checkout session.
 *
 * 1. Tenant owner's email (matches dashboard-billing behavior).
 * 2. Caller's email (fallback when the caller is an agent for an owner we
 *    can't look up — e.g. a member acting on behalf of the tenant).
 * 3. undefined (Stripe will collect it).
 */
async function resolveCheckoutEmail(
  tenantId: string,
  actingUserId: string,
): Promise<string | undefined> {
  const [tenantRow] = await db
    .select({ owner_user_id: tenants.owner_user_id })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (tenantRow) {
    const [owner] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, tenantRow.owner_user_id))
      .limit(1);
    if (owner?.email) return owner.email;
  }
  const [caller] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, actingUserId))
    .limit(1);
  return caller?.email ?? undefined;
}

export interface CreateCheckoutOptions {
  tenantId: string;
  actingUserId: string;
  plan: PlanId;
  /** Billing cadence. Defaults to `'monthly'` when omitted (back-compat). */
  interval?: BillingInterval;
  baseUrl?: string;
}

export interface CheckoutSession {
  url: string;
  sessionId: string;
  expiresAt: Date;
}

/** Create a Stripe Checkout session for a new subscription. */
export async function createCheckoutSession(
  opts: CreateCheckoutOptions,
): Promise<CheckoutSession> {
  const interval: BillingInterval = opts.interval ?? 'monthly';
  const price = priceIdForPlan(opts.plan, interval);
  if (!price) {
    throw new BillingCheckoutFailure(
      'plan_not_configured',
      `plan ${opts.plan} (${interval}) is not configured on this Relay instance`,
    );
  }

  const customerEmail = await resolveCheckoutEmail(
    opts.tenantId,
    opts.actingUserId,
  );
  const base = opts.baseUrl ?? appBaseUrl();

  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    metadata: {
      tenant_id: opts.tenantId,
      plan: opts.plan,
      billing_interval: interval,
    },
    subscription_data: {
      metadata: {
        tenant_id: opts.tenantId,
        plan: opts.plan,
        billing_interval: interval,
      },
    },
    customer_email: customerEmail,
    success_url: `${base}/dev/billing?status=success`,
    cancel_url: `${base}/dev/billing?status=cancel`,
    allow_promotion_codes: true,
  });

  if (!session.url) {
    throw new BillingCheckoutFailure(
      'stripe_no_url',
      'stripe did not return a checkout url',
    );
  }

  return {
    url: session.url,
    sessionId: session.id,
    expiresAt: new Date((session.expires_at ?? 0) * 1000),
  };
}

export interface CreateBillingPortalOptions {
  tenantId: string;
  baseUrl?: string;
}

/** Create a Stripe Billing Portal session for an already-subscribed tenant. */
export async function createBillingPortalSession(
  opts: CreateBillingPortalOptions,
): Promise<{ url: string }> {
  const sub = await getLatestSubscription(opts.tenantId);
  if (!sub?.stripeCustomerId) {
    throw new BillingCheckoutFailure(
      'no_stripe_customer',
      'no stripe customer on file; subscribe before opening the portal',
    );
  }
  const base = opts.baseUrl ?? appBaseUrl();
  const portal = await stripe().billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: `${base}/dev/billing`,
  });
  return { url: portal.url };
}
