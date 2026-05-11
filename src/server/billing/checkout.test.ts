import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BillingCheckoutFailure,
  CHECKOUT_PLANS,
  YEARLY_PLANS,
  isSubscriptionActive,
  priceIdForPlan,
} from './checkout';

describe('CHECKOUT_PLANS', () => {
  it('contains exactly the four billable tiers (no founders trial, no enterprise)', () => {
    expect([...CHECKOUT_PLANS]).toEqual(['builder', 'starter', 'growth', 'scale']);
  });
});

describe('YEARLY_PLANS', () => {
  it('matches CHECKOUT_PLANS — every paid plan offers yearly', () => {
    expect([...YEARLY_PLANS]).toEqual([...CHECKOUT_PLANS]);
  });
});

describe('priceIdForPlan', () => {
  const snapshot: Record<string, string | undefined> = {};
  const envKeys = [
    'STRIPE_PRICE_FOUNDERS',
    'STRIPE_PRICE_BUILDER',
    'STRIPE_PRICE_STARTER',
    'STRIPE_PRICE_GROWTH',
    'STRIPE_PRICE_SCALE',
    'STRIPE_PRICE_BUILDER_YEARLY',
    'STRIPE_PRICE_STARTER_YEARLY',
    'STRIPE_PRICE_GROWTH_YEARLY',
    'STRIPE_PRICE_SCALE_YEARLY',
  ];

  beforeEach(() => {
    for (const k of envKeys) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k]!;
    }
  });

  it('returns null when the env var is missing', () => {
    expect(priceIdForPlan('builder')).toBeNull();
  });

  it('returns the configured price id when set', () => {
    process.env.STRIPE_PRICE_BUILDER = 'price_test_builder_123';
    expect(priceIdForPlan('builder')).toBe('price_test_builder_123');
  });

  it('maps each plan to its own env var', () => {
    process.env.STRIPE_PRICE_STARTER = 'price_starter';
    process.env.STRIPE_PRICE_GROWTH = 'price_growth';
    process.env.STRIPE_PRICE_SCALE = 'price_scale';
    expect(priceIdForPlan('starter')).toBe('price_starter');
    expect(priceIdForPlan('growth')).toBe('price_growth');
    expect(priceIdForPlan('scale')).toBe('price_scale');
    expect(priceIdForPlan('builder')).toBeNull();
  });

  it('defaults to monthly when interval is omitted', () => {
    process.env.STRIPE_PRICE_BUILDER = 'price_builder_monthly';
    process.env.STRIPE_PRICE_BUILDER_YEARLY = 'price_builder_yearly';
    expect(priceIdForPlan('builder')).toBe('price_builder_monthly');
  });

  it('resolves yearly env vars when interval=yearly', () => {
    process.env.STRIPE_PRICE_BUILDER_YEARLY = 'price_builder_yearly_490';
    process.env.STRIPE_PRICE_STARTER_YEARLY = 'price_starter_yearly_1990';
    process.env.STRIPE_PRICE_GROWTH_YEARLY = 'price_growth_yearly_9990';
    process.env.STRIPE_PRICE_SCALE_YEARLY = 'price_scale_yearly_29990';
    expect(priceIdForPlan('builder', 'yearly')).toBe('price_builder_yearly_490');
    expect(priceIdForPlan('starter', 'yearly')).toBe('price_starter_yearly_1990');
    expect(priceIdForPlan('growth', 'yearly')).toBe('price_growth_yearly_9990');
    expect(priceIdForPlan('scale', 'yearly')).toBe('price_scale_yearly_29990');
  });

  it('returns null for ("founders", "yearly") regardless of env state', () => {
    process.env.STRIPE_PRICE_FOUNDERS = 'price_founders_anything';
    expect(priceIdForPlan('founders', 'yearly')).toBeNull();
  });

  it('keeps monthly and yearly resolution independent', () => {
    process.env.STRIPE_PRICE_BUILDER = 'monthly_only';
    expect(priceIdForPlan('builder', 'yearly')).toBeNull();
    expect(priceIdForPlan('builder', 'monthly')).toBe('monthly_only');
  });
});

describe('isSubscriptionActive', () => {
  it('accepts trialing, active, and past_due as "already subscribed"', () => {
    expect(isSubscriptionActive('trialing')).toBe(true);
    expect(isSubscriptionActive('active')).toBe(true);
    expect(isSubscriptionActive('past_due')).toBe(true);
  });

  it('rejects terminal states', () => {
    expect(isSubscriptionActive('canceled')).toBe(false);
    expect(isSubscriptionActive('incomplete_expired')).toBe(false);
  });

  it('rejects null / undefined / unknown strings', () => {
    expect(isSubscriptionActive(null)).toBe(false);
    expect(isSubscriptionActive(undefined)).toBe(false);
    expect(isSubscriptionActive('none')).toBe(false);
    expect(isSubscriptionActive('')).toBe(false);
  });
});

describe('BillingCheckoutFailure', () => {
  it('carries a kind discriminator and message', () => {
    const err = new BillingCheckoutFailure(
      'plan_not_configured',
      'plan builder is not configured',
    );
    expect(err.kind).toBe('plan_not_configured');
    expect(err.message).toBe('plan builder is not configured');
    expect(err.name).toBe('BillingCheckoutFailure');
    expect(err).toBeInstanceOf(Error);
  });
});
