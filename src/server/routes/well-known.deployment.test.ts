/**
 * Deployment-path test for the cold-agent bootstrap surface.
 *
 * The unit tests in well-known.test.ts and agents-manifest.test.ts exercise
 * the Hono router objects directly, which passes whether or not the Next App
 * Router has been wired to forward those paths. In production we found the
 * Hono routes existed but the live URLs 404'd because no app/<path>/route.ts
 * was forwarding to next-handler.
 *
 * This file imports each route.ts file the way Next imports it and invokes
 * the exported GET with a real Request. If the file is missing or the export
 * wiring is broken, this fails before the unit tests get a chance.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/index', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
  },
}));

vi.mock('../actions/validate', () => ({
  validateActionInput: () => ({ ok: true }),
}));

import { GET as wellKnownRelayGet } from '@/app/.well-known/relay.json/route';
import { GET as agentsMdGet } from '@/app/AGENTS.md/route';
import { GET as claudeMdGet } from '@/app/CLAUDE.md/route';
import { GET as llmsTxtGet } from '@/app/llms.txt/route';
import { GET as llmsFullTxtGet } from '@/app/llms-full.txt/route';

function reqFor(path: string): Request {
  return new Request(`https://relay.cumulush.com${path}`, { method: 'GET' });
}

describe('Cold-bootstrap deployment surface', () => {
  it('GET /.well-known/relay.json — 200 application/json with apiBase', async () => {
    const res = await wellKnownRelayGet(reqFor('/.well-known/relay.json'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
    const body = (await res.json()) as { apiBase: string; mcpEndpoint: string };
    expect(body.apiBase).toMatch(/^https?:\/\//);
    expect(body.mcpEndpoint).toMatch(/\/mcp$/);
  });

  it('GET /AGENTS.md — 200 text/markdown, non-empty', async () => {
    const res = await agentsMdGet(reqFor('/AGENTS.md'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/markdown/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it('GET /CLAUDE.md — 200 text/markdown, non-empty', async () => {
    const res = await claudeMdGet(reqFor('/CLAUDE.md'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/markdown/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it('GET /llms.txt — 200 text/plain, non-empty', async () => {
    const res = await llmsTxtGet(reqFor('/llms.txt'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/plain/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it('GET /llms-full.txt — 200 text/plain, non-empty', async () => {
    const res = await llmsFullTxtGet(reqFor('/llms-full.txt'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/plain/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });
});
