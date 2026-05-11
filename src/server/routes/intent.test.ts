import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock state — workspaces, accounts, signup_jobs, and intent_resolutions are
// stubbed to test the route's dispatch shape without a real DB. The mock is
// chainable + thenable like the index-catalog test, but routes are tracked
// per-table via a small switch.
// ---------------------------------------------------------------------------
const fakeAgent = {
  id: 'agent-1',
  user_id: 'user-1',
  user_workspace_id: null,
  scopes: [],
  token_hash: 'placeholder',
  revoked_at: null,
  created_at: new Date(),
  last_used_at: null,
  label: null,
};

const fakeWorkspace = {
  id: '11111111-2222-4333-8444-555555555555',
  user_id: 'user-1',
};

let signupKickResult: { ok: true; signupJobId: string } | { ok: false; status: number; body: { error: string } } = {
  ok: true,
  signupJobId: '22222222-3333-4444-9555-666666666666',
};

let stubAccounts: Array<{ id: string; provider_id: string; alias: string | null }> = [];
let stubInFlightSignups: Array<{ id: string; provider_slug: string; alias: string | null }> = [];
let cachedIntentResponse: unknown = null;
let cachedIntentExpiresAt: Date = new Date(Date.now() + 24 * 60 * 60 * 1000);
let workspaceMissing = false;

vi.mock('../db/index', async () => {
  const schema = await import('../db/schema');

  function chain(rows: unknown[]) {
    const p = Promise.resolve(rows);
    return {
      where: () => chain(rows),
      orderBy: () => chain(rows),
      leftJoin: () => chain(rows),
      innerJoin: () => chain(rows),
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
          if (table === schema.user_workspaces)
            return chain(workspaceMissing ? [] : [fakeWorkspace]);
          if (table === schema.accounts) return chain(stubAccounts);
          if (table === schema.signup_jobs) return chain(stubInFlightSignups);
          if (table === schema.api_keys) return chain([]);
          if (table === schema.tenant_providers) return chain([]);
          if (table === schema.intent_resolutions) {
            if (cachedIntentResponse !== null) {
              return chain([
                {
                  response_json: cachedIntentResponse,
                  expires_at: cachedIntentExpiresAt,
                },
              ]);
            }
            return chain([]);
          }
          return chain([]);
        },
      }),
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => Promise.resolve(),
          then: (cb: (v: void) => unknown) => Promise.resolve().then(cb),
        }),
      }),
    },
  };
});

// Mock kickSignup so we don't try to start a real WDK workflow.
vi.mock('../signups/kick', () => ({
  kickSignup: vi.fn(async () => signupKickResult),
}));

// Mock recordAudit to a no-op so the test doesn't try to insert into a real
// audit table.
vi.mock('../audit', () => ({
  recordAudit: vi.fn(async () => undefined),
}));

import intentRouter from './intent';
import { __resetRateLimitForTests } from '../rate-limit';

const AUTH = { Authorization: 'Bearer agt_test_token' };

beforeEach(() => {
  __resetRateLimitForTests();
  signupKickResult = { ok: true, signupJobId: '22222222-3333-4444-9555-666666666666' };
  stubAccounts = [];
  stubInFlightSignups = [];
  cachedIntentResponse = null;
  cachedIntentExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  workspaceMissing = false;
});

describe('POST /v1/intent', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await intentRouter.request('/v1/intent', {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'postgres', workspaceId: fakeWorkspace.id }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects unsupported envStyle with 400', async () => {
    const res = await intentRouter.request('/v1/intent', {
      method: 'post',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: 'postgres',
        workspaceId: fakeWorkspace.id,
        envStyle: 'next',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('envStyle');
  });

  it('returns 404 when workspaceId is not owned by the user', async () => {
    workspaceMissing = true;
    const res = await intentRouter.request('/v1/intent', {
      method: 'post',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: 'postgres',
        workspaceId: 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee',
      }),
    });
    expect(res.status).toBe(404);
  });

  it('kicks a signup for a parsed category with no existing account', async () => {
    const res = await intentRouter.request('/v1/intent', {
      method: 'post',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: 'postgres for next.js',
        workspaceId: fakeWorkspace.id,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resolutions: Array<{ category: string; provider: string; status: string; signupJobId?: string }>;
      pending: string[];
      envBlock: string;
    };
    const dbRes = body.resolutions.find((r) => r.category === 'database');
    expect(dbRes?.provider).toBe('neon');
    expect(dbRes?.status).toBe('provisioning');
    expect(dbRes?.signupJobId).toBe('22222222-3333-4444-9555-666666666666');
    expect(body.pending).toContain('22222222-3333-4444-9555-666666666666');
    expect(body.envBlock).toContain('DATABASE_URL=__pending__');
  });

  it('returns existing-account resolution when account already exists', async () => {
    stubAccounts = [
      {
        id: '33333333-4444-4555-8666-777777777777',
        provider_id: 'neon',
        alias: null,
      },
    ];
    const res = await intentRouter.request('/v1/intent', {
      method: 'post',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: 'postgres database',
        workspaceId: fakeWorkspace.id,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resolutions: Array<{ status: string; accountId?: string }>;
      pending: string[];
    };
    expect(body.resolutions[0].status).toBe('existing');
    expect(body.resolutions[0].accountId).toBe('33333333-4444-4555-8666-777777777777');
    expect(body.pending).toEqual([]);
  });

  it('reuses an in-flight signup_job instead of kicking a duplicate', async () => {
    stubInFlightSignups = [
      {
        id: '44444444-5555-4666-8777-888888888888',
        provider_slug: 'neon',
        alias: null,
      },
    ];
    const res = await intentRouter.request('/v1/intent', {
      method: 'post',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: 'postgres',
        workspaceId: fakeWorkspace.id,
      }),
    });
    const body = (await res.json()) as {
      resolutions: Array<{ status: string; signupJobId?: string }>;
      pending: string[];
    };
    expect(body.resolutions[0].status).toBe('provisioning');
    expect(body.resolutions[0].signupJobId).toBe('44444444-5555-4666-8777-888888888888');
    expect(body.pending).toEqual(['44444444-5555-4666-8777-888888888888']);
  });

  it('returns cached response on Idempotency-Key replay', async () => {
    cachedIntentResponse = {
      resolutions: [{ category: 'database', alias: null, provider: 'neon', status: 'existing' }],
      envBlock: 'DATABASE_URL=__reveal_required__\n',
      pending: [],
      unsatisfied: [],
      unmatchedTerms: [],
      revealAllUrl: null,
      notes: ['from cache'],
    };
    const res = await intentRouter.request('/v1/intent', {
      method: 'post',
      headers: {
        ...AUTH,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'replay-1',
      },
      body: JSON.stringify({
        goal: 'postgres',
        workspaceId: fakeWorkspace.id,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes: string[] };
    expect(body.notes).toEqual(['from cache']);
  });

  it('mirrors no_provider categories into unsatisfied[]', async () => {
    // "vector store" parses to ['ai'] which has no registered providers.
    const res = await intentRouter.request('/v1/intent', {
      method: 'post',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: 'vector store for embeddings',
        workspaceId: fakeWorkspace.id,
      }),
    });
    const body = (await res.json()) as {
      resolutions: Array<{ category: string; status: string }>;
      unsatisfied: Array<{ category: string; reason: string }>;
    };
    const ai = body.resolutions.find((r) => r.category === 'ai');
    expect(ai?.status).toBe('no_provider');
    expect(body.unsatisfied.find((u) => u.category === 'ai')?.reason).toBe('no_provider');
  });
});
