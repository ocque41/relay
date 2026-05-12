/**
 * POST /v1/intent — goal-to-env resolver.
 *
 * One round-trip from a natural-language goal to either a paste-ready env
 * block of credentials the workspace already has, signup_job_ids to poll
 * for the gaps, or both. Relay owns the discovery + dedup + provider-pick
 * + env-naming decisions, with explicit escape hatches via `pin[]`.
 *
 * Determinism contract: same goal + same workspace + same point in time =>
 * byte-identical response. The parser is heuristic (no LLM), the selector
 * tie-breaks deterministically, and the env-block formatter sorts by
 * canonical category order.
 *
 * Concurrency contract: the Neon HTTP driver doesn't support session-bound
 * advisory locks (each query is a fresh HTTP request), so we layer two
 * dedup checks instead:
 *   1. Existing-account SELECT (catches sequential repeats).
 *   2. In-flight signup_jobs SELECT (catches concurrent intent calls that
 *      both miss the account check).
 * The accounts partial unique index (`accounts_workspace_provider_alias_active`)
 * is the catch-all when both checks miss and two workflows race — the loser
 * detects the unique violation, marks itself complete pointing to the dedup
 * winner's account, and refunds its quota slot. See workflows/signup.ts.
 *
 * Billing: intent itself is non-billable (parser + SELECTs are too cheap to
 * charge). Each spawned signup continues to bill its own integrator quota
 * slot via the existing kickSignup gate.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { bearerAuth, type AppEnv } from '../auth';
import { writeRateLimit } from '../rate-limit';
import { recordAudit } from '../audit';
import { db } from '../db/index';
import {
  agents as agentsTable,
  intent_resolutions,
  user_workspaces as userWorkspacesTable,
} from '../db/schema';
import { SUPPORTED_ENV_STYLES, type EnvStyle } from '../intent/env-block';
import { resolveIntent } from '../intent/resolve';

const app = new OpenAPIHono<AppEnv>();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const IntentPin = z.object({
  category: z.string().min(1),
  providerId: z.string().min(1),
  alias: z.string().min(1).max(64).optional(),
});

const IntentBody = z
  .object({
    goal: z.string().min(1).max(2000).openapi({
      example: 'Postgres + transactional email for a Next.js app',
      description: 'Natural-language description of what the workspace needs.',
    }),
    workspaceId: z.string().uuid().openapi({
      description:
        "REQUIRED. The user's workspace this resolution is scoped to — must " +
        "belong to the agent's user. Resolutions are deduped per (workspace, provider, alias).",
    }),
    envStyle: z
      .string()
      .default('raw')
      .openapi({
        description:
          'Format of the returned envBlock. v1 only supports "raw" — other styles are reserved and will 400.',
      }),
    pin: z
      .array(IntentPin)
      .max(20)
      .optional()
      .openapi({
        description:
          'Override the parser/selector for specific categories. Each pin becomes its own resolution slot; ' +
          'use `alias` to express multiple distinct accounts within the same provider.',
      }),
  })
  .openapi('IntentBody');

const IntentResolution = z.object({
  category: z.string(),
  alias: z.string().nullable(),
  provider: z.string().nullable(),
  status: z.enum(['existing', 'provisioning', 'ambiguous', 'no_provider']),
  accountId: z.string().uuid().optional(),
  signupJobId: z.string().uuid().optional(),
  pollUrl: z.string().optional(),
  envVar: z.string().optional(),
  value: z.string().nullable().optional(),
  revealUrl: z.string().optional(),
  candidates: z.array(z.string()).optional(),
});

const IntentResponse = z
  .object({
    resolutions: z.array(IntentResolution),
    envBlock: z.string(),
    pending: z.array(z.string().uuid()),
    unsatisfied: z.array(z.object({ category: z.string(), reason: z.string() })),
    unmatchedTerms: z.array(z.string()),
    revealAllUrl: z.string().nullable(),
    notes: z.array(z.string()),
  })
  .openapi('IntentResponse');

const ErrorResponse = z.object({ error: z.string() });

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
const routeDef = createRoute({
  method: 'post',
  path: '/v1/intent',
  tags: ['intent'],
  summary: 'Resolve a goal to an env block',
  description:
    'Parses a natural-language goal, dedups against existing accounts, and ' +
    'kicks signups for the gaps. Returns a paste-ready env block plus a list ' +
    'of signup_job_ids to poll for any provisioning still in flight. ' +
    'Always returns 200 — partial success (some categories provisioning, some ' +
    'with no provider) is the expected shape.',
  security: [{ bearerAuth: [] }],
  middleware: [bearerAuth, writeRateLimit] as const,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: IntentBody } },
    },
  },
  responses: {
    200: {
      description: 'Resolution payload (partial success is normal).',
      content: { 'application/json': { schema: IntentResponse } },
    },
    400: { description: 'Invalid body.', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
    404: {
      description: 'Workspace not found or not owned by this agent.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    429: {
      description: 'Rate limit exceeded.',
      content: {
        'application/json': {
          schema: z.object({ error: z.string(), retryAfter: z.number().optional() }),
        },
      },
    },
  },
});

app.openapi(routeDef, async (c) => {
  const body = c.req.valid('json') as {
    goal: string;
    workspaceId: string;
    envStyle: EnvStyle;
    pin?: Array<{ category: string; providerId: string; alias?: string }>;
  };

  if (!SUPPORTED_ENV_STYLES.includes(body.envStyle as EnvStyle)) {
    return c.json(
      {
        error: `unsupported envStyle "${body.envStyle}" — v1 supports: ${SUPPORTED_ENV_STYLES.join(', ')}`,
      },
      400,
    );
  }
  body.envStyle = body.envStyle as EnvStyle;

  const agent = c.get('agent');
  const callingAgentId = agent.agentId;

  const [agentRow] = await db
    .select({ user_id: agentsTable.user_id })
    .from(agentsTable)
    .where(eq(agentsTable.id, callingAgentId))
    .limit(1);
  const userId = agentRow?.user_id ?? null;
  if (!userId) {
    return c.json({ error: 'agent must be user-scoped to call /v1/intent' }, 401);
  }

  const [workspaceRow] = await db
    .select({ id: userWorkspacesTable.id })
    .from(userWorkspacesTable)
    .where(
      and(
        eq(userWorkspacesTable.id, body.workspaceId),
        eq(userWorkspacesTable.user_id, userId),
      ),
    )
    .limit(1);
  if (!workspaceRow) {
    return c.json({ error: 'workspace not found' }, 404);
  }

  const idempotencyKey =
    c.req.header('Idempotency-Key') ?? c.req.header('idempotency-key');
  if (idempotencyKey) {
    const [cached] = await db
      .select({
        response_json: intent_resolutions.response_json,
        expires_at: intent_resolutions.expires_at,
      })
      .from(intent_resolutions)
      .where(
        and(
          eq(intent_resolutions.agent_id, callingAgentId),
          eq(intent_resolutions.key, idempotencyKey),
        ),
      )
      .limit(1);
    const expiresAtDate =
      cached?.expires_at instanceof Date
        ? cached.expires_at
        : cached?.expires_at
          ? new Date(cached.expires_at as string)
          : null;
    if (cached && expiresAtDate && expiresAtDate > new Date()) {
      return c.json(
        cached.response_json as z.infer<typeof IntentResponse>,
        200,
      );
    }
  }

  const result = await resolveIntent({
    goal: body.goal,
    workspaceId: workspaceRow.id,
    envStyle: body.envStyle,
    pin: body.pin,
    callingAgentId,
    agentScopes: agent.scopes,
    userId,
  });

  const responseBody = {
    resolutions: result.resolutions,
    envBlock: result.envBlock,
    pending: result.pending,
    unsatisfied: result.unsatisfied,
    unmatchedTerms: result.unmatchedTerms,
    revealAllUrl: result.revealAllUrl,
    notes: result.notes,
  };

  if (idempotencyKey) {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db
      .insert(intent_resolutions)
      .values({
        agent_id: callingAgentId,
        key: idempotencyKey,
        response_json: responseBody,
        expires_at: expiresAt,
      })
      .onConflictDoUpdate({
        target: [intent_resolutions.agent_id, intent_resolutions.key],
        set: { response_json: responseBody, expires_at: expiresAt },
      });
  }

  await recordAudit(
    callingAgentId,
    'intent_resolve',
    null,
    {
      goal: body.goal,
      categories: result.parsedCategories,
      unmatched: result.unmatchedTerms,
      resolutions: result.resolutions.map((r) => ({
        category: r.category,
        alias: r.alias,
        provider: r.provider,
        status: r.status,
      })),
    },
    { user_id: userId, tenant_id: null },
  );

  return c.json(responseBody, 200);
});

export default app;
