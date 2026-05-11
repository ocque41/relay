import { describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { resolveBillingInterval } from './billing';

// Helper — build a minimal Stripe.Subscription shape that exercises the
// recurring.interval lookup without hitting the rest of the SDK type.
function buildSub(interval: string | null | undefined): Stripe.Subscription {
  return {
    items: {
      data: [
        {
          price:
            interval === undefined
              ? {}
              : { recurring: interval === null ? null : { interval } },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

describe('resolveBillingInterval', () => {
  it('maps Stripe "year" → "yearly"', () => {
    expect(resolveBillingInterval(buildSub('year'))).toBe('yearly');
  });

  it('maps Stripe "month" → "monthly"', () => {
    expect(resolveBillingInterval(buildSub('month'))).toBe('monthly');
  });

  it('defaults to "monthly" on an unknown interval (e.g. "week")', () => {
    expect(resolveBillingInterval(buildSub('week'))).toBe('monthly');
  });

  it('defaults to "monthly" when recurring is missing', () => {
    expect(resolveBillingInterval(buildSub(undefined))).toBe('monthly');
  });

  it('defaults to "monthly" when recurring is null', () => {
    expect(resolveBillingInterval(buildSub(null))).toBe('monthly');
  });

  it('defaults to "monthly" when items.data is empty', () => {
    const sub = { items: { data: [] } } as unknown as Stripe.Subscription;
    expect(resolveBillingInterval(sub)).toBe('monthly');
  });
});
