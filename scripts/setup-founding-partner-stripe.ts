/**
 * scripts/setup-founding-partner-stripe.ts
 *
 * Provisions the Stripe Product + 2 Prices used for the founding-partner
 * sprint. Idempotent: it searches for an existing Product by `lookup_key`
 * (or its name) before creating, and likewise for Prices.
 *
 * Reads STRIPE_OPERATOR_KEY (or STRIPE_SECRET_KEY) from the environment.
 * The key is operator-only — never written into source.
 *
 * Output:
 *   STRIPE_FOUNDING_PARTNER_PRODUCT_ID=prod_…
 *   STRIPE_FOUNDING_PARTNER_SPRINT_PRICE=price_… (one-time, $2,500)
 *   STRIPE_FOUNDING_PARTNER_RENEWAL_PRICE=price_… (recurring, $2,500/month)
 *
 * Add these to your Vercel project as env vars (the API routes at
 * src/server/routes/checkout.ts read STRIPE_FOUNDING_PARTNER_SPRINT_PRICE).
 */
import Stripe from 'stripe';

const SPRINT_LOOKUP = 'founding_partner_sprint_one_time_2500';
const RENEWAL_LOOKUP = 'founding_partner_sprint_renewal_monthly_2500';
const PRODUCT_NAME = 'Relay Founding Partner Sprint';

async function main(): Promise<void> {
  const key = process.env.STRIPE_OPERATOR_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error('STRIPE_OPERATOR_KEY (or STRIPE_SECRET_KEY) is required');
    process.exit(2);
  }
  const stripe = new Stripe(key, { apiVersion: '2026-04-22.dahlia' });

  // --- Product ---
  let product: Stripe.Product | null = null;
  const products = await stripe.products.search({
    query: `name:'${PRODUCT_NAME}' AND active:'true'`,
  });
  if (products.data.length > 0) {
    product = products.data[0];
    console.error(`reusing product ${product.id}`);
  } else {
    product = await stripe.products.create({
      name: PRODUCT_NAME,
      description:
        'Concierge integration of Relay into your signup/API-key flow plus monthly activation cohort report.',
    });
    console.error(`created product ${product.id}`);
  }

  // --- Sprint price (one-time $2,500) ---
  let sprintPrice: Stripe.Price | null = null;
  const sprintHits = await stripe.prices.list({
    lookup_keys: [SPRINT_LOOKUP],
    active: true,
    limit: 1,
  });
  if (sprintHits.data.length > 0) {
    sprintPrice = sprintHits.data[0];
    console.error(`reusing sprint price ${sprintPrice.id}`);
  } else {
    sprintPrice = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: 2_500_00,
      lookup_key: SPRINT_LOOKUP,
      nickname: 'Founding Partner Sprint (30-day prepaid, one-time)',
    });
    console.error(`created sprint price ${sprintPrice.id}`);
  }

  // --- Renewal price (recurring $2,500/month) ---
  let renewalPrice: Stripe.Price | null = null;
  const renewalHits = await stripe.prices.list({
    lookup_keys: [RENEWAL_LOOKUP],
    active: true,
    limit: 1,
  });
  if (renewalHits.data.length > 0) {
    renewalPrice = renewalHits.data[0];
    console.error(`reusing renewal price ${renewalPrice.id}`);
  } else {
    renewalPrice = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: 2_500_00,
      recurring: { interval: 'month' },
      lookup_key: RENEWAL_LOOKUP,
      nickname: 'Founding Partner Sprint Renewal ($2,500/month)',
    });
    console.error(`created renewal price ${renewalPrice.id}`);
  }

  console.log(`STRIPE_FOUNDING_PARTNER_PRODUCT_ID=${product.id}`);
  console.log(`STRIPE_FOUNDING_PARTNER_SPRINT_PRICE=${sprintPrice.id}`);
  console.log(`STRIPE_FOUNDING_PARTNER_RENEWAL_PRICE=${renewalPrice.id}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('setup-founding-partner-stripe failed:', err);
    process.exit(1);
  });
