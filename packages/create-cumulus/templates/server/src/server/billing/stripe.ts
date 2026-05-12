/**
 * Memoized Stripe client singleton.
 *
 * Instantiation is deferred until the first call so tests / scripts that never
 * touch Stripe can import from here without crashing when STRIPE_SECRET_KEY is
 * unset. The API version is pinned so the webhook's response shapes stay
 * stable across Stripe's server-side upgrades; bump it deliberately alongside
 * handler changes.
 *
 * Spec: docs/billing-and-bootstrap-plan.md §7.
 */
import Stripe from 'stripe';

let client: Stripe | null = null;

export function stripe(): Stripe {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is not set');
  }
  client = new Stripe(key, {
    // Pinned to the version bundled with the `stripe` package this project
    // installs. Upgrade deliberately — response shapes change between versions.
    apiVersion: '2026-04-22.dahlia',
  });
  return client;
}
