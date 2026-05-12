/**
 * /v1/agents/bootstrap — agent-driven OTP bootstrap.
 *
 * Use case: a fresh AI agent lands at an integrator it has never visited.
 * No Relay bearer on disk, no Relay account for the human. The agent:
 *
 *   1. POST /v1/agents/bootstrap { email, tenantSlug }
 *      → Relay sends an OTP email to the human, returns a short-lived
 *        `challenge` (signed blob binding email + tenant).
 *   2. Human reads the email, pastes the code to the agent.
 *   3. POST /v1/agents/bootstrap/verify { challenge, code }
 *      → Relay verifies the OTP, creates the user (+ free-tier wallet) if
 *        new, mints a fresh agent token, reserves a stable external_user_id
 *        for (user, tenant). Returns { agentToken, externalUserId }.
 *
 * The challenge is a 15-min HS256 JWT over { email, tenantId } signed with
 * SESSION_SECRET. It keeps the endpoint stateless and prevents a caller from
 * swapping the tenant at verify time.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import { generateOtp, verifyOtp } from '../auth/email-otp';
import { sendOtpEmail } from '../auth/mailer';
import { mintAgentToken } from '../auth/mint-token';
import { db } from '../db/index';
import { tenants, user_external_identities } from '../db/schema';
import { recordAudit } from '../audit';

const app = new OpenAPIHono();
const ErrorResponse = z.object({ error: z.string() });

const CHALLENGE_TTL_SECONDS = 15 * 60;

function getChallengeSecret(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (!raw) throw new Error('SESSION_SECRET is not set');
  if (raw.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  return new TextEncoder().encode(raw);
}

async function signChallenge(payload: {
  email: string;
  tenantId: string;
}): Promise<string> {
  return new SignJWT({ e: payload.email, t: payload.tenantId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS)
    .sign(getChallengeSecret());
}

async function verifyChallenge(
  token: string,
): Promise<{ email: string; tenantId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getChallengeSecret());
    const email = typeof payload.e === 'string' ? payload.e : null;
    const tenantId = typeof payload.t === 'string' ? payload.t : null;
    if (!email || !tenantId) return null;
    return { email, tenantId };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /v1/agents/bootstrap — kick off OTP
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/agents/bootstrap',
    tags: ['integrator', 'auth'],
    summary: 'Start an agent bootstrap (sends OTP to email)',
    description:
      'No bearer required — used by a fresh agent that has never had a Relay ' +
      'token. Sends a 6-digit code to the email and returns a signed ' +
      'challenge to be echoed back on /verify along with the code.',
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              email: z.string().email(),
              tenantSlug: z.string().min(1).max(40),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'OTP sent.',
        content: {
          'application/json': {
            schema: z.object({
              challenge: z.string(),
              expiresAt: z.string().datetime(),
            }),
          },
        },
      },
      400: {
        description: 'Bad request / email send failed.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      404: {
        description: 'Unknown tenant slug.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      429: {
        description: 'Rate limit.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const { email, tenantSlug } = c.req.valid('json');

    const [tenant] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, tenantSlug))
      .limit(1);
    if (!tenant) return c.json({ error: 'tenant not found' }, 404);

    try {
      const { code, expiresAt } = await generateOtp(email, 'login');
      await sendOtpEmail(email, code);
      const challenge = await signChallenge({
        email: email.trim().toLowerCase(),
        tenantId: tenant.id,
      });
      return c.json(
        { challenge, expiresAt: expiresAt.toISOString() },
        200,
      );
    } catch (err: unknown) {
      const kind = (err as { kind?: string }).kind;
      if (kind === 'rate_limit') {
        return c.json({ error: 'too many OTPs for this email' }, 429);
      }
      const msg = err instanceof Error ? err.message : 'unknown';
      console.error('[bootstrap] failed:', msg);
      return c.json({ error: 'failed to send email' }, 400);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /v1/agents/bootstrap/verify — verify + mint agent token
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/agents/bootstrap/verify',
    tags: ['integrator', 'auth'],
    summary: 'Verify OTP and receive a fresh agent token',
    description:
      'Exchanges the challenge + OTP code for a Relay agent bearer token ' +
      '(plaintext, shown once) and the stable external_user_id the ' +
      'integrator should key its local user on. Auto-creates the Relay user ' +
      'on first verify and grants the free-tier token balance.',
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              challenge: z.string().min(10),
              code: z.string().regex(/^\d{6}$/),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Agent token + external user id.',
        content: {
          'application/json': {
            schema: z.object({
              agentToken: z
                .string()
                .describe('Plaintext bearer — shown ONCE. Store it on the agent.'),
              agentId: z.string().uuid(),
              externalUserId: z.string(),
              tenantId: z.string().uuid(),
              userId: z.string().uuid(),
              created: z.boolean(),
            }),
          },
        },
      },
      401: {
        description: 'Invalid challenge or code.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const { challenge, code } = c.req.valid('json');
    const claim = await verifyChallenge(challenge);
    if (!claim) return c.json({ error: 'invalid_challenge' }, 401);

    const result = await verifyOtp(claim.email, code);
    if (!result.ok) return c.json({ error: result.reason }, 401);

    // Reuse existing identity mapping if this user has previously attested
    // to this tenant; otherwise mint a fresh external_user_id.
    const [existingIdent] = await db
      .select({ external_user_id: user_external_identities.external_user_id })
      .from(user_external_identities)
      .where(
        and(
          eq(user_external_identities.user_id, result.userId),
          eq(user_external_identities.tenant_id, claim.tenantId),
        ),
      )
      .limit(1);

    const externalUserId = existingIdent?.external_user_id ?? randomUUID();
    if (!existingIdent) {
      await db.insert(user_external_identities).values({
        user_id: result.userId,
        tenant_id: claim.tenantId,
        external_user_id: externalUserId,
      });
    }

    // Mint a plain agent bearer (no integrator scope — this is the agent's
    // own Relay token; it uses it to call /v1/integrator/auth/attest later).
    // Default 30-day expiry via mintAgentToken — the bootstrap flow is the
    // exact scenario the default protects: a cold agent at an integrator.
    const minted = await mintAgentToken({
      userId: result.userId,
      label: 'agent-bootstrap',
      scopes: ['agent'],
    });

    await recordAudit(
      minted.agentId,
      'agent_bootstrap',
      claim.tenantId,
      {
        created: result.created,
        agent_id: minted.agentId,
        expires_at: minted.expiresAt ? minted.expiresAt.toISOString() : null,
      },
      { user_id: result.userId, tenant_id: claim.tenantId },
    );

    return c.json(
      {
        agentToken: minted.token,
        agentId: minted.agentId,
        agentTokenExpiresAt: minted.expiresAt
          ? minted.expiresAt.toISOString()
          : null,
        externalUserId,
        tenantId: claim.tenantId,
        userId: result.userId,
        created: result.created,
      },
      200,
    );
  },
);

export default app;
