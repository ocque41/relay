import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { resumeHook } from 'workflow/api';
import { bearerAuth, type AppEnv } from '../auth';
import { readRateLimit, writeRateLimit } from '../rate-limit';
import { db } from '../db/index';
import { agents, signup_confirmations, signup_jobs } from '../db/schema';
import type { InboundEmail } from '../providers/types';
import { kickSignup } from '../signups/kick';
import { deliverSignupCredentialsOnce } from '../signups/handoff';

const app = new OpenAPIHono<AppEnv>();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const SignupCreateBody = z
  .object({
    provider: z.string().openapi({ example: 'neon' }),
    input: z.record(z.string(), z.unknown()).openapi({
      description: 'Provider-specific input object; see GET /v1/providers for its schema.',
    }),
  })
  .openapi('SignupCreateBody');

const SignupCreateResponse = z
  .object({
    signup_id: z.string().uuid(),
    status: z.literal('pending'),
  })
  .openapi('SignupCreateResponse');

const SignupStatusResponse = z
  .object({
    signup_id: z.string().uuid(),
    status: z.string().openapi({
      example: 'completed',
      description: "'pending' | 'awaiting_email' | 'completed' | 'failed'",
    }),
    error: z.string().optional(),
    account_id: z.string().uuid().optional(),
    /**
     * Initial plaintext API key returned from the provider. Included EXACTLY
     * ONCE on the first status read that observes `status==='complete'`.
     * Relay clears the column on delivery — subsequent reads will omit it.
     * Agents must hand this to the end-user in their chat session; Relay does
     * not retain a copy.
     */
    initial_api_key: z.string().optional(),
    initial_credentials: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('SignupStatusResponse');

const ErrorResponse = z.object({ error: z.string() });

// ---------------------------------------------------------------------------
// POST /v1/signups
// ---------------------------------------------------------------------------
const createRouteDef = createRoute({
  method: 'post',
  path: '/v1/signups',
  tags: ['signups'],
  summary: 'Start a signup',
  description:
    'Starts a durable workflow that provisions a new account on the named provider. Returns immediately; poll GET /v1/signups/:id for the result.',
  security: [{ bearerAuth: [] }],
  middleware: [bearerAuth, writeRateLimit] as const,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: SignupCreateBody } },
    },
  },
  responses: {
    202: {
      description: 'Signup started.',
      content: { 'application/json': { schema: SignupCreateResponse } },
    },
    400: { description: 'Invalid body.', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Provider not found.', content: { 'application/json': { schema: ErrorResponse } } },
    429: {
      description: 'Rate limit exceeded or integrator signup quota exhausted.',
      content: {
        'application/json': {
          schema: z.object({ error: z.string(), retryAfter: z.number().optional() }),
        },
      },
    },
    503: {
      description: "Integrator's Relay subscription is inactive; their product is temporarily unavailable.",
      content: { 'application/json': { schema: ErrorResponse } },
    },
    502: { description: 'Workflow failed to start.', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

app.openapi(createRouteDef, async (c) => {
  const body = c.req.valid('json') as { provider: string; input: unknown };

  const agent = c.get('agent');
  const callingAgentId = agent.agentId;

  // Resolve workspace from the agent pin, with a fallback to the user's
  // currently-active workspace so the row still belongs somewhere specific.
  const [agentRow] = await db
    .select({
      user_id: agents.user_id,
      user_workspace_id: agents.user_workspace_id,
    })
    .from(agents)
    .where(eq(agents.id, callingAgentId))
    .limit(1);
  const userId = agentRow?.user_id ?? null;
  let userWorkspaceId: string | null = agentRow?.user_workspace_id ?? null;
  if (userId && !userWorkspaceId) {
    const { resolveActiveUserWorkspace } = await import('../user-workspaces');
    userWorkspaceId = (await resolveActiveUserWorkspace(userId)).id;
  }

  const result = await kickSignup({
    provider: body.provider,
    input: body.input,
    callingAgentId,
    agentScopes: agent.scopes,
    userId,
    userWorkspaceId,
  });

  if (!result.ok) {
    return c.json(result.body, result.status);
  }

  return c.json({ signup_id: result.signupJobId, status: 'pending' as const }, 202);
});

// ---------------------------------------------------------------------------
// GET /v1/signups/:id
// ---------------------------------------------------------------------------
const statusRouteDef = createRoute({
  method: 'get',
  path: '/v1/signups/{id}',
  tags: ['signups'],
  summary: 'Poll signup status',
  security: [{ bearerAuth: [] }],
  middleware: [bearerAuth, readRateLimit] as const,
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
    }),
  },
  responses: {
    200: {
      description: 'Current signup job state.',
      content: { 'application/json': { schema: SignupStatusResponse } },
    },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found.', content: { 'application/json': { schema: ErrorResponse } } },
    429: {
      description: 'Rate limit exceeded.',
      content: {
        'application/json': {
          schema: z.object({ error: z.string(), retryAfter: z.number() }),
        },
      },
    },
  },
});

app.openapi(statusRouteDef, async (c) => {
  const { id } = c.req.valid('param');
  const callingAgentId = c.get('agent').agentId;

  const [job] = await db
    .select()
    .from(signup_jobs)
    .where(eq(signup_jobs.id, id))
    .limit(1);

  if (!job) {
    return c.json({ error: 'signup job not found' }, 404);
  }

  // Authorization: only the agent that initiated the signup — or another
  // agent owned by the same user — may read it. This prevents one user's
  // agents from seeing another user's signups.
  const [agentRow] = await db
    .select({ user_id: agents.user_id })
    .from(agents)
    .where(eq(agents.id, callingAgentId))
    .limit(1);
  const callerUserId = agentRow?.user_id ?? null;
  if (job.user_id && callerUserId !== job.user_id) {
    return c.json({ error: 'signup job not found' }, 404);
  }

  // Deliver-once: on first observation of status='complete' with a pending
  // credential buffer, hand the plaintext to the calling agent and scrub the
  // column. Subsequent reads return the same row minus the key.
  let initialApiKey: string | undefined;
  let initialCredentials: Record<string, unknown> | undefined;
  if (
    job.status === 'complete' &&
    job.pending_credentials_enc &&
    !job.credentials_delivered_at &&
    callerUserId === job.user_id
  ) {
    try {
      const delivered = await deliverSignupCredentialsOnce({
        job,
        callingAgentId,
        callerUserId,
        via: 'rest',
      });
      initialApiKey = delivered.initialApiKey;
      initialCredentials = delivered.initialCredentials;
    } catch (err) {
      console.error('[signups.status] failed to deliver pending credentials:', err);
    }
  }

  return c.json(
    {
      signup_id: job.id,
      status: job.status,
      ...(job.error != null ? { error: job.error } : {}),
      ...(job.account_id != null ? { account_id: job.account_id } : {}),
      ...(initialApiKey !== undefined ? { initial_api_key: initialApiKey } : {}),
      ...(initialCredentials !== undefined ? { initial_credentials: initialCredentials } : {}),
    },
    200,
  );
});

// ---------------------------------------------------------------------------
// GET /v1/signups/:id/confirm/:token — end-user confirmation link
//
// Public endpoint (no bearer/session auth — the unguessable token IS the
// proof of consent). When a tenant provider has needs_email_verification=true,
// Relay sends the user a confirmation email containing this URL. Clicking it
// marks the signup_confirmations row confirmed and resumes the suspended
// WDK workflow so it can dispatch the integrator webhook.
// ---------------------------------------------------------------------------
const confirmRouteDef = createRoute({
  method: 'get',
  path: '/v1/signups/{id}/confirm/{token}',
  tags: ['signups'],
  summary: 'Confirm an agent-initiated signup (end-user clicks link from email)',
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
      token: z.string().min(16).openapi({ param: { name: 'token', in: 'path' } }),
    }),
  },
  responses: {
    200: {
      description: 'Confirmation page (HTML).',
      content: { 'text/html': { schema: z.string() } },
    },
    404: {
      description: 'Unknown or malformed confirmation.',
      content: { 'text/html': { schema: z.string() } },
    },
    410: {
      description: 'Link expired.',
      content: { 'text/html': { schema: z.string() } },
    },
  },
});

function htmlPage(title: string, bodyHtml: string, status: 200 | 404 | 410): Response {
  const html =
    `<!DOCTYPE html><html lang="en"><head>` +
    `<meta charset="utf-8"/><title>${title} — Relay</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"/>` +
    `<style>body{font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:540px;margin:80px auto;padding:0 24px;color:#0a0a0a}` +
    `h1{font-size:24px;margin-bottom:8px}p{color:#444;line-height:1.5}.muted{color:#888;font-size:13px;margin-top:32px}</style>` +
    `</head><body>${bodyHtml}<p class="muted">Relay</p></body></html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

app.openapi(confirmRouteDef, async (c) => {
  const { id, token } = c.req.valid('param');
  const now = new Date();

  const rows = await db
    .select()
    .from(signup_confirmations)
    .where(
      and(
        eq(signup_confirmations.signup_job_id, id),
        eq(signup_confirmations.token, token),
      ),
    )
    .limit(1);
  const conf = rows[0];

  if (!conf) {
    return htmlPage(
      'Invalid link',
      `<h1>Invalid link</h1><p>This confirmation link is not valid. It may have been revoked or mistyped.</p>`,
      404,
    );
  }

  if (conf.confirmed_at) {
    return htmlPage(
      'Already confirmed',
      `<h1>Already confirmed</h1><p>This signup was already confirmed. You can close this window and return to your agent.</p>`,
      200,
    );
  }

  if (conf.expires_at.getTime() < now.getTime()) {
    return htmlPage(
      'Link expired',
      `<h1>Link expired</h1><p>This confirmation link has expired. Ask your agent to start a new signup.</p>`,
      410,
    );
  }

  // Mark confirmed first so repeated clicks are idempotent.
  await db
    .update(signup_confirmations)
    .set({ confirmed_at: now })
    .where(eq(signup_confirmations.id, conf.id));

  // Signal the suspended workflow. We pass a synthetic InboundEmail — the
  // tenant provider's handleVerificationEmail ignores its contents; it just
  // needs the resume signal.
  const syntheticInbound: InboundEmail = {
    to: conf.email,
    from: 'confirmation@relay.dev',
    subject: `Confirmed via Relay`,
    bodyText: 'CONFIRMED_VIA_RELAY_LINK',
    headers: {},
  };
  try {
    await resumeHook<InboundEmail>(id, syntheticInbound);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[signups.confirm] resumeHook failed:', msg);
    // Workflow may have already completed or timed out; page still shows
    // success because the user's side of the contract is done.
  }

  return htmlPage(
    'Signup confirmed',
    `<h1>Signup confirmed.</h1><p>You can close this window and return to your agent.</p>`,
    200,
  );
});

export default app;
