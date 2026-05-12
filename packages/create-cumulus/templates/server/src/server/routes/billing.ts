/**
 * /v1/dev/billing/* + POST /v1/webhooks/stripe.
 *
 * Integrator-only revenue model: end-users are free, integrators pay a
 * subscription with included action quota and overage.
 *
 * Idempotency:
 *   - subscription_events.stripe_event_id UNIQUE — catch the PK violation
 *     and return 200 on duplicate deliveries.
 *
 * The webhook reads the raw request body (no prior JSON parse) so Stripe's
 * HMAC check sees the exact bytes it signed. Unknown event types return 200
 * so Stripe's retry machinery never fires for shapes we don't yet handle.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { desc, eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { db } from '../db/index';
import {
  plan_catalog,
  stripe_pending_invoice_items,
  subscription_events,
  tenant_plan_features,
  tenant_quota_state,
  tenant_subscriptions,
  tenants,
} from '../db/schema';
import {
  requireTenantWorkspaceFromBearerOrSession,
  type WorkspaceEnv,
} from '../auth/workspace';
import { type AppEnv } from '../auth';
import { invalidateTenantCache } from '../billing/charge';
import { resetQuotaForPeriod } from '../billing/quota';
import { stripe } from '../billing/stripe';
import {
  BillingCheckoutFailure,
  createBillingPortalSession,
  createCheckoutSession,
  type BillingInterval,
  type PlanId,
} from '../billing/checkout';
import {
  CREDIT_PACK_IDS,
  PACK_DEFS,
  applyCreditPurchase,
  createCreditCheckoutSession,
  listCredits,
  totalCreditsRemaining,
  type CreditPackId,
} from '../billing/credits';

// ---------------------------------------------------------------------------
// Types and shared helpers
// ---------------------------------------------------------------------------

type BillingEnv = WorkspaceEnv & AppEnv;

const app = new OpenAPIHono<BillingEnv>();

const ErrorResponse = z.object({ error: z.string() });

const securityCookieOrBearer: Array<Record<string, string[]>> = [
  { cookieAuth: [] },
  { bearerAuth: [] },
];

// ---------------------------------------------------------------------------
// POST /v1/dev/billing/subscribe — tenant subscription Checkout session
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/dev/billing/subscribe',
    tags: ['billing'],
    summary: 'Create a Stripe subscription Checkout session for the active tenant',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              plan: z.enum(['founders', 'builder', 'starter', 'growth', 'scale']),
              interval: z
                .enum(['monthly', 'yearly'])
                .optional()
                .default('monthly')
                .describe(
                  'Billing cadence. Yearly tiers ship at a 17% discount (≈ 2 months free). Founders is monthly-only.',
                ),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Redirect URL to the Stripe-hosted Checkout page.',
        content: {
          'application/json': { schema: z.object({ url: z.string().url() }) },
        },
      },
      400: {
        description: 'Plan is not configured in env.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const tenantId = c.get('activeTenantId')!;
    const userId = c.get('activeUserId')!;
    const { plan, interval } = c.req.valid('json');

    try {
      const checkout = await createCheckoutSession({
        tenantId,
        actingUserId: userId,
        plan: plan as PlanId,
        interval: interval as BillingInterval,
      });
      return c.json({ url: checkout.url }, 200);
    } catch (err) {
      if (err instanceof BillingCheckoutFailure) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
  },
);

// ---------------------------------------------------------------------------
// POST /v1/dev/billing/credits/checkout — credit-pack one-shot purchase
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/dev/billing/credits/checkout',
    tags: ['billing'],
    summary: 'Buy a one-shot credit pack (extra actions for the current period)',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              pack: z.enum(['builder', 'starter', 'growth', 'scale']),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Stripe Checkout URL. Mode=payment.',
        content: {
          'application/json': {
            schema: z.object({
              url: z.string().url(),
              pack: z.object({
                id: z.string(),
                actions: z.number(),
                amount_cents: z.number(),
              }),
            }),
          },
        },
      },
      400: {
        description: 'Pack is not configured in env.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const tenantId = c.get('activeTenantId')!;
    const userId = c.get('activeUserId')!;
    const { pack } = c.req.valid('json');

    try {
      const session = await createCreditCheckoutSession({
        tenantId,
        actingUserId: userId,
        pack: pack as CreditPackId,
      });
      return c.json(
        {
          url: session.url,
          pack: {
            id: session.pack.id,
            actions: session.pack.actions,
            amount_cents: session.pack.amountCents,
          },
        },
        200,
      );
    } catch (err) {
      if (err instanceof BillingCheckoutFailure) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
  },
);

// ---------------------------------------------------------------------------
// GET /v1/dev/billing/credits — list of unspent credit packs for this tenant
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/dev/billing/credits',
    tags: ['billing'],
    summary: 'List the tenant’s credit-pack purchases (unspent + spent)',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    responses: {
      200: {
        description: 'Credit packs with remaining balance + the SKU catalog.',
        content: {
          'application/json': {
            schema: z.object({
              total_remaining: z.number(),
              credits: z.array(
                z.object({
                  pack_id: z.string(),
                  actions_purchased: z.number(),
                  actions_remaining: z.number(),
                  amount_cents_paid: z.number(),
                  expires_at: z.string(),
                  created_at: z.string(),
                }),
              ),
              packs: z.array(
                z.object({
                  id: z.string(),
                  plan: z.string(),
                  actions: z.number(),
                  amount_cents: z.number(),
                  effective_cents_per_action: z.number(),
                }),
              ),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const tenantId = c.get('activeTenantId')!;
    const out = await listCredits(tenantId);
    return c.json(
      {
        total_remaining: out.total_remaining,
        credits: out.credits,
        packs: CREDIT_PACK_IDS.map((id) => {
          const def = PACK_DEFS[id];
          return {
            id: def.id,
            plan: def.plan,
            actions: def.actions,
            amount_cents: def.amountCents,
            effective_cents_per_action: def.effectiveCentsPerAction,
          };
        }),
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// POST /v1/dev/billing/portal — Stripe Customer Portal session
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/dev/billing/portal',
    tags: ['billing'],
    summary: 'Open the Stripe Customer Portal for this tenant',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    responses: {
      200: {
        description: 'Redirect URL.',
        content: {
          'application/json': { schema: z.object({ url: z.string().url() }) },
        },
      },
      400: {
        description: 'No active subscription / no customer on file.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const tenantId = c.get('activeTenantId')!;
    try {
      const portal = await createBillingPortalSession({ tenantId });
      return c.json({ url: portal.url }, 200);
    } catch (err) {
      if (err instanceof BillingCheckoutFailure) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
  },
);

// ---------------------------------------------------------------------------
// GET /v1/dev/billing/summary — tenant subscription + quota snapshot
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/dev/billing/summary',
    tags: ['billing'],
    summary: 'Active subscription + quota state for the current tenant',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    responses: {
      200: {
        description: 'Subscription snapshot, quota state, credit packs, and plan catalog.',
        content: {
          'application/json': {
            schema: z.object({
              status: z.string().nullable(),
              plan: z.string().nullable(),
              billing_interval: z.string().nullable(),
              current_period_end: z.string().nullable(),
              trial_ends_at: z.string().nullable(),
              canceled_at: z.string().nullable(),
              stripe_customer_id: z.string().nullable(),
              quota: z
                .object({
                  included_total: z.number(),
                  included_remaining: z.number(),
                  overage_count: z.number(),
                  overage_price_cents: z.number(),
                  overage_spend_cents: z.number(),
                  period_start: z.string().nullable(),
                  period_end: z.string().nullable(),
                })
                .nullable(),
              credits: z.object({
                total_remaining: z.number(),
              }),
              plans: z.array(
                z.object({
                  id: z.string(),
                  display_name: z.string(),
                  price_cents: z.number(),
                  included_actions: z.number(),
                  overage_price_cents: z.number(),
                  trial_actions: z.number().nullable(),
                  trial_days: z.number().nullable(),
                  sla_target: z.string().nullable(),
                }),
              ),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const tenantId = c.get('activeTenantId')!;

    const [subRow] = await db
      .select()
      .from(tenant_subscriptions)
      .where(eq(tenant_subscriptions.tenant_id, tenantId))
      .orderBy(desc(tenant_subscriptions.created_at))
      .limit(1);

    const [quotaRow] = await db
      .select()
      .from(tenant_quota_state)
      .where(eq(tenant_quota_state.tenant_id, tenantId))
      .limit(1);

    const plans = await db.select().from(plan_catalog);
    const creditsTotal = await totalCreditsRemaining(tenantId);

    let quota: {
      included_total: number;
      included_remaining: number;
      overage_count: number;
      overage_price_cents: number;
      overage_spend_cents: number;
      period_start: string | null;
      period_end: string | null;
    } | null = null;

    if (quotaRow) {
      const plan = plans.find((p) => p.id === (subRow?.plan ?? 'founders'));
      const includedTotal = plan?.included_actions ?? 0;
      const overagePriceCents = plan?.overage_price_cents ?? 0;
      quota = {
        included_total: includedTotal,
        included_remaining: quotaRow.included_remaining,
        overage_count: quotaRow.overage_count,
        overage_price_cents: overagePriceCents,
        overage_spend_cents: quotaRow.overage_count * overagePriceCents,
        period_start: quotaRow.period_start
          ? new Date(quotaRow.period_start).toISOString()
          : null,
        period_end: quotaRow.period_end
          ? new Date(quotaRow.period_end).toISOString()
          : null,
      };
    }

    return c.json(
      {
        status: subRow?.status ?? null,
        plan: subRow?.plan ?? null,
        billing_interval: subRow?.billing_interval ?? null,
        current_period_end: subRow?.current_period_end
          ? new Date(subRow.current_period_end).toISOString()
          : null,
        trial_ends_at: subRow?.trial_ends_at
          ? new Date(subRow.trial_ends_at).toISOString()
          : null,
        canceled_at: subRow?.canceled_at
          ? new Date(subRow.canceled_at).toISOString()
          : null,
        stripe_customer_id: subRow?.stripe_customer_id ?? null,
        quota,
        credits: { total_remaining: creditsTotal },
        plans: plans.map((p) => ({
          id: p.id,
          display_name: p.display_name,
          price_cents: p.price_cents,
          included_actions: p.included_actions,
          overage_price_cents: p.overage_price_cents,
          trial_actions: p.trial_actions,
          trial_days: p.trial_days,
          sla_target: p.sla_target,
        })),
      },
      200,
    );
  },
);

// Reference imports kept so the lint doesn't complain when they're only used
// by the Stripe webhook lookups later in the file. The types are reused from
// /v1/dev/billing/summary's response schema.
void stripe_pending_invoice_items;

// ---------------------------------------------------------------------------
// POST /v1/webhooks/stripe — HMAC-verified by Stripe's SDK; no bearer auth.
// ---------------------------------------------------------------------------
const webhookApp = new OpenAPIHono();

/** Narrow to the unique error constraint set by PostgreSQL for `stripe_event_id`. */
function isDuplicateEventError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /duplicate key value/i.test(message) &&
    /subscription_events/i.test(message) &&
    /stripe_event_id/i.test(message)
  );
}

async function recordSubscriptionEvent(
  subscriptionRowId: string,
  eventType: string,
  stripeEventId: string,
  metadata: Record<string, unknown> | null,
): Promise<'recorded' | 'duplicate'> {
  try {
    await db.insert(subscription_events).values({
      subscription_id: subscriptionRowId,
      event_type: eventType,
      stripe_event_id: stripeEventId,
      metadata: metadata ?? null,
    });
    return 'recorded';
  } catch (err) {
    if (isDuplicateEventError(err)) return 'duplicate';
    throw err;
  }
}

/**
 * Look up this tenant plan's monthly Actions-API quota. Falls back to
 * `subscription.metadata.actions_per_month` then to 0.
 */
function resolveActionsIncluded(subscription: Stripe.Subscription): number {
  const fromMetadata = Number.parseInt(
    subscription.metadata?.actions_per_month ?? '',
    10,
  );
  return Number.isFinite(fromMetadata) ? fromMetadata : 0;
}

function resolveUsersLimit(subscription: Stripe.Subscription): number {
  const fromMetadata = Number.parseInt(
    subscription.metadata?.users_limit ?? '',
    10,
  );
  return Number.isFinite(fromMetadata) ? fromMetadata : 0;
}

/**
 * Map Stripe's recurring.interval to our billing_interval enum. Defensive
 * — older Stripe SDK type drift can put recurring under the price object
 * directly or skip it entirely. Defaults to 'monthly' to avoid writing
 * NULL into a NOT NULL column when Stripe sends a malformed payload.
 *
 * Exported for testability — the rest of upsertSubscriptionFromStripe
 * is too DB-heavy to unit-test cleanly, but this helper is pure.
 */
export function resolveBillingInterval(
  subscription: Stripe.Subscription,
): 'monthly' | 'yearly' {
  const item = subscription.items?.data?.[0] as
    | { price?: { recurring?: { interval?: string | null } | null } }
    | undefined;
  const interval = item?.price?.recurring?.interval ?? 'month';
  return interval === 'year' ? 'yearly' : 'monthly';
}

async function upsertSubscriptionFromStripe(
  subscription: Stripe.Subscription,
  override?: { status?: string; canceledAt?: Date | null },
): Promise<{ id: string; tenantId: string } | null> {
  const tenantId = subscription.metadata?.tenant_id;
  if (!tenantId) return null;

  const plan =
    subscription.metadata?.plan ??
    (subscription.items.data[0]?.price?.lookup_key ?? 'unknown');

  const billingInterval = resolveBillingInterval(subscription);

  const status = override?.status ?? subscription.status;
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id ?? null;

  const sub = subscription as unknown as {
    current_period_end?: number | null;
    trial_end?: number | null;
    canceled_at?: number | null;
    items?: { data?: Array<{ current_period_end?: number | null }> };
  };
  const periodEndUnix = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
  const currentPeriodEnd = periodEndUnix ? new Date(periodEndUnix * 1000) : null;
  const trialEndsAt = sub.trial_end ? new Date(sub.trial_end * 1000) : null;
  const canceledAt =
    override?.canceledAt === undefined
      ? sub.canceled_at
        ? new Date(sub.canceled_at * 1000)
        : null
      : override.canceledAt;

  const now = new Date();
  const actionsIncluded = resolveActionsIncluded(subscription);
  const usersLimit = resolveUsersLimit(subscription);
  // Yearly subs get the same period_resets_at semantics — Stripe sends
  // the next-period anchor, the cron uses it as-is.
  const fallbackResetMs = billingInterval === 'yearly'
    ? 365 * 24 * 60 * 60 * 1000
    : 30 * 24 * 60 * 60 * 1000;
  const periodResetsAt =
    currentPeriodEnd ?? new Date(now.getTime() + fallbackResetMs);

  const [existing] = await db
    .select({
      id: tenant_subscriptions.id,
      plan: tenant_subscriptions.plan,
    })
    .from(tenant_subscriptions)
    .where(eq(tenant_subscriptions.stripe_subscription_id, subscription.id))
    .limit(1);

  if (existing) {
    const planChanged = existing.plan !== plan;
    await db
      .update(tenant_subscriptions)
      .set({
        status,
        plan,
        billing_interval: billingInterval,
        stripe_customer_id: customerId ?? undefined,
        current_period_end: currentPeriodEnd ?? undefined,
        trial_ends_at: trialEndsAt ?? undefined,
        canceled_at: canceledAt ?? undefined,
        actions_included: actionsIncluded,
        users_limit: usersLimit,
        ...(planChanged
          ? { actions_used_period: 0, period_resets_at: periodResetsAt }
          : { period_resets_at: periodResetsAt }),
        updated_at: now,
      })
      .where(eq(tenant_subscriptions.id, existing.id));
    await upsertPlanFeatures(tenantId, plan);
    return { id: existing.id, tenantId };
  }

  const [inserted] = await db
    .insert(tenant_subscriptions)
    .values({
      tenant_id: tenantId,
      status,
      plan,
      billing_interval: billingInterval,
      stripe_subscription_id: subscription.id,
      stripe_customer_id: customerId,
      current_period_end: currentPeriodEnd,
      trial_ends_at: trialEndsAt,
      canceled_at: canceledAt,
      actions_included: actionsIncluded,
      actions_used_period: 0,
      period_resets_at: periodResetsAt,
      users_limit: usersLimit,
      updated_at: now,
    })
    .returning({ id: tenant_subscriptions.id });
  await upsertPlanFeatures(tenantId, plan);
  return { id: inserted.id, tenantId };
}

/**
 * Sync tenant_quota_state with the fresh Stripe subscription. Runs on every
 * customer.subscription.created/updated event. Reads included_actions from
 * plan_catalog keyed by the plan id.
 */
async function resetQuotaFromSubscription(
  subscription: Stripe.Subscription,
  tenantId: string,
  planId: string,
): Promise<void> {
  const sub = subscription as unknown as {
    current_period_start?: number | null;
    current_period_end?: number | null;
    trial_end?: number | null;
    trial_start?: number | null;
    items?: {
      data?: Array<{
        current_period_start?: number | null;
        current_period_end?: number | null;
      }>;
    };
  };
  const item = sub.items?.data?.[0] ?? {};
  const startUnix = sub.current_period_start ?? item.current_period_start ?? sub.trial_start ?? null;
  const endUnix =
    sub.current_period_end ?? item.current_period_end ?? sub.trial_end ?? null;
  const now = new Date();
  const periodStart = startUnix ? new Date(startUnix * 1000) : now;
  const periodEnd = endUnix
    ? new Date(endUnix * 1000)
    : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  await resetQuotaForPeriod({ tenantId, planId, periodStart, periodEnd });
}

async function upsertPlanFeatures(tenantId: string, plan: string): Promise<void> {
  const features: Record<string, unknown> = plan === 'scale' ? { scale_e2e_benchmark: true } : {};
  await db
    .insert(tenant_plan_features)
    .values({ tenant_id: tenantId, features })
    .onConflictDoUpdate({
      target: tenant_plan_features.tenant_id,
      set: { features, updated_at: new Date() },
    });
}

async function applyInvoiceStatus(
  invoice: Stripe.Invoice,
  newStatus: 'past_due' | 'active',
): Promise<{ id: string; tenantId: string } | null> {
  const subRef = (invoice as unknown as { subscription?: string | { id: string } | null })
    .subscription;
  const subscriptionId =
    typeof subRef === 'string' ? subRef : subRef?.id ?? null;
  if (!subscriptionId) return null;

  const [existing] = await db
    .select({ id: tenant_subscriptions.id, tenant_id: tenant_subscriptions.tenant_id })
    .from(tenant_subscriptions)
    .where(eq(tenant_subscriptions.stripe_subscription_id, subscriptionId))
    .limit(1);
  if (!existing) return null;

  await db
    .update(tenant_subscriptions)
    .set({ status: newStatus, updated_at: new Date() })
    .where(eq(tenant_subscriptions.id, existing.id));
  return { id: existing.id, tenantId: existing.tenant_id };
}

async function handleSubscriptionCheckoutSession(
  session: Stripe.Checkout.Session,
): Promise<void> {
  if (session.mode !== 'subscription') return;
  const subscriptionRef = session.subscription;
  const subscriptionId =
    typeof subscriptionRef === 'string'
      ? subscriptionRef
      : subscriptionRef?.id ?? null;
  if (!subscriptionId) return;

  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe().subscriptions.retrieve(subscriptionId);
  } catch {
    // Transient — the scheduled customer.subscription.created event will still arrive.
    return;
  }

  const upserted = await upsertSubscriptionFromStripe(subscription);
  if (upserted) invalidateTenantCache(upserted.tenantId);
}

// Migration 0027: founding-partner sprint checkout completion.
// Identified by session.metadata.product === 'founding_partner_sprint'.
// Looks up the tenant by metadata.tenant_id (preferred) or .tenant_slug
// and flips partnership_status to 'sprint_paid'. If neither resolves,
// the event is logged and ignored — ops can manually attribute the
// payment from the Stripe dashboard.
async function handleFoundingPartnerSprintCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const tenantId = session.metadata?.tenant_id;
  const tenantSlug = session.metadata?.tenant_slug;

  let tenant: { id: string } | undefined;
  if (tenantId) {
    [tenant] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
  }
  if (!tenant && tenantSlug) {
    [tenant] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, tenantSlug))
      .limit(1);
  }

  if (!tenant) {
    // No matching tenant — the prospect probably hadn't created a tenant
    // yet at checkout time. Operator follows up manually.
    console.warn(
      '[founding_partner_sprint] checkout completed without tenant match',
      { sessionId: session.id, tenantId, tenantSlug },
    );
    return;
  }

  await db
    .update(tenants)
    .set({ partnership_status: 'sprint_paid' })
    .where(eq(tenants.id, tenant.id));

  invalidateTenantCache(tenant.id);
}

webhookApp.post('/v1/webhooks/stripe', async (c) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return c.json({ error: 'server_misconfigured' }, 500);
  }
  const signature = c.req.header('stripe-signature');
  if (!signature) {
    return c.json({ error: 'missing_signature' }, 400);
  }

  const raw = await c.req.raw.clone().text();

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(raw, signature, secret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `signature_verification_failed: ${msg}` }, 400);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        // Migration 0027: founding-partner sprint takes precedence over the
        // legacy credit-pack path. Identified by metadata.product set in
        // POST /v1/checkout/founding-partner-sprint.
        if (session.metadata?.product === 'founding_partner_sprint') {
          await handleFoundingPartnerSprintCompleted(session);
        } else if (session.mode === 'subscription') {
          await handleSubscriptionCheckoutSession(session);
        } else if (session.mode === 'payment') {
          // Credit-pack one-shot purchase. applyCreditPurchase is
          // idempotent on stripe_payment_intent_id — duplicate webhook
          // deliveries are no-ops.
          const result = await applyCreditPurchase(session);
          if (result) {
            const tenantId = session.metadata?.tenant_id;
            if (tenantId) invalidateTenantCache(tenantId);
          }
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const upserted = await upsertSubscriptionFromStripe(subscription);
        if (upserted) {
          const planId =
            subscription.metadata?.plan ??
            subscription.items.data[0]?.price?.lookup_key ??
            'unknown';
          await resetQuotaFromSubscription(subscription, upserted.tenantId, planId);
          const written = await recordSubscriptionEvent(
            upserted.id,
            event.type === 'customer.subscription.created' ? 'created' : 'updated',
            event.id,
            { stripe_subscription_id: subscription.id },
          );
          if (written === 'duplicate') {
            return c.json({ received: true, duplicate: true }, 200);
          }
          invalidateTenantCache(upserted.tenantId);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const upserted = await upsertSubscriptionFromStripe(subscription, {
          status: 'canceled',
          canceledAt: new Date(),
        });
        if (upserted) {
          const written = await recordSubscriptionEvent(
            upserted.id,
            'canceled',
            event.id,
            { stripe_subscription_id: subscription.id },
          );
          if (written === 'duplicate') {
            return c.json({ received: true, duplicate: true }, 200);
          }
          invalidateTenantCache(upserted.tenantId);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const applied = await applyInvoiceStatus(invoice, 'past_due');
        if (applied) {
          const written = await recordSubscriptionEvent(
            applied.id,
            'past_due',
            event.id,
            { stripe_invoice_id: invoice.id },
          );
          if (written === 'duplicate') {
            return c.json({ received: true, duplicate: true }, 200);
          }
          invalidateTenantCache(applied.tenantId);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        const applied = await applyInvoiceStatus(invoice, 'active');
        if (applied) {
          // New billing period — pull the subscription so we can reset
          // tenant_quota_state from the current plan_catalog row.
          const subRef = (invoice as unknown as { subscription?: string | { id: string } | null }).subscription;
          const subscriptionId = typeof subRef === 'string' ? subRef : subRef?.id ?? null;
          if (subscriptionId) {
            try {
              const subscription = await stripe().subscriptions.retrieve(subscriptionId);
              const planId =
                subscription.metadata?.plan ??
                subscription.items.data[0]?.price?.lookup_key ??
                'unknown';
              await resetQuotaFromSubscription(subscription, applied.tenantId, planId);
            } catch (err) {
              console.error('[stripe.invoice.payment_succeeded] quota reset failed:', err);
            }
          }
          const written = await recordSubscriptionEvent(
            applied.id,
            'active',
            event.id,
            { stripe_invoice_id: invoice.id },
          );
          if (written === 'duplicate') {
            return c.json({ received: true, duplicate: true }, 200);
          }
          invalidateTenantCache(applied.tenantId);
        }
        break;
      }

      default:
        // Unknown event type — acknowledge so Stripe stops retrying.
        return c.json({ received: true, ignored: event.type }, 200);
    }
  } catch (err) {
    if (isDuplicateEventError(err)) {
      return c.json({ received: true, duplicate: true }, 200);
    }
    throw err;
  }

  return c.json({ received: true }, 200);
});

// Mount both the OpenAPI-documented API routes and the raw webhook endpoint.
app.route('/', webhookApp);

export default app;
