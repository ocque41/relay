/**
 * GET /v1/whoami — bearer-authenticated proof-of-sign-in.
 *
 * A cold AI agent that has just been handed a token needs one round-trip to
 * prove the token works without doing any destructive or side-effectful call
 * (like creating a signup). `whoami` is that round-trip.
 *
 * Response shape mirrors the MCP `whoami` tool so agents using either
 * transport get the same answer. No secrets, no credentials — only
 * identifiers already known to the caller.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { bearerAuth, type AppEnv } from '../auth';
import { readRateLimit } from '../rate-limit';
import { db } from '../db/index';
import { agents } from '../db/schema';

const app = new OpenAPIHono<AppEnv>();

const WhoamiResponse = z
  .object({
    agentId: z.string().uuid(),
    userId: z.string().uuid().nullable(),
    tenantId: z.string().uuid().nullable(),
    scopes: z.array(z.string()),
    label: z.string().nullable(),
    createdAt: z.string().nullable().openapi({
      description: 'ISO-8601 timestamp when the agent token was minted.',
    }),
  })
  .openapi('Whoami');

const whoamiRoute = createRoute({
  method: 'get',
  path: '/v1/whoami',
  tags: ['meta'],
  summary: 'Identify the caller',
  description:
    'Returns the agent, user, and tenant associated with the bearer token. ' +
    'Use this as a zero-side-effect proof that the token works.',
  security: [{ bearerAuth: [] }],
  middleware: [bearerAuth, readRateLimit] as const,
  responses: {
    200: {
      description: 'Authenticated agent profile.',
      content: { 'application/json': { schema: WhoamiResponse } },
    },
    401: {
      description: 'Missing or invalid bearer token.',
      content: {
        'application/json': { schema: z.object({ error: z.string() }) },
      },
    },
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

app.openapi(whoamiRoute, async (c) => {
  const agent = c.var.agent;

  const [row] = await db
    .select({
      label: agents.label,
      created_at: agents.created_at,
    })
    .from(agents)
    .where(eq(agents.id, agent.agentId))
    .limit(1);

  return c.json(
    {
      agentId: agent.agentId,
      userId: agent.userId,
      tenantId: agent.tenantId,
      scopes: agent.scopes,
      label: row?.label ?? null,
      createdAt: row?.created_at ? row.created_at.toISOString() : null,
    },
    200,
  );
});

export default app;
