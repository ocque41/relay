/**
 * Unauthenticated discovery endpoint for cold AI agents.
 *
 * A fresh agent given only a bearer token needs one public URL to answer:
 *   "what's the API base? where's the MCP endpoint? where are the docs?"
 *
 * This handler is the answer. It is NOT behind bearerAuth — any caller can
 * reach it with a single GET, read the JSON, and bootstrap from there.
 *
 * Shape is intentionally flat and stable; treat additions as additive. The
 * `apiBase` is derived from APP_BASE_URL → VERCEL_PROJECT_PRODUCTION_URL →
 * localhost, matching the same resolution used by the tenant provider.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../auth';

const app = new Hono<AppEnv>();

function apiBaseUrl(): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  const prodHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prodHost) return `https://${prodHost.replace(/^https?:\/\//, '')}`;
  return 'http://localhost:3000';
}

const VERSION = '1.0.0';

app.get('/.well-known/relay.json', (c) => {
  const base = apiBaseUrl();
  return c.json(
    {
      apiBase: base,
      mcpEndpoint: `${base}/mcp`,
      openapiUrl: `${base}/openapi.json`,
      docsUrl: `${base}/docs`,
      agentDocsUrl: `${base}/docs/agent-builders`,
      version: VERSION,
      authScheme: 'Bearer agt_<token>',
    },
    200,
    {
      'Cache-Control': 'public, max-age=300',
    },
  );
});

export default app;
