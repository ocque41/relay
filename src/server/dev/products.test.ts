import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// DB mock
//   registerTenantProduct performs, in order:
//     1. select(...).from(tenant_providers).where(and(slug, tenant_id)).limit(1)   — per-tenant dupe check
//     2. select(...).from(tenant_providers).where(eq(slug))           .limit(1)    — global dupe check
//     3. insert(tenant_providers).values(...).returning(...)                       — actual insert
// ---------------------------------------------------------------------------
type InsertedRow = Record<string, unknown>;
let inserted: InsertedRow[] = [];

vi.mock('../db/index', () => {
  function chain(rows: unknown[]) {
    const p = Promise.resolve(rows);
    return {
      where: () => chain(rows),
      limit: () => Promise.resolve(rows),
      then: p.then.bind(p),
      catch: p.catch.bind(p),
    };
  }

  return {
    db: {
      select: () => ({ from: () => chain([]) }),
      insert: () => ({
        values: (vals: InsertedRow) => {
          inserted.push(vals);
          return {
            returning: () =>
              Promise.resolve([
                {
                  id: '00000000-0000-0000-0000-000000000001',
                  slug: vals.slug as string,
                },
              ]),
          };
        },
      }),
    },
  };
});

// Crypto module — keep real encrypt() out of tests; `registerTenantProduct`
// only needs *some* buffer for webhook_secret_enc.
vi.mock('../crypto', () => ({
  encrypt: (s: string) => Buffer.from(`enc:${s}`),
}));

import {
  registerTenantProduct,
  RegisterTenantProductFailure,
} from './products';

beforeEach(() => {
  inserted = [];
});

describe('registerTenantProduct — discovery metadata', () => {
  it('normalizes aliases to canonical categories before persisting', async () => {
    const result = await registerTenantProduct({
      tenantId: '00000000-0000-0000-0000-000000000000',
      slug: 'acme-mail',
      displayName: 'Acme Mail',
      signupWebhookUrl: 'https://acme.test/hook',
      categories: ['mail', 'newsletters', 'mail'],
    });
    expect(result.categories).toEqual(['email', 'newsletter']);
    expect(inserted[0].categories).toEqual(['email', 'newsletter']);
  });

  it('throws invalid_categories with the bad inputs + canonical list', async () => {
    let caught: RegisterTenantProductFailure | null = null;
    try {
      await registerTenantProduct({
        tenantId: '00000000-0000-0000-0000-000000000000',
        slug: 'bad-cat',
        displayName: 'Bad Cat',
        signupWebhookUrl: 'https://x.test/hook',
        categories: ['database', 'widgets', 'not-a-thing'],
      });
    } catch (e) {
      if (e instanceof RegisterTenantProductFailure) caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.kind).toBe('invalid_categories');
    expect(caught!.invalid).toEqual(['widgets', 'not-a-thing']);
    expect(caught!.canonical).toEqual(
      expect.arrayContaining(['database', 'hosting', 'email']),
    );
  });

  it('persists pricing + capabilities + other discovery fields', async () => {
    await registerTenantProduct({
      tenantId: '00000000-0000-0000-0000-000000000000',
      slug: 'acme-db',
      displayName: 'Acme DB',
      signupWebhookUrl: 'https://acme.test/hook',
      description: 'A Postgres clone.',
      docsUrl: 'https://acme.test/docs',
      homepage: 'https://acme.test',
      npmPackage: '@acme/db',
      categories: ['database'],
      pricingModel: 'free-tier',
      pricingUrl: 'https://acme.test/pricing',
      freeTierSummary: '5 GB forever',
      capabilities: ['Postgres', ' SERVERLESS ', 'postgres'], // dup + case + trim
    });
    const row = inserted[0];
    expect(row.description).toBe('A Postgres clone.');
    expect(row.docs_url).toBe('https://acme.test/docs');
    expect(row.homepage).toBe('https://acme.test');
    expect(row.npm_package).toBe('@acme/db');
    expect(row.pricing_model).toBe('free-tier');
    expect(row.pricing_url).toBe('https://acme.test/pricing');
    expect(row.free_tier_summary).toBe('5 GB forever');
    // Capabilities normalized: lowercase, trimmed, deduped
    expect(row.capabilities).toEqual(['postgres', 'serverless']);
  });

  it('rejects an unknown pricing model', async () => {
    await expect(() =>
      registerTenantProduct({
        tenantId: '00000000-0000-0000-0000-000000000000',
        slug: 'acme-x',
        displayName: 'Acme X',
        signupWebhookUrl: 'https://acme.test/hook',
        // @ts-expect-error — testing runtime validation of a bad value
        pricingModel: 'enterprise-only',
      }),
    ).rejects.toBeInstanceOf(RegisterTenantProductFailure);
  });
});
