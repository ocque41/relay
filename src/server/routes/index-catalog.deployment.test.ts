/**
 * Deployment-path test for /v1/index and /v1/index/:category.
 *
 * Calls the GET exported by app/v1/[[...path]]/route.ts with a real Request
 * and asserts that an unauthenticated caller gets 200 + Cache-Control. This
 * is the regression gate for the "agent must discover the catalog before it
 * has a token" guarantee.
 */
import { describe, it, expect, vi } from 'vitest';

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
          if (table === schema.tenant_providers) return chain([]);
          return chain([]);
        },
      }),
    },
  };
});

vi.mock('../actions/validate', () => ({
  validateActionInput: () => ({ ok: true }),
}));

import { GET } from '@/app/v1/[[...path]]/route';
import { __resetIndexCacheForTests } from './index-catalog';
import { __resetRateLimitForTests } from '../rate-limit';

function reqFor(path: string): Request {
  return new Request(`https://relay.cumulush.com${path}`, { method: 'GET' });
}

describe('GET /v1/index — deployment path', () => {
  it('200 anonymously, exposes the category index', async () => {
    __resetIndexCacheForTests();
    __resetRateLimitForTests();
    const res = await GET(reqFor('/v1/index'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('max-age=60');
    const body = (await res.json()) as {
      categories: Array<{ slug: string }>;
    };
    expect(Array.isArray(body.categories)).toBe(true);
  });

  it('200 anonymously on a known category slice', async () => {
    __resetIndexCacheForTests();
    __resetRateLimitForTests();
    const res = await GET(reqFor('/v1/index/database'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('max-age=60');
  });
});
