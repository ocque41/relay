/**
 * /v1/auth/* — public + session routes for human sign-in.
 *
 * Endpoints:
 *   POST /v1/auth/email/start            public  → sends a 6-digit OTP
 *   POST /v1/auth/email/verify           public  → verifies OTP, issues session
 *   POST /v1/auth/logout                 session → destroys session
 *   POST /v1/auth/webauthn/register/options  session  → passkey registration options
 *   POST /v1/auth/webauthn/register/verify   session  → store the registered passkey
 *   POST /v1/auth/webauthn/login/options     public   → passkey authentication options
 *   POST /v1/auth/webauthn/login/verify      public   → verify + issue session
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { generateOtp, verifyOtp } from '../auth/email-otp';
import { sendOtpEmail } from '../auth/mailer';
import { destroySession, issueSession, sessionAuth, type SessionEnv } from '../auth/session';
import {
  beginAuthentication,
  beginRegistration,
  finishAuthentication,
  finishRegistration,
} from '../auth/webauthn';

const app = new OpenAPIHono<SessionEnv>();

const ErrorResponse = z.object({ error: z.string() });

// ---------------------------------------------------------------------------
// POST /v1/auth/email/start
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/auth/email/start',
    tags: ['auth'],
    summary: 'Send an email OTP',
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: z.object({ email: z.string().email() }) },
        },
      },
    },
    responses: {
      200: {
        description: 'OTP sent.',
        content: {
          'application/json': {
            schema: z.object({ ok: z.literal(true), expiresAt: z.string() }),
          },
        },
      },
      400: { description: 'Bad request.', content: { 'application/json': { schema: ErrorResponse } } },
      429: { description: 'Rate limit.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const { email } = c.req.valid('json');
    try {
      const { code, expiresAt } = await generateOtp(email, 'login');
      await sendOtpEmail(email, code);
      return c.json({ ok: true as const, expiresAt: expiresAt.toISOString() }, 200);
    } catch (e: unknown) {
      const kind = (e as { kind?: string }).kind;
      if (kind === 'rate_limit') return c.json({ error: 'too many OTPs for this email' }, 429);
      const msg = e instanceof Error ? e.message : 'unknown';
      console.error('[auth] email/start failed:', msg);
      return c.json({ error: 'failed to send email' }, 400);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /v1/auth/email/verify
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/auth/email/verify',
    tags: ['auth'],
    summary: 'Verify an email OTP and start a session',
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({ email: z.string().email(), code: z.string().regex(/^\d{6}$/) }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Session started.',
        content: {
          'application/json': {
            schema: z.object({
              userId: z.string().uuid(),
              email: z.string(),
              created: z.boolean(),
            }),
          },
        },
      },
      401: { description: 'Invalid OTP.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const { email, code } = c.req.valid('json');
    const result = await verifyOtp(email, code);
    if (!result.ok) return c.json({ error: result.reason }, 401);

    // Under the integrator-only revenue model, new users get no token grant.
    void result.created;

    await issueSession(c, result.userId, {
      ip: c.req.header('x-forwarded-for') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
    });

    return c.json(
      { userId: result.userId, email: result.email, created: result.created },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// POST /v1/auth/logout
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/auth/logout',
    tags: ['auth'],
    summary: 'Destroy the current session',
    description:
      'Destroys the session (DB row + cookie). Programmatic callers get JSON; browser form submits (Sec-Fetch-Dest: document, or Accept: text/html) get a 303 redirect to `/` so the user lands back on the logged-out home page instead of seeing the raw JSON body.',
    responses: {
      200: {
        description: 'Logged out (programmatic).',
        content: {
          'application/json': { schema: z.object({ ok: z.literal(true) }) },
        },
      },
      303: {
        description: 'Logged out (browser) — redirect to home.',
      },
    },
  }),
  async (c) => {
    await destroySession(c);

    // If a browser is doing a top-level form navigation, redirect to `/` so
    // the user doesn't end up staring at `{"ok":true}`. Detect via
    // `Sec-Fetch-Dest: document` (sent by all modern browsers on navigations)
    // and fall back to an `Accept: text/html` check for older clients.
    const dest = c.req.header('sec-fetch-dest');
    const accept = c.req.header('accept') ?? '';
    const isBrowserNav =
      dest === 'document' || (!!accept && accept.includes('text/html'));

    if (isBrowserNav) {
      return c.redirect('/', 303);
    }
    return c.json({ ok: true as const }, 200);
  },
);

// ---------------------------------------------------------------------------
// WebAuthn — unknown-schema bodies (validated by @simplewebauthn/server)
// ---------------------------------------------------------------------------
const WebAuthnOptions = z.record(z.string(), z.unknown());

// POST /v1/auth/webauthn/register/options  (session)
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/auth/webauthn/register/options',
    tags: ['auth', 'webauthn'],
    summary: 'Passkey registration options (requires session)',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    responses: {
      200: { description: 'Options.', content: { 'application/json': { schema: WebAuthnOptions } } },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: 'unauthorized' }, 401);
    const options = await beginRegistration(session.userId);
    return c.json(options as unknown as Record<string, unknown>, 200);
  },
);

// POST /v1/auth/webauthn/register/verify  (session)
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/auth/webauthn/register/verify',
    tags: ['auth', 'webauthn'],
    summary: 'Verify + store a registered passkey',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              response: z.record(z.string(), z.unknown()),
              name: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Passkey stored.',
        content: {
          'application/json': {
            schema: z.object({ ok: z.literal(true), passkeyId: z.string().uuid() }),
          },
        },
      },
      400: { description: 'Verification failed.', content: { 'application/json': { schema: ErrorResponse } } },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: 'unauthorized' }, 401);
    const { response, name } = c.req.valid('json');
    const result = await finishRegistration(
      session.userId,
      response as unknown as Parameters<typeof finishRegistration>[1],
      name,
    );
    if (!result.ok) return c.json({ error: result.reason }, 400);
    return c.json({ ok: true as const, passkeyId: result.passkeyId }, 200);
  },
);

// POST /v1/auth/webauthn/login/options  (public)
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/auth/webauthn/login/options',
    tags: ['auth', 'webauthn'],
    summary: 'Passkey authentication options',
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({ email: z.string().email().optional() }),
          },
        },
      },
    },
    responses: {
      200: { description: 'Options.', content: { 'application/json': { schema: WebAuthnOptions } } },
    },
  }),
  async (c) => {
    const { email } = c.req.valid('json');
    const options = await beginAuthentication(email);
    return c.json(options as unknown as Record<string, unknown>, 200);
  },
);

// POST /v1/auth/webauthn/login/verify  (public)
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/auth/webauthn/login/verify',
    tags: ['auth', 'webauthn'],
    summary: 'Verify passkey auth and start a session',
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              response: z.record(z.string(), z.unknown()),
              email: z.string().email().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Session started.',
        content: {
          'application/json': {
            schema: z.object({ userId: z.string().uuid(), email: z.string() }),
          },
        },
      },
      401: { description: 'Verification failed.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const { response, email } = c.req.valid('json');
    const result = await finishAuthentication(
      response as unknown as Parameters<typeof finishAuthentication>[0],
      email,
    );
    if (!result.ok) return c.json({ error: result.reason }, 401);
    await issueSession(c, result.userId, {
      ip: c.req.header('x-forwarded-for') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
    });
    return c.json({ userId: result.userId, email: result.email }, 200);
  },
);

export default app;
