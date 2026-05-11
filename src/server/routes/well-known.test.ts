import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import wellKnownRouter from './well-known';

describe('GET /.well-known/relay.json', () => {
  const original = { app: process.env.APP_BASE_URL, vercel: process.env.VERCEL_PROJECT_PRODUCTION_URL };

  beforeEach(() => {
    delete process.env.APP_BASE_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  });
  afterEach(() => {
    if (original.app !== undefined) process.env.APP_BASE_URL = original.app;
    if (original.vercel !== undefined) process.env.VERCEL_PROJECT_PRODUCTION_URL = original.vercel;
  });

  it('is unauthenticated and returns the canonical discovery shape', async () => {
    process.env.APP_BASE_URL = 'https://relay.example.com';
    const res = await wellKnownRouter.request('/.well-known/relay.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.apiBase).toBe('https://relay.example.com');
    expect(body.mcpEndpoint).toBe('https://relay.example.com/mcp');
    expect(body.openapiUrl).toBe('https://relay.example.com/openapi.json');
    expect(body.docsUrl).toBe('https://relay.example.com/docs');
    expect(body.agentDocsUrl).toBe('https://relay.example.com/docs/agent-builders');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.authScheme).toBe('Bearer agt_<token>');
  });

  it('falls back to VERCEL_PROJECT_PRODUCTION_URL when APP_BASE_URL is unset', async () => {
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'api-ebon-gamma-37.vercel.app';
    const res = await wellKnownRouter.request('/.well-known/relay.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { apiBase: string };
    expect(body.apiBase).toBe('https://api-ebon-gamma-37.vercel.app');
  });

  it('falls back to localhost when no env is set', async () => {
    const res = await wellKnownRouter.request('/.well-known/relay.json');
    const body = (await res.json()) as { apiBase: string };
    expect(body.apiBase).toBe('http://localhost:3000');
  });

  it('sets a short Cache-Control header', async () => {
    const res = await wellKnownRouter.request('/.well-known/relay.json');
    expect(res.headers.get('Cache-Control')).toContain('max-age=300');
  });
});
