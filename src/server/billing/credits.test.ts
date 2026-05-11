import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CREDIT_LIFETIME_MS,
  CREDIT_PACK_IDS,
  PACK_DEFS,
  priceIdForCreditPack,
} from './credits';

describe('CREDIT_PACK_IDS', () => {
  it('contains exactly the four paid plans', () => {
    expect([...CREDIT_PACK_IDS]).toEqual(['builder', 'starter', 'growth', 'scale']);
  });
});

describe('PACK_DEFS', () => {
  it('Builder: 500 actions / $20 = $0.04/action (20% off $0.05 overage)', () => {
    const def = PACK_DEFS.builder;
    expect(def.actions).toBe(500);
    expect(def.amountCents).toBe(2000);
    expect(def.amountCents / def.actions).toBeCloseTo(4); // 4¢/action
  });

  it('Starter: 5,000 actions / $80 = $0.016/action (20% off $0.02 overage)', () => {
    const def = PACK_DEFS.starter;
    expect(def.actions).toBe(5000);
    expect(def.amountCents).toBe(8000);
    expect(def.amountCents / def.actions).toBeCloseTo(1.6);
  });

  it('Growth: 25,000 actions / $400 = $0.016/action', () => {
    const def = PACK_DEFS.growth;
    expect(def.actions).toBe(25000);
    expect(def.amountCents).toBe(40000);
    expect(def.amountCents / def.actions).toBeCloseTo(1.6);
  });

  it('Scale: 100,000 actions / $800 = $0.008/action (20% off $0.01 overage)', () => {
    const def = PACK_DEFS.scale;
    expect(def.actions).toBe(100000);
    expect(def.amountCents).toBe(80000);
    expect(def.amountCents / def.actions).toBeCloseTo(0.8);
  });

  it('every pack id matches its plan field (one SKU per plan)', () => {
    for (const id of CREDIT_PACK_IDS) {
      expect(PACK_DEFS[id].plan).toBe(id);
    }
  });
});

describe('CREDIT_LIFETIME_MS', () => {
  it('is 365 days', () => {
    expect(CREDIT_LIFETIME_MS).toBe(365 * 24 * 60 * 60 * 1000);
  });
});

describe('priceIdForCreditPack', () => {
  const snapshot: Record<string, string | undefined> = {};
  const envKeys = [
    'STRIPE_PRICE_CREDITS_BUILDER',
    'STRIPE_PRICE_CREDITS_STARTER',
    'STRIPE_PRICE_CREDITS_GROWTH',
    'STRIPE_PRICE_CREDITS_SCALE',
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
    expect(priceIdForCreditPack('builder')).toBeNull();
  });

  it('reads STRIPE_PRICE_CREDITS_<PACK> for each id', () => {
    process.env.STRIPE_PRICE_CREDITS_BUILDER = 'price_credits_builder';
    process.env.STRIPE_PRICE_CREDITS_STARTER = 'price_credits_starter';
    process.env.STRIPE_PRICE_CREDITS_GROWTH = 'price_credits_growth';
    process.env.STRIPE_PRICE_CREDITS_SCALE = 'price_credits_scale';
    expect(priceIdForCreditPack('builder')).toBe('price_credits_builder');
    expect(priceIdForCreditPack('starter')).toBe('price_credits_starter');
    expect(priceIdForCreditPack('growth')).toBe('price_credits_growth');
    expect(priceIdForCreditPack('scale')).toBe('price_credits_scale');
  });
});
