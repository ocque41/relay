import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeProviderCredential } from '../credentials/envelope';
import type { signup_jobs } from '../db/schema';

const mocks = vi.hoisted(() => ({
  updateCalls: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  auditCalls: [] as unknown[][],
  activationCalls: [] as unknown[][],
}));

vi.mock('../db/index', () => ({
  db: {
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          mocks.updateCalls.push({ table, values });
          return [];
        },
      }),
    }),
  },
}));

vi.mock('../crypto', async (importActual) => {
  const actual = await importActual<typeof import('../crypto')>();
  return {
    ...actual,
    decrypt: (value: Buffer) => value,
  };
});

vi.mock('../audit', () => ({
  recordAudit: async (...args: unknown[]) => {
    mocks.auditCalls.push(args);
  },
}));

vi.mock('../activations/handoff', () => ({
  recordRelayHandoffActivation: async (...args: unknown[]) => {
    mocks.activationCalls.push(args);
  },
}));

import { api_keys, signup_jobs as signupJobsTable } from '../db/schema';
import { deliverSignupCredentialsOnce } from './handoff';

type SignupJob = typeof signup_jobs.$inferSelect;

function completeJob(
  pending: string | null,
  deliveredAt: Date | null = null,
): SignupJob {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    account_id: '22222222-2222-4222-8222-222222222222',
    status: 'complete',
    workflow_run_id: null,
    error: null,
    user_id: '33333333-3333-4333-8333-333333333333',
    tenant_id: '44444444-4444-4444-8444-444444444444',
    user_workspace_id: '55555555-5555-4555-8555-555555555555',
    calling_agent_id: '66666666-6666-4666-8666-666666666666',
    provider_slug: 'cumulus-database',
    alias: null,
    pending_credentials_enc: pending ? Buffer.from(pending) : null,
    credentials_delivered_at: deliveredAt,
    handoff_at: null,
    created_at: new Date('2026-05-01T00:00:00Z'),
    updated_at: new Date('2026-05-01T00:00:00Z'),
  } as SignupJob;
}

beforeEach(() => {
  mocks.updateCalls = [];
  mocks.auditCalls = [];
  mocks.activationCalls = [];
});

describe('deliverSignupCredentialsOnce', () => {
  it('returns structured initial_credentials once and records handoff activation', async () => {
    const handoffAt = new Date('2026-05-11T12:00:00Z');
    const encoded = encodeProviderCredential({
      endpoint: 'https://db.cumulush.com',
      database_id: 'db_123',
      data_token: 'cdb_data_123',
      admin_token: 'cdb_admin_123',
    });

    const result = await deliverSignupCredentialsOnce({
      job: completeJob(encoded),
      callingAgentId: 'agent-1',
      callerUserId: '33333333-3333-4333-8333-333333333333',
      via: 'mcp',
      deliveredAt: handoffAt,
    });

    expect(result).toEqual({
      delivered: true,
      initialApiKey: undefined,
      initialCredentials: {
        endpoint: 'https://db.cumulush.com',
        database_id: 'db_123',
        data_token: 'cdb_data_123',
        admin_token: 'cdb_admin_123',
      },
    });
    expect(mocks.updateCalls[0]).toEqual({
      table: signupJobsTable,
      values: {
        pending_credentials_enc: null,
        credentials_delivered_at: handoffAt,
        handoff_at: handoffAt,
      },
    });
    expect(mocks.updateCalls[1]).toEqual({
      table: api_keys,
      values: { last_used_at: handoffAt },
    });
    expect(mocks.auditCalls[0]).toEqual([
      'agent-1',
      'key_deliver',
      '11111111-1111-4111-8111-111111111111',
      { provider: 'cumulus-database', via: 'mcp' },
      {
        user_id: '33333333-3333-4333-8333-333333333333',
        tenant_id: '44444444-4444-4444-8444-444444444444',
      },
    ]);
    expect(mocks.activationCalls).toHaveLength(1);

    const secondRead = await deliverSignupCredentialsOnce({
      job: completeJob(null, handoffAt),
      callingAgentId: 'agent-1',
      callerUserId: '33333333-3333-4333-8333-333333333333',
      via: 'mcp',
      deliveredAt: handoffAt,
    });
    expect(secondRead).toEqual({ delivered: false });
    expect(mocks.updateCalls).toHaveLength(2);
  });

  it('keeps legacy apiKey handoff compatibility', async () => {
    const result = await deliverSignupCredentialsOnce({
      job: completeJob('legacy_api_key'),
      callingAgentId: 'agent-1',
      callerUserId: '33333333-3333-4333-8333-333333333333',
      via: 'rest',
      deliveredAt: new Date('2026-05-11T12:00:00Z'),
    });

    expect(result.initialApiKey).toBe('legacy_api_key');
    expect(result.initialCredentials).toBeUndefined();
    expect(mocks.auditCalls[0]?.[3]).toEqual({
      provider: 'cumulus-database',
      via: 'rest',
    });
  });
});
