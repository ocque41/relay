import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  tenantRows: [] as unknown[],
}));

// ---------------------------------------------------------------------------
// DB mock
//   listProviders (src/server/providers/index.ts) does
//     await db.select().from(tenant_providers)
//   (no where/limit) and expects an array of tenant provider rows. The stub
//   below is both awaitable (thenable) and chainable so the same mock can
//   service different query shapes if other code paths need it later.
// ---------------------------------------------------------------------------
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
          if (table === schema.tenant_providers) return chain(state.tenantRows);
          return chain([]);
        },
      }),
    },
  };
});

// ---------------------------------------------------------------------------
// System under test — imported after the mock is registered
// ---------------------------------------------------------------------------
import indexCatalogRouter, { __resetIndexCacheForTests } from './index-catalog';
import { __resetRateLimitForTests } from '../rate-limit';

beforeEach(() => {
  state.tenantRows = [];
  __resetIndexCacheForTests();
  __resetRateLimitForTests();
});

function cumulusDatabaseRow() {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    tenant_id: '00000000-0000-4000-8000-000000000002',
    slug: 'cumulus-database',
    display_name: 'Cumulus Database',
    signup_webhook_url: 'https://db.cumulush.com/v1/relay/signup',
    teardown_webhook_url: null,
    webhook_secret_enc: Buffer.from('enc'),
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

describe('GET /v1/index', () => {
  it('responds 200 anonymously — public discovery, no bearer token required', async () => {
    const res = await indexCatalogRouter.request('/v1/index');
    expect(res.status).toBe(200);
  });

  it('hides demo-visibility built-ins by default — empty categories when no tenant rows exist', async () => {
    const res = await indexCatalogRouter.request('/v1/index');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      categories: { slug: string }[];
    };
    expect(body.categories).toEqual([]);
  });

  it('lists categories with built-ins when ?include=demo is passed', async () => {
    const res = await indexCatalogRouter.request('/v1/index?include=demo');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      categories: { slug: string; count: number; providerIds: string[] }[];
      aliases: Record<string, string>;
    };

    const slugs = body.categories.map((c) => c.slug);
    expect(slugs).toEqual(expect.arrayContaining(['database', 'hosting', 'email']));
    expect(slugs).not.toContain('saas');
    expect(slugs).not.toContain('cms');

    const db = body.categories.find((c) => c.slug === 'database')!;
    expect(db.providerIds).toEqual(['neon']);
    expect(db.count).toBe(1);

    expect(body.aliases.hoster).toBe('hosting');
    expect(body.aliases.mail).toBe('email');
  });

  it('sets a 60-second public Cache-Control header', async () => {
    const res = await indexCatalogRouter.request('/v1/index');
    expect(res.headers.get('Cache-Control')).toContain('max-age=60');
  });

  it('shows Cumulus Database in both public ai and database categories', async () => {
    state.tenantRows = [cumulusDatabaseRow()];
    __resetIndexCacheForTests();

    const res = await indexCatalogRouter.request('/v1/index');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      categories: Array<{ slug: string; providerIds: string[] }>;
    };

    expect(body.categories).toEqual(
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
});

describe('GET /v1/index/:category', () => {
  it('default public surface returns an empty slice for demo-only categories', async () => {
    const res = await indexCatalogRouter.request('/v1/index/database');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: unknown[] };
    expect(body.providers).toEqual([]);
  });

  it('returns neon in the database slice (with ?include=demo) with the comparison fields', async () => {
    const res = await indexCatalogRouter.request('/v1/index/database?include=demo');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      category: string;
      providers: Array<{
        id: string;
        pricingModel: string | null;
        capabilities: string[];
      }>;
    };
    expect(body.category).toBe('database');
    expect(body.providers).toHaveLength(1);
    const neon = body.providers[0];
    expect(neon.id).toBe('neon');
    expect(neon.pricingModel).toBe('free-tier');
    expect(neon.capabilities).toEqual(expect.arrayContaining(['postgres']));
  });

  it('resolves aliases — "hoster" → "hosting" (with ?include=demo)', async () => {
    const res = await indexCatalogRouter.request('/v1/index/hoster?include=demo');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      category: string;
      providers: Array<{ id: string }>;
    };
    expect(body.category).toBe('hosting');
    expect(body.providers.map((p) => p.id)).toEqual(['vercel']);
  });

  it('filters by capability (AND semantics) when include=demo', async () => {
    const hit = await indexCatalogRouter.request(
      '/v1/index/database?capability=postgres&capability=serverless&include=demo',
    );
    expect(hit.status).toBe(200);
    const hitBody = (await hit.json()) as { providers: Array<{ id: string }> };
    expect(hitBody.providers.map((p) => p.id)).toEqual(['neon']);

    const miss = await indexCatalogRouter.request(
      '/v1/index/database?capability=postgres&capability=nope&include=demo',
    );
    expect(miss.status).toBe(200);
    const missBody = (await miss.json()) as { providers: unknown[] };
    expect(missBody.providers).toEqual([]);
  });

  it('filters by pricing model when include=demo', async () => {
    const res = await indexCatalogRouter.request(
      '/v1/index/database?pricing=free-tier&include=demo',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: Array<{ id: string }> };
    expect(body.providers.map((p) => p.id)).toEqual(['neon']);

    const empty = await indexCatalogRouter.request(
      '/v1/index/database?pricing=paid&include=demo',
    );
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as { providers: unknown[] };
    expect(emptyBody.providers).toEqual([]);
  });

  it('returns 404 with the canonical list for unknown categories', async () => {
    const res = await indexCatalogRouter.request('/v1/index/widgets');
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: string;
      requested: string;
      canonical: string[];
    };
    expect(body.error).toBe('unknown_category');
    expect(body.requested).toBe('widgets');
    expect(body.canonical).toEqual(
      expect.arrayContaining(['database', 'hosting', 'email']),
    );
  });

  it('sets a 60-second public Cache-Control header on the slice', async () => {
    const res = await indexCatalogRouter.request('/v1/index/database');
    expect(res.headers.get('Cache-Control')).toContain('max-age=60');
  });

  it('returns Cumulus Database in public database and ai slices', async () => {
    state.tenantRows = [cumulusDatabaseRow()];
    __resetIndexCacheForTests();

    const database = await indexCatalogRouter.request('/v1/index/database');
    expect(database.status).toBe(200);
    const databaseBody = (await database.json()) as {
      providers: Array<{ id: string; categories: string[] }>;
    };
    expect(databaseBody.providers).toEqual([
      expect.objectContaining({
        id: 'cumulus-database',
        categories: ['ai', 'database'],
      }),
    ]);

    const ai = await indexCatalogRouter.request('/v1/index/ai');
    expect(ai.status).toBe(200);
    const aiBody = (await ai.json()) as {
      providers: Array<{ id: string; categories: string[] }>;
    };
    expect(aiBody.providers).toEqual([
      expect.objectContaining({
        id: 'cumulus-database',
        categories: ['ai', 'database'],
      }),
    ]);
  });
});
