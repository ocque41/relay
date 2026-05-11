/**
 * /v1/cli/* — device-code browser-handshake for `npx @relay/cli login`.
 *
 *   POST /v1/cli/start  {}                  → { device_code, authorize_url, poll_interval_ms, expires_at }
 *   GET  /v1/cli/poll?device_code=…          → { status: 'pending' } | { status: 'approved', agent_token, user }
 *
 * The approval step itself is a server action triggered from the Next.js
 * page at /cli-auth/[device_code]. That action mints an agent_token, stores
 * its plaintext in cli_auth_codes.agent_token_plaintext, and sets approved_at.
 *
 * Poll returns the plaintext once, then clears it + marks picked_up_at.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { randomBytes } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import { db } from '../db/index';
import { cli_auth_codes, users } from '../db/schema';

const app = new OpenAPIHono();

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const POLL_INTERVAL_MS = 2000;

function baseUrl(): string {
  return (
    process.env.APP_BASE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.replace(/^https?:\/\//, '')}`
      : 'http://localhost:3000')
  );
}

// ---------------------------------------------------------------------------
// POST /v1/cli/start
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/cli/start',
    tags: ['cli'],
    summary: 'Begin the CLI login handshake',
    responses: {
      200: {
        description: 'Device code created.',
        content: {
          'application/json': {
            schema: z.object({
              device_code: z.string(),
              authorize_url: z.string(),
              poll_interval_ms: z.number(),
              expires_at: z.string(),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    // Opportunistic cleanup of very old rows (fire-and-forget).
    await db.delete(cli_auth_codes).where(lt(cli_auth_codes.expires_at, new Date())).catch(() => {});

    const device_code = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await db.insert(cli_auth_codes).values({
      device_code,
      expires_at: expiresAt,
    });

    return c.json(
      {
        device_code,
        authorize_url: `${baseUrl()}/cli-auth/${device_code}`,
        poll_interval_ms: POLL_INTERVAL_MS,
        expires_at: expiresAt.toISOString(),
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// GET /v1/cli/poll?device_code=…
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/cli/poll',
    tags: ['cli'],
    summary: 'Poll for CLI login approval',
    request: {
      query: z.object({
        device_code: z.string(),
      }),
    },
    responses: {
      200: {
        description: 'Poll result — `pending`, `approved`, or `expired`/`unknown`.',
        content: {
          'application/json': {
            schema: z.union([
              z.object({ status: z.literal('pending') }),
              z.object({
                status: z.literal('approved'),
                agent_token: z.string(),
                user: z.object({
                  id: z.string().uuid(),
                  email: z.string(),
                  inbox_alias: z.string().nullable(),
                }),
              }),
              z.object({ status: z.literal('expired') }),
              z.object({ status: z.literal('unknown') }),
            ]),
          },
        },
      },
    },
  }),
  async (c) => {
    const { device_code } = c.req.valid('query');

    const [row] = await db
      .select()
      .from(cli_auth_codes)
      .where(eq(cli_auth_codes.device_code, device_code))
      .limit(1);

    if (!row) return c.json({ status: 'unknown' as const }, 200);

    if (row.expires_at.getTime() < Date.now()) {
      await db.delete(cli_auth_codes).where(eq(cli_auth_codes.id, row.id));
      return c.json({ status: 'expired' as const }, 200);
    }

    if (!row.approved_at || !row.agent_token_plaintext || !row.user_id) {
      return c.json({ status: 'pending' as const }, 200);
    }

    // First pickup — return plaintext, then scrub.
    const [u] = await db
      .select({ email: users.email, inbox_alias: users.inbox_alias })
      .from(users)
      .where(eq(users.id, row.user_id))
      .limit(1);

    const token = row.agent_token_plaintext;
    await db
      .update(cli_auth_codes)
      .set({ agent_token_plaintext: null, picked_up_at: new Date() })
      .where(eq(cli_auth_codes.id, row.id));

    return c.json(
      {
        status: 'approved' as const,
        agent_token: token,
        user: {
          id: row.user_id,
          email: u?.email ?? '',
          inbox_alias: u?.inbox_alias ?? null,
        },
      },
      200,
    );
  },
);

export default app;
