/**
 * POST /v1/checkout/founding-partner-sprint — Stripe Checkout Session
 * for the $2,500 prepaid 30-day founding partner sprint.
 *
 * Public route (no bearer/cookie auth) — gated only by the prospect
 * supplying an email + tenant slug. The Stripe webhook path
 * (/v1/webhooks/stripe → checkout.session.completed) flips
 * tenants.partnership_status NULL → 'sprint_paid' on completion.
 *
 * Body shape:
 *   { prospect_email?: string, prospect_name?: string,
 *     tenant_slug?: string, tenant_id?: string }
 *
 * One of prospect_email or tenant_id is required.
 *
 * Returns: `{ url: string }` — the Stripe-hosted checkout URL.
 *
 * Required env: STRIPE_FOUNDING_PARTNER_SPRINT_PRICE (the $2,500 one-time
 * Price created by scripts/setup-founding-partner-stripe.ts).
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import type { AppEnv } from '../auth';
import { stripe } from '../billing/stripe';
import { logger } from '../logger';
import { Sentry } from '../sentry';

const router = new OpenAPIHono<AppEnv>();

const CheckoutBody = z
  .object({
    prospect_email: z.string().email().optional(),
    prospect_name: z.string().max(255).optional(),
    tenant_slug: z.string().max(120).optional(),
    tenant_id: z.string().uuid().optional(),
  })
  .refine((b) => b.prospect_email || b.tenant_id, {
    message: 'prospect_email or tenant_id required',
  });

router.post('/v1/checkout/founding-partner-sprint', async (c) => {
  const priceId = process.env.STRIPE_FOUNDING_PARTNER_SPRINT_PRICE;
  if (!priceId) {
    return c.json({ error: 'stripe_not_configured' }, 503);
  }

  let body: z.infer<typeof CheckoutBody>;
  try {
    body = CheckoutBody.parse(await c.req.json());
  } catch {
    return c.json({ error: 'invalid_body' }, 400);
  }

  try {
    const baseUrl =
      process.env.APP_BASE_URL ??
      (process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.replace(/^https?:\/\//, '')}`
        : 'http://localhost:3000');

    const session = await stripe().checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: body.prospect_email,
      success_url: `${baseUrl}/partner/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?canceled=1`,
      metadata: {
        product: 'founding_partner_sprint',
        tenant_id: body.tenant_id ?? '',
        tenant_slug: body.tenant_slug ?? '',
        prospect_email: body.prospect_email ?? '',
        prospect_name: body.prospect_name ?? '',
      },
    });

    if (!session.url) {
      return c.json({ error: 'stripe_no_url' }, 503);
    }
    return c.json({ url: session.url }, 200);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'founding_partner_checkout_failed',
    );
    Sentry.captureException(err);
    return c.json({ error: 'checkout_create_failed' }, 503);
  }
});

export default router;
