/**
 * Credit-pack purchase flow (mode=payment Stripe Checkout).
 *
 * Companion to checkout.ts. Lets an integrator who has burned through
 * their plan-included monthly quota buy a one-shot pack of extra
 * actions priced 20% below the plan's overage rate. Credits FIFO-
 * consume *after* plan headroom is exhausted and *before* overage
 * queues a per-action invoice item.
 *
 * Flow:
 *   1. Tenant POSTs /v1/dev/billing/credits/checkout { pack }.
 *   2. createCreditCheckoutSession() builds a mode=payment session
 *      with metadata.tenant_id, metadata.pack, and the right Stripe
 *      Price ID. The customer is reused from the active subscription
 *      so the receipt lands on the integrator's existing invoice
 *      history.
 *   3. Stripe completes Checkout → fires checkout.session.completed
 *      with mode=payment.
 *   4. The webhook handler routes mode=payment to applyCreditPurchase()
 *      which inserts an `action_credits` row with actions_remaining =
 *      pack.actions and expires_at = now + 12 months. The
 *      stripe_payment_intent_id UNIQUE constraint makes that path
 *      idempotent on retries.
 *
 * Pack catalog and pricing live in PACK_DEFS below — they're the
 * source of truth for the UI / docs / eval. Stripe Price IDs are
 * resolved from STRIPE_PRICE_CREDITS_<PLAN> env vars; the
 * provisioning script (scripts/stripe-provision-prices.ts) creates
 * them in both live and test mode.
 */
import type Stripe from 'stripe';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/index';
import {
  action_credits,
  tenant_subscriptions,
  tenants,
  users,
} from '../db/schema';
import { stripe } from './stripe';
import {
  BillingCheckoutFailure,
  appBaseUrl,
  type PlanId,
} from './checkout';

/** Pack identifiers — one SKU per paid plan. Founders has no pack. */
export type CreditPackId = 'builder' | 'starter' | 'growth' | 'scale';

export const CREDIT_PACK_IDS: readonly CreditPackId[] = [
  'builder',
  'starter',
  'growth',
  'scale',
] as const;

export interface CreditPackDef {
  id: CreditPackId;
  /** Plan this pack is sized for (matches PlanId). */
  plan: PlanId;
  /** Total actions the buyer receives. */
  actions: number;
  /** Pre-tax USD price in cents. */
  amountCents: number;
  /** Effective $/action — derived; included for UI/docs convenience. */
  effectiveCentsPerAction: number;
}

/**
 * Catalog of available credit packs. Sized at ~50% of the plan's
 * monthly quota, priced 20% below the plan's overage rate.
 *
 *   Builder:  500 actions / $20  → $0.040/action  (overage: $0.05)
 *   Starter:  5,000 actions / $80 → $0.016/action (overage: $0.02)
 *   Growth:   25,000 actions / $400 → $0.016/action
 *   Scale:    100,000 actions / $800 → $0.008/action (overage: $0.01)
 */
export const PACK_DEFS: Record<CreditPackId, CreditPackDef> = {
  builder: {
    id: 'builder',
    plan: 'builder',
    actions: 500,
    amountCents: 2000,
    effectiveCentsPerAction: 4,
  },
  starter: {
    id: 'starter',
    plan: 'starter',
    actions: 5000,
    amountCents: 8000,
    effectiveCentsPerAction: 1.6,
  },
  growth: {
    id: 'growth',
    plan: 'growth',
    actions: 25000,
    amountCents: 40000,
    effectiveCentsPerAction: 1.6,
  },
  scale: {
    id: 'scale',
    plan: 'scale',
    actions: 100000,
    amountCents: 80000,
    effectiveCentsPerAction: 0.8,
  },
};

/** Credits expire 12 months after purchase. */
export const CREDIT_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

export function priceIdForCreditPack(pack: CreditPackId): string | null {
  switch (pack) {
    case 'builder':
      return process.env.STRIPE_PRICE_CREDITS_BUILDER ?? null;
    case 'starter':
      return process.env.STRIPE_PRICE_CREDITS_STARTER ?? null;
    case 'growth':
      return process.env.STRIPE_PRICE_CREDITS_GROWTH ?? null;
    case 'scale':
      return process.env.STRIPE_PRICE_CREDITS_SCALE ?? null;
  }
}

export interface CreateCreditCheckoutOptions {
  tenantId: string;
  actingUserId: string;
  pack: CreditPackId;
  baseUrl?: string;
}

export interface CreditCheckoutSession {
  url: string;
  sessionId: string;
  expiresAt: Date;
  pack: CreditPackDef;
}

/**
 * Resolve the customer + email for the Checkout session. Reuses the
 * tenant's existing Stripe customer (from the active subscription) so
 * receipts land on the same invoice history; falls back to email
 * collection if the tenant doesn't have a Stripe customer yet.
 */
async function resolveCustomerForCredits(tenantId: string, actingUserId: string): Promise<{
  customerId: string | null;
  email: string | undefined;
}> {
  const [sub] = await db
    .select({ stripe_customer_id: tenant_subscriptions.stripe_customer_id })
    .from(tenant_subscriptions)
    .where(eq(tenant_subscriptions.tenant_id, tenantId))
    .orderBy(desc(tenant_subscriptions.created_at))
    .limit(1);

  if (sub?.stripe_customer_id) {
    return { customerId: sub.stripe_customer_id, email: undefined };
  }

  // Fall back to the tenant-owner email (matches checkout.ts behavior).
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
    if (owner?.email) return { customerId: null, email: owner.email };
  }
  const [caller] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, actingUserId))
    .limit(1);
  return { customerId: null, email: caller?.email ?? undefined };
}

/** Build a mode=payment Stripe Checkout session for a credit pack. */
export async function createCreditCheckoutSession(
  opts: CreateCreditCheckoutOptions,
): Promise<CreditCheckoutSession> {
  const def = PACK_DEFS[opts.pack];
  if (!def) {
    throw new BillingCheckoutFailure(
      'pack_not_configured',
      `unknown credit pack ${opts.pack}`,
    );
  }
  const price = priceIdForCreditPack(opts.pack);
  if (!price) {
    throw new BillingCheckoutFailure(
      'pack_not_configured',
      `credit pack ${opts.pack} is not configured on this Relay instance`,
    );
  }

  const { customerId, email } = await resolveCustomerForCredits(
    opts.tenantId,
    opts.actingUserId,
  );
  const base = opts.baseUrl ?? appBaseUrl();

  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price, quantity: 1 }],
    customer: customerId ?? undefined,
    customer_email: customerId ? undefined : email,
    metadata: {
      tenant_id: opts.tenantId,
      pack: opts.pack,
      kind: 'credit_pack',
    },
    payment_intent_data: {
      metadata: {
        tenant_id: opts.tenantId,
        pack: opts.pack,
        kind: 'credit_pack',
      },
    },
    success_url: `${base}/dev/billing/credits?status=success`,
    cancel_url: `${base}/dev/billing/credits?status=cancel`,
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
    pack: def,
  };
}

/**
 * Process a completed credit-pack Stripe Checkout session. Called from
 * the webhook handler. Idempotent: the action_credits.stripe_payment_intent_id
 * UNIQUE constraint makes a duplicate event a no-op.
 *
 * Returns the inserted credit row id, or `null` if this isn't a credit
 * pack session, isn't paid, or is missing the metadata we need.
 */
export async function applyCreditPurchase(
  session: Stripe.Checkout.Session,
): Promise<{ id: string; pack: CreditPackId; actions: number } | null> {
  if (session.mode !== 'payment') return null;
  if (session.payment_status !== 'paid') return null;
  if (session.metadata?.kind !== 'credit_pack') return null;

  const tenantId = session.metadata?.tenant_id;
  const packId = session.metadata?.pack as CreditPackId | undefined;
  if (!tenantId || !packId) return null;
  const def = PACK_DEFS[packId];
  if (!def) return null;

  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id ?? null;

  const expiresAt = new Date(Date.now() + CREDIT_LIFETIME_MS);

  // ON CONFLICT DO NOTHING on stripe_payment_intent_id makes this safe
  // for duplicate webhook deliveries.
  const inserted = await db
    .insert(action_credits)
    .values({
      tenant_id: tenantId,
      pack_id: packId,
      actions_purchased: def.actions,
      actions_remaining: def.actions,
      amount_cents_paid: def.amountCents,
      stripe_payment_intent_id: paymentIntentId,
      stripe_checkout_session_id: session.id,
      expires_at: expiresAt,
    })
    .onConflictDoNothing({ target: action_credits.stripe_payment_intent_id })
    .returning({ id: action_credits.id });

  if (inserted.length > 0) {
    return { id: inserted[0]!.id, pack: packId, actions: def.actions };
  }

  // Already inserted on a prior delivery; look up the existing row.
  if (paymentIntentId) {
    const [existing] = await db
      .select({ id: action_credits.id })
      .from(action_credits)
      .where(
        and(
          eq(action_credits.tenant_id, tenantId),
          eq(action_credits.stripe_payment_intent_id, paymentIntentId),
        ),
      )
      .limit(1);
    if (existing) return { id: existing.id, pack: packId, actions: def.actions };
  }
  return null;
}

/** Sum of actions_remaining across unexpired credit packs for a tenant. */
export async function totalCreditsRemaining(tenantId: string): Promise<number> {
  const rows = await db
    .select({
      actions_remaining: action_credits.actions_remaining,
      expires_at: action_credits.expires_at,
    })
    .from(action_credits)
    .where(eq(action_credits.tenant_id, tenantId));
  const now = Date.now();
  let total = 0;
  for (const r of rows) {
    if (r.expires_at.getTime() > now) total += r.actions_remaining;
  }
  return total;
}

export interface CreditSummaryItem {
  pack_id: CreditPackId;
  actions_purchased: number;
  actions_remaining: number;
  amount_cents_paid: number;
  expires_at: string;
  created_at: string;
}

export async function listCredits(tenantId: string): Promise<{
  credits: CreditSummaryItem[];
  total_remaining: number;
}> {
  const rows = await db
    .select()
    .from(action_credits)
    .where(eq(action_credits.tenant_id, tenantId))
    .orderBy(action_credits.expires_at);
  const now = Date.now();
  const credits = rows.map((r) => ({
    pack_id: r.pack_id as CreditPackId,
    actions_purchased: r.actions_purchased,
    actions_remaining: r.actions_remaining,
    amount_cents_paid: r.amount_cents_paid,
    expires_at: r.expires_at.toISOString(),
    created_at: r.created_at.toISOString(),
  }));
  const total_remaining = credits
    .filter((c) => new Date(c.expires_at).getTime() > now)
    .reduce((sum, c) => sum + c.actions_remaining, 0);
  return { credits, total_remaining };
}
