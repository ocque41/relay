#!/usr/bin/env tsx
/**
 * Stripe-provision-prices — one-shot, idempotent script that creates the
 * yearly subscription Prices and credit-pack Prices needed by the new
 * billing surface.
 *
 *   - Reads STRIPE_SECRET_KEY from process.env (must be sk_… or rk_… —
 *     either live or test mode.
 *   - Looks up existing Stripe Products via `metadata.relay_kind` so this
 *     script is safe to re-run.
 *   - Creates one Product per plan (Builder/Starter/Growth/Scale) if it
 *     doesn't exist yet, then attaches:
 *       (a) yearly recurring Price (17% discount on annualised monthly)
 *       (b) one-shot credit-pack Price (mode=payment compatible)
 *   - Prints export statements at the end so the operator can paste them
 *     into .env / `vercel env add`.
 *
 * Idempotent: skips creation when a Price with the matching `lookup_key`
 * already exists. Pricing in PRICING_PLAN below mirrors the catalog
 * baked into src/server/billing/credits.ts.
 *
 * Restricted-key scopes required:
 *   - Products: write
 *   - Prices: write
 *
 * Usage:
 *   STRIPE_SECRET_KEY=rk_test_… npx tsx scripts/stripe-provision-prices.ts
 *
 * The key is never echoed; only its prefix shows up in the redacted
 * header. The actual key value never lands in any file.
 */
import Stripe from 'stripe';

interface YearlyPlan {
  id: 'builder' | 'starter' | 'growth' | 'scale';
  /** Display name for Stripe Product. */
  productName: string;
  /** Monthly price in cents — for documentation only. */
  monthlyCents: number;
  /** Yearly price in cents (17% off the annualised monthly). */
  yearlyCents: number;
  /** Credit-pack: total actions and one-shot price in cents. */
  pack: { actions: number; amountCents: number };
}

// Tiered yearly discounts: the bigger the plan, the more generous the
// annual deal. 17% on Builder, 20% on Starter, 25% on Growth, 31% on
// Scale. Yearly cents = round(monthlyCents * 12 * (1 - discount)) snapped
// to the next $1 down so price tags don't end in noise.
const PLANS: readonly YearlyPlan[] = [
  {
    id: 'builder',
    productName: 'Relay — Builder',
    monthlyCents: 4900,
    yearlyCents: 49000, // $588/yr × 0.83 ≈ $488 → rounded to $490 (17% off)
    pack: { actions: 500, amountCents: 2000 },
  },
  {
    id: 'starter',
    productName: 'Relay — Starter',
    monthlyCents: 19900,
    yearlyCents: 191000, // $2,388/yr × 0.80 ≈ $1,910 → $1,910 (20% off)
    pack: { actions: 5000, amountCents: 8000 },
  },
  {
    id: 'growth',
    productName: 'Relay — Growth',
    monthlyCents: 99900,
    yearlyCents: 899000, // $11,988/yr × 0.75 ≈ $8,991 → $8,990 (25% off)
    pack: { actions: 25000, amountCents: 40000 },
  },
  {
    id: 'scale',
    productName: 'Relay — Scale',
    monthlyCents: 299900,
    yearlyCents: 2482000, // $35,988/yr × 0.69 ≈ $24,832 → $24,820 (31% off)
    pack: { actions: 100000, amountCents: 80000 },
  },
] as const;

const PRODUCT_KIND = 'relay_plan';

function redactKey(key: string): string {
  if (key.length < 10) return '***';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

async function ensureProduct(
  stripe: Stripe,
  plan: YearlyPlan,
): Promise<Stripe.Product> {
  // List products by metadata.relay_kind=relay_plan; filter client-side
  // for plan id (Stripe doesn't expose metadata search on this endpoint).
  const list = await stripe.products.list({ active: true, limit: 100 });
  const existing = list.data.find(
    (p) =>
      p.metadata?.relay_kind === PRODUCT_KIND &&
      p.metadata?.relay_plan === plan.id,
  );
  if (existing) {
    console.error(`  · product reused — ${plan.id} → ${existing.id}`);
    return existing;
  }
  const created = await stripe.products.create({
    name: plan.productName,
    metadata: {
      relay_kind: PRODUCT_KIND,
      relay_plan: plan.id,
    },
  });
  console.error(`  · product created — ${plan.id} → ${created.id}`);
  return created;
}

async function ensurePrice(
  stripe: Stripe,
  product: Stripe.Product,
  lookupKey: string,
  spec:
    | { kind: 'monthly_subscription'; amountCents: number }
    | { kind: 'yearly_subscription'; amountCents: number }
    | { kind: 'credit_pack_oneshot'; amountCents: number; actions: number },
): Promise<Stripe.Price> {
  // lookup_key is unique per Stripe account; use it to make this idempotent.
  const found = await stripe.prices.list({
    lookup_keys: [lookupKey],
    active: true,
    limit: 1,
  });
  if (found.data[0]) {
    console.error(`  · price reused — ${lookupKey} → ${found.data[0].id}`);
    return found.data[0];
  }

  let params: Stripe.PriceCreateParams;
  if (spec.kind === 'monthly_subscription') {
    params = {
      product: product.id,
      currency: 'usd',
      unit_amount: spec.amountCents,
      recurring: { interval: 'month' },
      lookup_key: lookupKey,
      metadata: { relay_kind: 'subscription', relay_interval: 'monthly' },
    };
  } else if (spec.kind === 'yearly_subscription') {
    params = {
      product: product.id,
      currency: 'usd',
      unit_amount: spec.amountCents,
      recurring: { interval: 'year' },
      lookup_key: lookupKey,
      metadata: { relay_kind: 'subscription', relay_interval: 'yearly' },
    };
  } else {
    // credit_pack_oneshot
    params = {
      product: product.id,
      currency: 'usd',
      unit_amount: spec.amountCents,
      lookup_key: lookupKey,
      metadata: {
        relay_kind: 'credit_pack',
        relay_pack_actions: String(spec.actions),
      },
    };
  }
  const created = await stripe.prices.create(params);
  console.error(`  · price created — ${lookupKey} → ${created.id}`);
  return created;
}

async function main(): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error('error: STRIPE_SECRET_KEY is not set');
    process.exit(2);
  }
  const mode = key.includes('_test_') ? 'test' : key.includes('_live_') ? 'live' : 'unknown';
  console.error(`Stripe key: ${redactKey(key)} (${mode} mode)`);
  if (mode === 'unknown') {
    console.error(
      'warning: key prefix does not contain _test_ or _live_; proceeding anyway',
    );
  }

  const stripe = new Stripe(key, { apiVersion: '2026-04-22.dahlia' });

  const exports: string[] = [];

  for (const plan of PLANS) {
    console.error(`\n[${plan.id}]`);
    const product = await ensureProduct(stripe, plan);

    // Yearly subscription Price. Lookup key is versioned so we can roll
    // out new yearly amounts (e.g. tiered-discount rev) without touching
    // existing Stripe Prices, which are immutable on `unit_amount`.
    const yearly = await ensurePrice(
      stripe,
      product,
      `relay_${plan.id}_yearly_v2`,
      { kind: 'yearly_subscription', amountCents: plan.yearlyCents },
    );
    exports.push(
      `STRIPE_PRICE_${plan.id.toUpperCase()}_YEARLY=${yearly.id}`,
    );

    // Credit-pack one-shot Price. Same versioning convention.
    const pack = await ensurePrice(
      stripe,
      product,
      `relay_${plan.id}_creditpack_v1`,
      {
        kind: 'credit_pack_oneshot',
        amountCents: plan.pack.amountCents,
        actions: plan.pack.actions,
      },
    );
    exports.push(
      `STRIPE_PRICE_CREDITS_${plan.id.toUpperCase()}=${pack.id}`,
    );
  }

  console.error('\nDone. Add these to your .env / Vercel env:');
  console.error('---');
  // stdout is shell-paste-friendly; stderr is the human chatter above.
  for (const line of exports) console.log(line);
}

main().catch((err) => {
  console.error('stripe-provision-prices failed:', err);
  process.exit(1);
});
