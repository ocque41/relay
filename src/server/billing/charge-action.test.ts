import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// DB mock — chargeAction's fairness debounce calls
//   db.execute(sql`INSERT INTO user_provider_action_days ... RETURNING action_count`)
// We control what action_count comes back so we can exercise both
// "first hit of the day" (count=1) and "repeat hit" (count>1) paths.
// requireIntegratorQuota / refundIntegratorQuota / requireActiveTenantSubscription
// are stubbed out so the tests exercise charge-action.ts in isolation.
// ---------------------------------------------------------------------------

const dbExecuteMock = vi.fn(async () => ({ rows: [{ action_count: 1 }] }));
const requireIntegratorQuotaMock = vi.fn(async () => ({
  tenantId: 't1',
  idempotencyKey: 'k',
  effectivePeriodStart: new Date(),
  effectivePeriodEnd: new Date(),
  includedRemaining: 99,
  overageRemaining: 0,
}));
const refundIntegratorQuotaMock = vi.fn(async () => undefined);
const requireActiveTenantSubscriptionMock = vi.fn(async () => undefined);
const checkUserActionLimitMock = vi.fn(async () => null);
const decrementUserActionLimitMock = vi.fn(async () => undefined);

vi.mock('../db/index', () => ({
  db: {
    execute: (...args: unknown[]) => dbExecuteMock(...(args as [])),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [] }),
      }),
    }),
  },
}));

vi.mock('./quota', () => ({
  requireIntegratorQuota: (...args: unknown[]) =>
    requireIntegratorQuotaMock(...(args as [])),
  refundIntegratorQuota: (...args: unknown[]) =>
    refundIntegratorQuotaMock(...(args as [])),
}));

vi.mock('./charge', () => ({
  TenantInactive: class TenantInactive extends Error {
    readonly status = 503 as const;
    constructor(public tenantId: string, public state: string) {
      super(`tenant ${tenantId} ${state}`);
    }
  },
  billingMeter: () => (process.env.BILLING_METER === 'actions' ? 'actions' : 'signups'),
  requireActiveTenantSubscription: (...args: unknown[]) =>
    requireActiveTenantSubscriptionMock(...(args as [])),
}));

vi.mock('../abuse/signup-limit', () => ({
  checkUserActionLimit: (...args: unknown[]) =>
    checkUserActionLimitMock(...(args as [])),
  decrementUserActionLimit: (...args: unknown[]) =>
    decrementUserActionLimitMock(...(args as [])),
}));

import { billingMeter } from './charge';
import { billingFairness, chargeAction, refundAction } from './charge-action';

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  process.env.BILLING_ENFORCEMENT = 'off';
  process.env.ABUSE_ENFORCEMENT = 'off';
  delete process.env.BILLING_METER;
  delete process.env.BILLING_FAIRNESS;
  dbExecuteMock.mockReset();
  dbExecuteMock.mockResolvedValue({ rows: [{ action_count: 1 }] });
  requireIntegratorQuotaMock.mockReset();
  requireIntegratorQuotaMock.mockResolvedValue({
    tenantId: 't1',
    idempotencyKey: 'k',
    effectivePeriodStart: new Date(),
    effectivePeriodEnd: new Date(),
    includedRemaining: 99,
    overageRemaining: 0,
  });
  refundIntegratorQuotaMock.mockReset();
  refundIntegratorQuotaMock.mockResolvedValue(undefined);
  requireActiveTenantSubscriptionMock.mockReset();
  requireActiveTenantSubscriptionMock.mockResolvedValue(undefined);
  checkUserActionLimitMock.mockReset();
  checkUserActionLimitMock.mockResolvedValue(null);
  decrementUserActionLimitMock.mockReset();
  decrementUserActionLimitMock.mockResolvedValue(undefined);
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

describe('billingMeter()', () => {
  it('defaults to "signups"', () => {
    delete process.env.BILLING_METER;
    expect(billingMeter()).toBe('signups');
  });

  it('returns "actions" when BILLING_METER=actions', () => {
    process.env.BILLING_METER = 'actions';
    expect(billingMeter()).toBe('actions');
  });

  it('treats unknown values as signups', () => {
    process.env.BILLING_METER = 'whatever';
    expect(billingMeter()).toBe('signups');
  });
});

describe('billingFairness()', () => {
  it('defaults to "on"', () => {
    delete process.env.BILLING_FAIRNESS;
    expect(billingFairness()).toBe('on');
  });

  it('returns "off" only when BILLING_FAIRNESS=off', () => {
    process.env.BILLING_FAIRNESS = 'off';
    expect(billingFairness()).toBe('off');
  });

  it('treats any other value as on', () => {
    process.env.BILLING_FAIRNESS = 'yes';
    expect(billingFairness()).toBe('on');
  });
});

describe('chargeAction (off mode, no-tenant fast paths)', () => {
  it('produces a fresh idempotency key when none is supplied', async () => {
    const r = await chargeAction({
      tenantId: null,
      userId: 'user-1',
      providerId: 'neon',
      action: 'reveal',
    });
    expect(r.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(r.claim).toBeNull();
    expect(r.userCounterBumped).toBe(false);
    expect(r.debouncedAway).toBe(false);
  });

  it('threads through a caller-supplied idempotency key', async () => {
    const r = await chargeAction({
      tenantId: null,
      userId: 'user-1',
      providerId: 'neon',
      action: 'signup',
      idempotencyKey: 'job-abc',
    });
    expect(r.idempotencyKey).toBe('job-abc');
  });

  it('refundAction with no claim is a no-op', async () => {
    await expect(
      refundAction({
        tenantId: null,
        userId: 'user-1',
        receipt: {
          idempotencyKey: 'noop',
          claim: null,
          userCounterBumped: false,
          debouncedAway: false,
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('chargeAction fairness debounce', () => {
  beforeEach(() => {
    process.env.BILLING_METER = 'actions';
    process.env.BILLING_FAIRNESS = 'on';
  });

  it('first reveal of the day for a (user, tenant, provider) bills integrator quota', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [{ action_count: 1 }] });
    const r = await chargeAction({
      tenantId: 't1',
      userId: 'u1',
      providerId: 'acme',
      action: 'reveal',
    });
    expect(r.debouncedAway).toBe(false);
    expect(r.claim).not.toBeNull();
    expect(requireIntegratorQuotaMock).toHaveBeenCalledTimes(1);
  });

  it('second same-day reveal of the same triple is debounced — no integrator-quota debit', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [{ action_count: 2 }] });
    const r = await chargeAction({
      tenantId: 't1',
      userId: 'u1',
      providerId: 'acme',
      action: 'reveal',
    });
    expect(r.debouncedAway).toBe(true);
    expect(r.claim).toBeNull();
    expect(requireIntegratorQuotaMock).not.toHaveBeenCalled();
  });

  it('two reveals across two providers under one tenant both bill', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [{ action_count: 1 }] });
    const r1 = await chargeAction({
      tenantId: 't1',
      userId: 'u1',
      providerId: 'acme',
      action: 'reveal',
    });
    dbExecuteMock.mockResolvedValueOnce({ rows: [{ action_count: 1 }] });
    const r2 = await chargeAction({
      tenantId: 't1',
      userId: 'u1',
      providerId: 'beta',
      action: 'reveal',
    });
    expect(r1.debouncedAway).toBe(false);
    expect(r2.debouncedAway).toBe(false);
    expect(requireIntegratorQuotaMock).toHaveBeenCalledTimes(2);
  });

  it('signup is never debounced (always bills)', async () => {
    const r = await chargeAction({
      tenantId: 't1',
      userId: 'u1',
      providerId: 'acme',
      action: 'signup',
    });
    expect(r.debouncedAway).toBe(false);
    expect(dbExecuteMock).not.toHaveBeenCalled();
    expect(requireIntegratorQuotaMock).toHaveBeenCalledTimes(1);
  });

  it('delete is never debounced (always bills)', async () => {
    const r = await chargeAction({
      tenantId: 't1',
      userId: 'u1',
      providerId: 'acme',
      action: 'delete',
    });
    expect(r.debouncedAway).toBe(false);
    expect(dbExecuteMock).not.toHaveBeenCalled();
    expect(requireIntegratorQuotaMock).toHaveBeenCalledTimes(1);
  });

  it('BILLING_FAIRNESS=off short-circuits the debounce — every reveal bills', async () => {
    process.env.BILLING_FAIRNESS = 'off';
    const r = await chargeAction({
      tenantId: 't1',
      userId: 'u1',
      providerId: 'acme',
      action: 'reveal',
    });
    expect(r.debouncedAway).toBe(false);
    expect(dbExecuteMock).not.toHaveBeenCalled();
    expect(requireIntegratorQuotaMock).toHaveBeenCalledTimes(1);
  });

  it('quota claim failure on first-of-day reveal unwinds the day-counter', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [{ action_count: 1 }] });
    requireIntegratorQuotaMock.mockRejectedValueOnce(
      Object.assign(new Error('quota exhausted'), { status: 429 }),
    );
    await expect(
      chargeAction({
        tenantId: 't1',
        userId: 'u1',
        providerId: 'acme',
        action: 'reveal',
      }),
    ).rejects.toThrow('quota exhausted');
    // The unwind UPDATE statement should have been issued — INSERT then
    // UPDATE = 2 db.execute calls.
    expect(dbExecuteMock).toHaveBeenCalledTimes(2);
  });
});
