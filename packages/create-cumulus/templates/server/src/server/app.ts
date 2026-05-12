import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from './auth';
import providersRouter from './routes/providers';
import indexCatalogRouter from './routes/index-catalog';
import signupsRouter from './routes/signups';
import intentRouter from './routes/intent';
import accountsRouter from './routes/accounts';
import apiKeysRouter from './routes/api-keys';
import emailWebhookRouter from './routes/email-webhook';
import authRouter from './routes/auth';
import billingRouter from './routes/billing';
import meRouter from './routes/me';
import meAccountsRouter from './routes/me-accounts';
import { agentGuideBearerRouter, agentGuideSessionRouter } from './routes/agent-guide';
import agentsManifestRouter from './routes/agents-manifest';
import userRouter from './routes/user';
import userWorkspacesRouter from './routes/user-workspaces';
import devRouter from './routes/dev';
import sessionRouter from './routes/session';
import cliRouter from './routes/cli';
import cronRouter from './routes/cron';
import tenantsRouter from './routes/tenants';
import integratorAuthRouter from './routes/integrator-auth';
import integratorActionsRouter from './routes/integrator-actions';
import actionsRouter from './routes/actions';
import bootstrapRouter from './routes/bootstrap';
import adminRouter from './routes/admin';
import wellKnownRouter from './routes/well-known';
import whoamiRouter from './routes/whoami';
import activationsRouter from './routes/activations';
import checkoutRouter from './routes/checkout';
import { SESSION_COOKIE } from './auth/session';
import { getJwks } from './auth/attest';
import { handleMcpRequest } from '../mcp/server';
import { logger } from './logger';
import { Sentry } from './sentry';

const app = new OpenAPIHono<AppEnv>();

// ---------------------------------------------------------------------------
// Request logging + error capture. Structured JSON via pino; unhandled errors
// reported to Sentry when SENTRY_DSN is configured. Runs first so every
// downstream handler is covered.
// ---------------------------------------------------------------------------
app.use('*', async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  try {
    await next();
    const duration_ms = Date.now() - start;
    logger.info(
      { method, path, status: c.res.status, duration_ms },
      'req',
    );
  } catch (err) {
    const duration_ms = Date.now() - start;
    logger.error(
      { method, path, duration_ms, err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err },
      'req_error',
    );
    Sentry.captureException(err);
    throw err;
  }
});

// ---------------------------------------------------------------------------
// OpenAPI security schemes
// ---------------------------------------------------------------------------
app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'agt_<base64url>',
  description:
    'Agent bearer token minted via POST /v1/me/agent-tokens (or scripts/seed-agent-token.ts). Only the SHA-256 hash is stored server-side.',
});
app.openAPIRegistry.registerComponent('securitySchemes', 'cookieAuth', {
  type: 'apiKey',
  in: 'cookie',
  name: SESSION_COOKIE,
  description: 'HttpOnly session cookie issued after email OTP or passkey login.',
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/health',
    tags: ['meta'],
    summary: 'Liveness probe',
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': {
            schema: z.object({ status: z.literal('ok'), version: z.string() }),
          },
        },
      },
    },
  }),
  (c) => c.json({ status: 'ok' as const, version: '1.0.0' }, 200),
);

// ---------------------------------------------------------------------------
// Feature routers (each one is an OpenAPIHono with createRoute-registered paths)
// ---------------------------------------------------------------------------
app.route('/', authRouter);        // POST /v1/auth/email/*, /v1/auth/webauthn/*, /v1/auth/logout
app.route('/', sessionRouter);     // GET  /v1/session, POST /v1/session/workspace
app.route('/', userRouter);        // end-user workspace: /v1/user/*
app.route('/', userWorkspacesRouter); // /v1/user/workspaces[/:id][/switch|/rename]
app.route('/', devRouter);         // developer workspace: /v1/dev/*
app.route('/', meRouter);          // legacy: /v1/me, /v1/me/agent-tokens, /v1/me/tenants[/*] — kept for one release
app.route('/', meAccountsRouter);  // session: /v1/me/accounts[/:id][/api-keys[/:keyId/rotate]]
app.route('/', agentGuideBearerRouter);  // bearer: /v1/agent-guide (GET, PUT)
app.route('/', agentGuideSessionRouter); // session: /v1/me/agent-guide (GET, PUT)
app.route('/', cliRouter);         // POST /v1/cli/start, GET /v1/cli/poll
app.route('/', cronRouter);        // POST /v1/cron/gc (scheduled by vercel.ts)
app.route('/', tenantsRouter);     // POST /v1/tenants (drop-in integrator self-serve)
app.route('/', integratorAuthRouter);    // POST /v1/integrator/auth/attest
app.route('/', integratorActionsRouter); // /v1/integrator/actions*
app.route('/', actionsRouter);           // /v1/tenants/:slug/actions + /v1/actions/execute
app.route('/', bootstrapRouter);         // POST /v1/agents/bootstrap[/verify] (no auth)
app.route('/', adminRouter);             // POST /v1/admin/users/:id/raise-limit (scope=admin)
app.route('/', providersRouter);   // GET  /v1/providers
app.route('/', indexCatalogRouter); // GET  /v1/index[/:category] — chunked discovery
app.route('/', signupsRouter);     // POST/GET /v1/signups[/:id]
app.route('/', intentRouter);      // POST /v1/intent — goal-to-env resolver
app.route('/', accountsRouter);    // GET/DELETE /v1/accounts[/:id], GET /v1/audit-log
app.route('/', apiKeysRouter);     // GET/POST /v1/accounts/:id/api-keys[/:keyId/reveal]
app.route('/', billingRouter);     // /v1/user/billing/*, /v1/dev/billing/*, POST /v1/webhooks/stripe
app.route('/', activationsRouter); // POST /v1/activations — integrator-reported activation events
app.route('/', checkoutRouter);    // POST /v1/checkout/founding-partner-sprint — Stripe Checkout Session
app.route('/', whoamiRouter);      // GET  /v1/whoami (bearer-auth, cold-agent proof-of-sign-in)
app.route('/', wellKnownRouter);   // GET  /.well-known/relay.json (unauthenticated discovery)
app.route('/', agentsManifestRouter); // GET /AGENTS.md, /CLAUDE.md, /llms.txt, /llms-full.txt (unauthenticated)

// ---------------------------------------------------------------------------
// Inbound email webhook (HMAC-auth, NOT bearerAuth)
// ---------------------------------------------------------------------------
app.route('/', emailWebhookRouter); // POST /v1/webhooks/email

// ---------------------------------------------------------------------------
// JWKS — public keys integrators use to verify attestation JWTs. Fully public
// (contains no private material); integrators cache for ~1h and re-fetch on
// unknown `kid`. Served off Relay's primary domain so the JWT `iss` URL
// resolves to the same origin.
// ---------------------------------------------------------------------------
app.get('/.well-known/jwks.json', async (c) => {
  try {
    const jwks = await getJwks();
    return c.json(jwks, 200, {
      'Cache-Control': 'public, max-age=3600',
    });
  } catch (err) {
    console.error('[jwks] failed to load key material:', err);
    return c.json({ error: 'jwks_unavailable' }, 503);
  }
});

// ---------------------------------------------------------------------------
// MCP server (Streamable HTTP transport, stateless)
// ---------------------------------------------------------------------------
app.all('/mcp', (c) => handleMcpRequest(c.req.raw));

// ---------------------------------------------------------------------------
// OpenAPI spec — auto-generated from every createRoute registration above.
// `servers` is populated from APP_BASE_URL → VERCEL_PROJECT_PRODUCTION_URL
// so cold agents reading `/openapi.json` immediately see the canonical URL
// without needing any out-of-band configuration.
// ---------------------------------------------------------------------------
function openapiServerUrl(): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  const prodHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prodHost) return `https://${prodHost.replace(/^https?:\/\//, '')}`;
  return 'http://localhost:3000';
}

app.doc('/openapi.json', {
  openapi: '3.1.0',
  info: {
    title: 'Agent-Callable Signup API',
    version: '1.0.0',
    description:
      'HTTP API for AI agents to provision accounts on third-party services ' +
      'and retrieve API keys. Every sensitive operation is audit-logged and ' +
      'rate-limited per agent token.',
  },
  servers: [
    {
      url: openapiServerUrl(),
      description: 'Relay API (resolved from APP_BASE_URL or Vercel production host)',
    },
  ],
});

// ---------------------------------------------------------------------------
// Swagger UI at /docs/api (served via CDN, zero dependencies on the server).
// The /docs root + /docs/developer + /docs/user are Next.js pages.
// ---------------------------------------------------------------------------
app.get('/docs/api', (c) =>
  c.html(
    `<!DOCTYPE html>
<html>
<head>
  <title>Relay API — OpenAPI reference</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"/>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.addEventListener('load', () => {
      SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui' });
    });
  </script>
</body>
</html>`,
  ),
);

export default app;
