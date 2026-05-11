import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  tenantRows: [] as unknown[],
}));

vi.mock('../server/db/index', async () => {
  const schema = await import('../server/db/schema');

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
          if (table === schema.tenant_providers) return chain(state.tenantRows);
          return chain([]);
        },
      }),
    },
  };
});

vi.mock('../server/crypto', async (importActual) => {
  const actual = await importActual<typeof import('../server/crypto')>();
  return {
    ...actual,
    decrypt: (value: Buffer) => value,
  };
});

import {
  computeCategorySlice,
  computeIndexOverview,
  __resetIndexCacheForTests,
} from '../server/routes/index-catalog';
import { getProvider, listProviders } from '../server/providers/index';

function cumulusDatabaseRow() {
  return {
    id: 'provider-row-1',
    tenant_id: 'tenant-1',
    slug: 'cumulus-database',
    display_name: 'Cumulus Database',
    signup_webhook_url: 'https://db.cumulush.com/v1/relay/signup',
    teardown_webhook_url: null,
    webhook_secret_enc: Buffer.from('relay-webhook-secret'),
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        agent_id: { type: 'string' },
        purpose: { type: 'string' },
      },
      required: ['email'],
      additionalProperties: true,
    },
    description: 'Agent-owned memory, records, key-value data, secrets, and hybrid search.',
    docs_url: 'https://db.cumulush.com/docs',
    homepage: 'https://db.cumulush.com',
    npm_package: null,
    categories: ['ai', 'database'],
    pricing_model: 'free-tier',
    pricing_url: 'https://db.cumulush.com/pricing',
    free_tier_summary: 'MVP workspace for agent memory and database handoff.',
    capabilities: ['agent-memory', 'key-value', 'hybrid-search', 'secrets'],
    needs_email_verification: false,
    verification_mode: 'none',
  };
}

beforeEach(() => {
  state.tenantRows = [cumulusDatabaseRow()];
  __resetIndexCacheForTests();
});

describe('MCP Cumulus Database shared discovery surfaces', () => {
  it('backs list_categories with public ai and database entries', async () => {
    const overview = await computeIndexOverview();
    expect(overview.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'ai',
          providerIds: ['cumulus-database'],
        }),
        expect.objectContaining({
          slug: 'database',
          providerIds: ['cumulus-database'],
        }),
      ]),
    );
  });

  it('backs list_providers_by_category for both database and ai', async () => {
    const database = await computeCategorySlice('database');
    expect(database).toEqual({
      kind: 'ok',
      slice: expect.objectContaining({
        category: 'database',
        providers: [
          expect.objectContaining({
            id: 'cumulus-database',
            categories: ['ai', 'database'],
          }),
        ],
      }),
    });

    const ai = await computeCategorySlice('ai');
    expect(ai).toEqual({
      kind: 'ok',
      slice: expect.objectContaining({
        category: 'ai',
        providers: [
          expect.objectContaining({
            id: 'cumulus-database',
            categories: ['ai', 'database'],
          }),
        ],
      }),
    });
  });

  it('backs list_providers and create_signup provider lookup for cumulus-database', async () => {
    const providers = await listProviders();
    expect(providers).toEqual([
      expect.objectContaining({
        id: 'cumulus-database',
        kind: 'tenant',
        categories: ['ai', 'database'],
      }),
    ]);

    const provider = await getProvider('cumulus-database');
    expect(provider?.id).toBe('cumulus-database');
    expect(() =>
      provider?.inputSchema.parse({
        email: 'alex@example.com',
        purpose: 'project memory',
      }),
    ).not.toThrow();
  });
});
