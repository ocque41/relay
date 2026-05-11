import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import manifestRouter from './agents-manifest';

describe('agents-manifest routes', () => {
  const original = {
    app: process.env.APP_BASE_URL,
    vercel: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  };

  beforeEach(() => {
    process.env.APP_BASE_URL = 'https://relay.example.com';
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  });

  afterEach(() => {
    if (original.app !== undefined) process.env.APP_BASE_URL = original.app;
    else delete process.env.APP_BASE_URL;
    if (original.vercel !== undefined) process.env.VERCEL_PROJECT_PRODUCTION_URL = original.vercel;
  });

  it('GET /AGENTS.md → 200 text/markdown with cache header', async () => {
    const res = await manifestRouter.request('/AGENTS.md');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/markdown');
    expect(res.headers.get('Cache-Control')).toContain('max-age=300');
    const body = await res.text();
    expect(body).toContain('https://relay.example.com');
    expect(body).toMatch(/Authorization: Bearer agt_/);
  });

  it('GET /CLAUDE.md mirrors /AGENTS.md', async () => {
    const a = await (await manifestRouter.request('/AGENTS.md')).text();
    const b = await (await manifestRouter.request('/CLAUDE.md')).text();
    expect(b).toBe(a);
  });

  it('GET /llms.txt → 200 text/plain with links to AGENTS.md, openapi, docs, mcp', async () => {
    const res = await manifestRouter.request('/llms.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('https://relay.example.com/AGENTS.md');
    expect(body).toContain('https://relay.example.com/openapi.json');
    expect(body).toContain('https://relay.example.com/docs');
    expect(body).toContain('https://relay.example.com/mcp');
  });

  it('GET /llms-full.txt → 200 text/plain with the full guide body', async () => {
    const res = await manifestRouter.request('/llms-full.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toMatch(/zero[- ]retention/i);
  });

  it('unauthenticated fetch appends the "sign in for per-user guidance" note', async () => {
    const res = await manifestRouter.request('/AGENTS.md');
    const body = await res.text();
    expect(body).toMatch(/sign in|bearer token/i);
  });
});
