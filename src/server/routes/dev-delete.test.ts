/**
 * Tests for DELETE /v1/dev/settings — hard workspace delete.
 *
 * The mock returns from each table-select vary per test so we can exercise:
 *   - happy path (owner + no live sub + correct name)
 *   - owner guard (caller is not the tenant's owner)
 *   - name mismatch (confirm_name doesn't match tenant name)
 *   - active subscription block (trialing / active / past_due)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const fakeAgent = { id: 'agent-1', user_id: 'user-1' };
const tenantRow = {
  id: 't1',
  slug: 'acme',
  name: 'Acme',
  owner_user_id: 'user-1',
  domain: null,
  rp_id: null,
  allowed_origins: [],
  created_at: new Date('2026-01-01T00:00:00Z'),
};

// ---------------------------------------------------------------------------
// State the tests mutate to pick a scenario.
// ---------------------------------------------------------------------------
interface MockState {
  ownerMatchesCaller: boolean;
  subscriptionStatus: string | null;
  deletedTenants: string[];
  auditInserts: unknown[];
  sessionUpdates: unknown[];
}
const state: MockState = {
  ownerMatchesCaller: true,
  subscriptionStatus: null,
  deletedTenants: [],
  auditInserts: [],
  sessionUpdates: [],
};

vi.mock('../db/index', async () => {
  const schema = await import('../db/schema');

  function chain(rows: unknown[]) {
    const p = Promise.resolve(rows);
    return {
      where: () => chain(rows),
      orderBy: () => chain(rows),
      limit: () => Promise.resolve(rows),
      then: p.then.bind(p),
      catch: p.catch.bind(p),
    };
  }

  return {
    db: {
      select: () => ({
        from: (table: unknown) => {
          if (table === schema.agents) return chain([fakeAgent]);
          if (table === schema.tenants) {
            // Mimics both the ownership check (filter by owner_user_id)
            // and the handler's own lookup — the mock ignores the where
            // clause, so we branch via `ownerMatchesCaller`.
            if (state.ownerMatchesCaller) return chain([tenantRow]);
            return chain([]);
          }
          if (table === schema.tenant_members) return chain([]);
          if (table === schema.tenant_subscriptions) {
            return state.subscriptionStatus
              ? chain([{ status: state.subscriptionStatus }])
              : chain([]);
          }
          return chain([]);
        },
      }),
      insert: (table: unknown) => ({
        values: (vals: unknown) => {
          if (table === schema.audit_log) state.auditInserts.push(vals);
          return Promise.resolve([]);
        },
      }),
      update: () => ({
        set: (vals: unknown) => ({
          where: () => {
            state.sessionUpdates.push(vals);
            return Promise.resolve([]);
          },
        }),
      }),
      delete: (table: unknown) => ({
        where: () => {
          if (table === schema.tenants) state.deletedTenants.push('deleted');
          return Promise.resolve([]);
        },
      }),
    },
  };
});

import devRouter from './dev';
import { __resetRateLimitForTests } from '../rate-limit';

const HEADERS: Record<string, string> = {
  Authorization: 'Bearer agt_test',
  'X-Relay-Tenant': 't1',
  'Content-Type': 'application/json',
};

beforeEach(() => {
  state.ownerMatchesCaller = true;
  state.subscriptionStatus = null;
  state.deletedTenants = [];
  state.auditInserts = [];
  state.sessionUpdates = [];
  __resetRateLimitForTests();
});

describe('DELETE /v1/dev/settings', () => {
  it('deletes the workspace when owner + no subscription + correct name', async () => {
    const res = await devRouter.request('/v1/dev/settings', {
      method: 'DELETE',
      headers: HEADERS,
      body: JSON.stringify({ confirm_name: 'Acme' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean; tenant_id: string };
    expect(body.deleted).toBe(true);
    expect(body.tenant_id).toBe('t1');

    expect(state.deletedTenants).toEqual(['deleted']);
    expect(state.auditInserts).toHaveLength(1);
    // Sessions pointing at this tenant get flipped back to the user workspace.
    expect(state.sessionUpdates[0]).toEqual({ active_workspace: { kind: 'user' } });
  });

  it('refuses when the typed name does not match', async () => {
    const res = await devRouter.request('/v1/dev/settings', {
      method: 'DELETE',
      headers: HEADERS,
      body: JSON.stringify({ confirm_name: 'Not-Acme' }),
    });
    expect(res.status).toBe(400);
    expect(state.deletedTenants).toEqual([]);
    expect(state.auditInserts).toEqual([]);
  });

  it('refuses when a trialing subscription is live', async () => {
    state.subscriptionStatus = 'trialing';
    const res = await devRouter.request('/v1/dev/settings', {
      method: 'DELETE',
      headers: HEADERS,
      body: JSON.stringify({ confirm_name: 'Acme' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      subscription_status: string;
    };
    expect(body.error).toBe('active_subscription');
    expect(body.subscription_status).toBe('trialing');
    expect(state.deletedTenants).toEqual([]);
  });

  it('refuses when an active subscription is live', async () => {
    state.subscriptionStatus = 'active';
    const res = await devRouter.request('/v1/dev/settings', {
      method: 'DELETE',
      headers: HEADERS,
      body: JSON.stringify({ confirm_name: 'Acme' }),
    });
    expect(res.status).toBe(409);
    expect(state.deletedTenants).toEqual([]);
  });

  it('refuses when a past_due subscription is live', async () => {
    state.subscriptionStatus = 'past_due';
    const res = await devRouter.request('/v1/dev/settings', {
      method: 'DELETE',
      headers: HEADERS,
      body: JSON.stringify({ confirm_name: 'Acme' }),
    });
    expect(res.status).toBe(409);
  });

  it('proceeds when a canceled subscription exists', async () => {
    state.subscriptionStatus = 'canceled';
    const res = await devRouter.request('/v1/dev/settings', {
      method: 'DELETE',
      headers: HEADERS,
      body: JSON.stringify({ confirm_name: 'Acme' }),
    });
    expect(res.status).toBe(200);
    expect(state.deletedTenants).toEqual(['deleted']);
  });

  it('rejects a bearer whose user is not a tenant member', async () => {
    state.ownerMatchesCaller = false;
    const res = await devRouter.request('/v1/dev/settings', {
      method: 'DELETE',
      headers: HEADERS,
      body: JSON.stringify({ confirm_name: 'Acme' }),
    });
    // userCanAccessTenant fails first in the middleware → 403 forbidden
    expect(res.status).toBe(403);
    expect(state.deletedTenants).toEqual([]);
  });
});
