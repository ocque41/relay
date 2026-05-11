import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from './auth';
import { __resetRateLimitForTests, rateLimit } from './rate-limit';

function buildApp(limit: number) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('agent', {
      agentId: 'test-agent',
      userId: 'test-user',
      tenantId: null,
      userWorkspaceId: null,
      scopes: [],
    });
    await next();
  });
  app.use('*', rateLimit(limit));
  app.get('/', (c) => c.text('ok'));
  return app;
}

describe('rateLimit middleware', () => {
  beforeEach(() => {
    __resetRateLimitForTests();
  });

  it('allows requests under the limit', async () => {
    const app = buildApp(3);
    for (let i = 0; i < 3; i++) {
      const res = await app.request('/');
      expect(res.status).toBe(200);
    }
  });

  it('returns 429 + Retry-After once the limit is exceeded', async () => {
    const app = buildApp(2);
    await app.request('/');
    await app.request('/');
    const res = await app.request('/');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    const body = (await res.json()) as { error: string; retryAfter: number };
    expect(body.error).toBe('rate_limit_exceeded');
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it('falls back to IP keying when no agent context is set', async () => {
    const app = new Hono();
    app.use('*', rateLimit(1));
    app.get('/', (c) => c.text('ok'));

    const first = await app.request('/', { headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(first.status).toBe(200);
    const second = await app.request('/', { headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(second.status).toBe(429);
  });
});
