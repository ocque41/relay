import { describe, it, expect, vi } from 'vitest';

// Stub out the DB so we can exercise listProviders() without hitting Postgres.
// The stub returns an empty list of tenant providers; the built-in registry
// is what we're testing here.
vi.mock('../db/index', () => ({
  db: {
    select: () => ({
      from: () => Promise.resolve([]),
    }),
  },
}));

import { listProviders } from './index';

describe('listProviders — metadata propagation', () => {
  it('returns neon/vercel/resend with discovery metadata populated when includeDemo=true', async () => {
    const providers = await listProviders({ includeDemo: true });
    const ids = providers.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['neon', 'vercel', 'resend']));

    const neon = providers.find((p) => p.id === 'neon')!;
    expect(neon.displayName).toBe('Neon');
    expect(neon.description).toMatch(/Postgres/i);
    expect(neon.homepage).toBe('https://neon.tech');
    expect(neon.docsUrl).toBe('https://neon.tech/docs');
    expect(neon.npmPackage).toBe('@neondatabase/serverless');
    expect(neon.categories).toEqual(['database']);
    expect(neon.capabilities).toEqual(expect.arrayContaining(['postgres', 'serverless']));
    expect(neon.pricingModel).toBe('free-tier');
    expect(neon.pricingUrl).toBe('https://neon.tech/pricing');
    expect(neon.freeTierSummary).toMatch(/storage/i);
    expect(neon.kind).toBe('builtin');
    expect(neon.visibility).toBe('demo');

    const vercel = providers.find((p) => p.id === 'vercel')!;
    expect(vercel.displayName).toBe('Vercel');
    expect(vercel.categories).toEqual(['hosting']);
    expect(vercel.capabilities).toEqual(expect.arrayContaining(['fluid-compute', 'edge']));
    expect(vercel.pricingModel).toBe('free-tier');
    expect(vercel.visibility).toBe('demo');

    const resend = providers.find((p) => p.id === 'resend')!;
    expect(resend.displayName).toBe('Resend');
    expect(resend.categories).toEqual(['email']);
    expect(resend.capabilities).toEqual(expect.arrayContaining(['transactional']));
    expect(resend.pricingModel).toBe('free-tier');
    expect(resend.visibility).toBe('demo');
  });

  it('hides demo-visibility built-ins by default — public surface is empty when no tenant rows exist', async () => {
    const providers = await listProviders();
    const ids = providers.map((p) => p.id);
    expect(ids).not.toContain('neon');
    expect(ids).not.toContain('vercel');
    expect(ids).not.toContain('resend');
  });

  it('renders inputSchema as JSON Schema for each built-in', async () => {
    const providers = await listProviders({ includeDemo: true });
    const neon = providers.find((p) => p.id === 'neon')!;
    const schema = neon.inputSchema as { type?: string; properties?: Record<string, unknown> };
    expect(schema.type).toBe('object');
    expect(schema.properties).toHaveProperty('name');
  });
});
