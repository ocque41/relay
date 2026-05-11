import { afterEach, describe, expect, it } from 'vitest';
import {
  ActionQuotaExceeded,
  TenantInactive,
  billingMode,
} from './charge';

describe('billingMode', () => {
  const prev = process.env.BILLING_ENFORCEMENT;
  afterEach(() => {
    if (prev === undefined) delete process.env.BILLING_ENFORCEMENT;
    else process.env.BILLING_ENFORCEMENT = prev;
  });

  it('defaults to off when unset', () => {
    delete process.env.BILLING_ENFORCEMENT;
    expect(billingMode()).toBe('off');
  });

  it('returns warn when set to warn', () => {
    process.env.BILLING_ENFORCEMENT = 'warn';
    expect(billingMode()).toBe('warn');
  });

  it('returns enforce when set to enforce', () => {
    process.env.BILLING_ENFORCEMENT = 'enforce';
    expect(billingMode()).toBe('enforce');
  });

  it('falls back to off for unknown values', () => {
    process.env.BILLING_ENFORCEMENT = 'yolo';
    expect(billingMode()).toBe('off');
  });
});

describe('billing error shapes', () => {
  it('TenantInactive carries status 503 and state', () => {
    const err = new TenantInactive('t_123', 'past_due');
    expect(err.status).toBe(503);
    expect(err.tenantId).toBe('t_123');
    expect(err.state).toBe('past_due');
  });

  it('ActionQuotaExceeded carries status 429 and counters', () => {
    const err = new ActionQuotaExceeded('t_xyz', 550, 500);
    expect(err.status).toBe(429);
    expect(err.tenantId).toBe('t_xyz');
    expect(err.current).toBe(550);
    expect(err.included).toBe(500);
  });
});
