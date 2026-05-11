/**
 * /v1/agent-guide (bearer) + /v1/me/agent-guide (session)
 *
 * Per-user free-form markdown that a user's AI agents read at session start.
 * Editable from the dashboard (session endpoints) and read/writable by the
 * user's own agents (bearer endpoints). Last-write-wins — no versioning in v1.
 *
 * The stored body is capped at 64 KiB at the route layer. Audit rows record
 * byte counts only; the content itself is NEVER written to audit metadata, so
 * audit_log cannot become a shadow store.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { bearerAuth, type AppEnv } from '../auth';
import { sessionAuth, type SessionEnv } from '../auth/session';
import { callerUserId } from '../auth/caller';
import { readRateLimit, writeRateLimit } from '../rate-limit';
import { recordAudit } from '../audit';
import { db } from '../db/index';
import { users } from '../db/schema';

const MAX_GUIDE_BYTES = 64 * 1024;

const ErrorResponse = z.object({ error: z.string() });
const RateLimitResponse = z.object({ error: z.string(), retryAfter: z.number() });

const AgentGuide = z
  .object({
    content: z.string().openapi({
      description:
        'Free-form markdown body. Empty string when the user has never set a guide.',
    }),
    updated_at: z.string().nullable().openapi({
      description: 'ISO timestamp of the last PUT. Null if never set.',
    }),
    bytes: z.number().int().nonnegative().openapi({
      description: 'UTF-8 byte length of `content`. Max 64 KiB (65536 bytes).',
    }),
  })
  .openapi('AgentGuide');

const AgentGuideWriteBody = z
  .object({
    content: z.string().openapi({
      description:
        'New markdown body (UTF-8). Must be <= 64 KiB or the server returns 413.',
    }),
  })
  .openapi('AgentGuideWriteBody');

const AgentGuideWriteResponse = z
  .object({
    updated_at: z.string(),
    bytes: z.number().int().nonnegative(),
  })
  .openapi('AgentGuideWriteResponse');

function bytesOf(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

async function readGuide(userId: string): Promise<{ content: string; updated_at: string | null; bytes: number }> {
  const [row] = await db
    .select({
      agent_guide: users.agent_guide,
      agent_guide_updated_at: users.agent_guide_updated_at,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const content = row?.agent_guide ?? '';
  return {
    content,
    updated_at: row?.agent_guide_updated_at
      ? new Date(row.agent_guide_updated_at).toISOString()
      : null,
    bytes: bytesOf(content),
  };
}

async function writeGuide(
  userId: string,
  content: string,
): Promise<{ updated_at: string; bytes: number }> {
  const now = new Date();
  await db
    .update(users)
    .set({ agent_guide: content, agent_guide_updated_at: now })
    .where(eq(users.id, userId));
  return { updated_at: now.toISOString(), bytes: bytesOf(content) };
}

// ---------------------------------------------------------------------------
// Bearer-auth surface: used by the user's own AI agents (CLI, MCP, scripts).
// ---------------------------------------------------------------------------
const bearerApp = new OpenAPIHono<AppEnv>();

bearerApp.openapi(
  createRoute({
    method: 'get',
    path: '/v1/agent-guide',
    tags: ['agent-guide'],
    summary: 'Read the caller-user agent guide',
    description:
      "Returns the markdown body the user stores for their AI agents. Agents should fetch this at session start so they inherit the user's preferences and defaults.",
    security: [{ bearerAuth: [] }],
    middleware: [bearerAuth, readRateLimit] as const,
    responses: {
      200: {
        description: 'The agent guide for the caller-user.',
        content: { 'application/json': { schema: AgentGuide } },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      429: { description: 'Rate limit exceeded.', content: { 'application/json': { schema: RateLimitResponse } } },
    },
  }),
  async (c) => {
    const uid = await callerUserId(c.get('agent').agentId);
    if (!uid) return c.json({ error: 'agent_token is not associated with a user' }, 401);
    const guide = await readGuide(uid);
    return c.json(guide, 200);
  },
);

bearerApp.openapi(
  createRoute({
    method: 'put',
    path: '/v1/agent-guide',
    tags: ['agent-guide'],
    summary: 'Replace the caller-user agent guide',
    description:
      "Replaces the entire guide. Last-write-wins; no versioning. Convention: agents propose edits in chat and PUT only after the user approves — Relay does not enforce this in code.",
    security: [{ bearerAuth: [] }],
    middleware: [bearerAuth, writeRateLimit] as const,
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: AgentGuideWriteBody } },
      },
    },
    responses: {
      200: {
        description: 'Guide replaced.',
        content: { 'application/json': { schema: AgentGuideWriteResponse } },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      413: {
        description: 'Body exceeds 64 KiB cap.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      429: { description: 'Rate limit exceeded.', content: { 'application/json': { schema: RateLimitResponse } } },
    },
  }),
  async (c) => {
    const agentId = c.get('agent').agentId;
    const uid = await callerUserId(agentId);
    if (!uid) return c.json({ error: 'agent_token is not associated with a user' }, 401);

    const body = c.req.valid('json');
    const bytes = bytesOf(body.content);
    if (bytes > MAX_GUIDE_BYTES) {
      return c.json(
        { error: `agent_guide body is ${bytes} bytes; max is ${MAX_GUIDE_BYTES} bytes (64 KiB)` },
        413,
      );
    }

    const result = await writeGuide(uid, body.content);
    await recordAudit(
      agentId,
      'agent_guide_update',
      uid,
      { bytes: result.bytes, source: 'bearer' },
      { user_id: uid },
    );
    return c.json(result, 200);
  },
);

// ---------------------------------------------------------------------------
// Session-auth surface: used by the dashboard editor.
// ---------------------------------------------------------------------------
const sessionApp = new OpenAPIHono<SessionEnv>();

sessionApp.openapi(
  createRoute({
    method: 'get',
    path: '/v1/me/agent-guide',
    tags: ['me', 'agent-guide'],
    summary: 'Read my agent guide (dashboard)',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    responses: {
      200: { description: 'Guide.', content: { 'application/json': { schema: AgentGuide } } },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const guide = await readGuide(session.userId);
    return c.json(guide, 200);
  },
);

sessionApp.openapi(
  createRoute({
    method: 'put',
    path: '/v1/me/agent-guide',
    tags: ['me', 'agent-guide'],
    summary: 'Replace my agent guide (dashboard)',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: AgentGuideWriteBody } },
      },
    },
    responses: {
      200: {
        description: 'Guide replaced.',
        content: { 'application/json': { schema: AgentGuideWriteResponse } },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      413: {
        description: 'Body exceeds 64 KiB cap.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const body = c.req.valid('json');
    const bytes = bytesOf(body.content);
    if (bytes > MAX_GUIDE_BYTES) {
      return c.json(
        { error: `agent_guide body is ${bytes} bytes; max is ${MAX_GUIDE_BYTES} bytes (64 KiB)` },
        413,
      );
    }

    const result = await writeGuide(session.userId, body.content);
    await recordAudit(
      null,
      'agent_guide_update',
      session.userId,
      { bytes: result.bytes, source: 'session' },
      { user_id: session.userId },
    );
    return c.json(result, 200);
  },
);

export { bearerApp as agentGuideBearerRouter, sessionApp as agentGuideSessionRouter };
export { MAX_GUIDE_BYTES };
