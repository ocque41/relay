/**
 * /v1/integrator/actions — Actions API registration surface.
 *
 * Integrator servers call these with their pinned integrator key to register,
 * list, update, and retire the actions their agents can invoke via
 * /v1/actions/execute. Each action carries its own HMAC webhook secret
 * (plaintext returned ONCE on create) which Relay uses to sign every
 * outbound dispatch.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { requireIntegratorKey, type AppEnv } from '../auth';
import { encrypt } from '../crypto';
import { db } from '../db/index';
import { actions } from '../db/schema';
import { recordAudit } from '../audit';

const app = new OpenAPIHono<AppEnv>();
const ErrorResponse = z.object({ error: z.string() });

const SLUG = z.string().regex(/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/).min(2).max(64);

const ActionBodyRequired = z.object({
  slug: SLUG,
  display_name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  endpoint_url: z.string().url().max(2048),
  endpoint_method: z.enum(['POST', 'PUT', 'PATCH']).optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  timeout_ms: z.number().int().min(1000).max(60_000).optional(),
  visibility: z.enum(['public', 'private']).optional(),
});

const ActionBodyPatch = z.object({
  display_name: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).nullable().optional(),
  endpoint_url: z.string().url().max(2048).optional(),
  endpoint_method: z.enum(['POST', 'PUT', 'PATCH']).optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  timeout_ms: z.number().int().min(1000).max(60_000).optional(),
  visibility: z.enum(['public', 'private']).optional(),
  disabled: z.boolean().optional(),
});

const ActionPublic = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  display_name: z.string(),
  description: z.string().nullable(),
  endpoint_url: z.string(),
  endpoint_method: z.string(),
  input_schema: z.record(z.string(), z.unknown()),
  output_schema: z.record(z.string(), z.unknown()),
  timeout_ms: z.number(),
  visibility: z.string(),
  disabled_at: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

function generateWebhookSecret(): string {
  // 32 random bytes, base64url — plenty of HMAC entropy. Shown once.
  return 'whsec_' + randomBytes(32).toString('base64url');
}

function toPublic(row: typeof actions.$inferSelect) {
  return {
    id: row.id,
    slug: row.slug,
    display_name: row.display_name,
    description: row.description,
    endpoint_url: row.endpoint_url,
    endpoint_method: row.endpoint_method,
    input_schema: (row.input_schema as Record<string, unknown>) ?? {},
    output_schema: (row.output_schema as Record<string, unknown>) ?? {},
    timeout_ms: row.timeout_ms,
    visibility: row.visibility,
    disabled_at: row.disabled_at ? row.disabled_at.toISOString() : null,
    created_at: row.created_at ? row.created_at.toISOString() : null,
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// POST /v1/integrator/actions — create (or upsert with ?overwrite=true)
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/integrator/actions',
    tags: ['integrator', 'actions'],
    summary: 'Register a new action (or overwrite an existing one)',
    description:
      'Creates an action for the calling tenant. Returns the plaintext HMAC webhook secret ONCE — store it on the integrator\'s server immediately.',
    security: [{ bearerAuth: [] }],
    middleware: [requireIntegratorKey] as const,
    request: {
      query: z.object({
        overwrite: z.enum(['true', 'false']).optional().openapi({ param: { in: 'query' } }),
      }),
      body: {
        required: true,
        content: { 'application/json': { schema: ActionBodyRequired } },
      },
    },
    responses: {
      201: {
        description: 'Created.',
        content: {
          'application/json': {
            schema: z.object({
              action: ActionPublic,
              webhook_secret: z.string().describe('Plaintext — shown once.'),
            }),
          },
        },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      403: { description: 'Forbidden.', content: { 'application/json': { schema: ErrorResponse } } },
      409: {
        description: 'Slug taken (and ?overwrite=true was not set).',
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const agent = c.get('agent');
    const tenantId = agent.tenantId!;
    const { overwrite } = c.req.valid('query');
    const body = c.req.valid('json');

    const [existing] = await db
      .select({ id: actions.id })
      .from(actions)
      .where(and(eq(actions.tenant_id, tenantId), eq(actions.slug, body.slug)))
      .limit(1);

    if (existing && overwrite !== 'true') {
      return c.json({ error: 'action_slug_taken' }, 409);
    }

    const plaintext = generateWebhookSecret();
    const enc = encrypt(Buffer.from(plaintext, 'utf8'));

    let row: typeof actions.$inferSelect;
    if (existing) {
      const [updated] = await db
        .update(actions)
        .set({
          display_name: body.display_name,
          description: body.description ?? null,
          endpoint_url: body.endpoint_url,
          endpoint_method: body.endpoint_method ?? 'POST',
          input_schema: body.input_schema ?? {},
          output_schema: body.output_schema ?? {},
          timeout_ms: body.timeout_ms ?? 30_000,
          visibility: body.visibility ?? 'public',
          webhook_secret_enc: enc,
          disabled_at: null,
          updated_at: new Date(),
        })
        .where(eq(actions.id, existing.id))
        .returning();
      row = updated;
    } else {
      const [inserted] = await db
        .insert(actions)
        .values({
          tenant_id: tenantId,
          slug: body.slug,
          display_name: body.display_name,
          description: body.description ?? null,
          endpoint_url: body.endpoint_url,
          endpoint_method: body.endpoint_method ?? 'POST',
          input_schema: body.input_schema ?? {},
          output_schema: body.output_schema ?? {},
          webhook_secret_enc: enc,
          timeout_ms: body.timeout_ms ?? 30_000,
          visibility: body.visibility ?? 'public',
        })
        .returning();
      row = inserted;
    }

    await recordAudit(
      agent.agentId,
      existing ? 'action_overwrite' : 'action_create',
      row.id,
      { slug: row.slug, display_name: row.display_name },
      { tenant_id: tenantId, ...(agent.userId ? { user_id: agent.userId } : {}) },
    );

    return c.json(
      { action: toPublic(row), webhook_secret: plaintext },
      201,
    );
  },
);

// ---------------------------------------------------------------------------
// GET /v1/integrator/actions — list this tenant's actions (incl. disabled)
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/integrator/actions',
    tags: ['integrator', 'actions'],
    summary: 'List this tenant\'s actions',
    security: [{ bearerAuth: [] }],
    middleware: [requireIntegratorKey] as const,
    responses: {
      200: {
        description: 'Actions.',
        content: { 'application/json': { schema: z.array(ActionPublic) } },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const tenantId = c.get('agent').tenantId!;
    const rows = await db
      .select()
      .from(actions)
      .where(eq(actions.tenant_id, tenantId));
    return c.json(rows.map(toPublic), 200);
  },
);

// ---------------------------------------------------------------------------
// PATCH /v1/integrator/actions/:slug — partial update
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'patch',
    path: '/v1/integrator/actions/{slug}',
    tags: ['integrator', 'actions'],
    summary: 'Update an action',
    security: [{ bearerAuth: [] }],
    middleware: [requireIntegratorKey] as const,
    request: {
      params: z.object({ slug: SLUG.openapi({ param: { name: 'slug', in: 'path' } }) }),
      body: {
        required: true,
        content: { 'application/json': { schema: ActionBodyPatch } },
      },
    },
    responses: {
      200: {
        description: 'Updated.',
        content: { 'application/json': { schema: ActionPublic } },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Not found.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const agent = c.get('agent');
    const tenantId = agent.tenantId!;
    const { slug } = c.req.valid('param');
    const body = c.req.valid('json');

    const [existing] = await db
      .select()
      .from(actions)
      .where(and(eq(actions.tenant_id, tenantId), eq(actions.slug, slug)))
      .limit(1);
    if (!existing) return c.json({ error: 'not_found' }, 404);

    const patch: Partial<typeof actions.$inferInsert> = { updated_at: new Date() };
    if (body.display_name !== undefined) patch.display_name = body.display_name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.endpoint_url !== undefined) patch.endpoint_url = body.endpoint_url;
    if (body.endpoint_method !== undefined) patch.endpoint_method = body.endpoint_method;
    if (body.input_schema !== undefined) patch.input_schema = body.input_schema;
    if (body.output_schema !== undefined) patch.output_schema = body.output_schema;
    if (body.timeout_ms !== undefined) patch.timeout_ms = body.timeout_ms;
    if (body.visibility !== undefined) patch.visibility = body.visibility;
    if (body.disabled !== undefined) {
      patch.disabled_at = body.disabled ? new Date() : null;
    }

    const [updated] = await db
      .update(actions)
      .set(patch)
      .where(eq(actions.id, existing.id))
      .returning();

    await recordAudit(
      agent.agentId,
      'action_update',
      updated.id,
      { slug: updated.slug, changed_keys: Object.keys(patch) },
      { tenant_id: tenantId, ...(agent.userId ? { user_id: agent.userId } : {}) },
    );

    return c.json(toPublic(updated), 200);
  },
);

// ---------------------------------------------------------------------------
// DELETE /v1/integrator/actions/:slug — soft-delete (disables; preserves ledger)
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'delete',
    path: '/v1/integrator/actions/{slug}',
    tags: ['integrator', 'actions'],
    summary: 'Disable an action (soft-delete)',
    security: [{ bearerAuth: [] }],
    middleware: [requireIntegratorKey] as const,
    request: {
      params: z.object({ slug: SLUG.openapi({ param: { name: 'slug', in: 'path' } }) }),
    },
    responses: {
      200: {
        description: 'Disabled.',
        content: {
          'application/json': {
            schema: z.object({ disabled: z.literal(true), id: z.string().uuid() }),
          },
        },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Not found.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const agent = c.get('agent');
    const tenantId = agent.tenantId!;
    const { slug } = c.req.valid('param');

    const [existing] = await db
      .select({ id: actions.id })
      .from(actions)
      .where(and(eq(actions.tenant_id, tenantId), eq(actions.slug, slug)))
      .limit(1);
    if (!existing) return c.json({ error: 'not_found' }, 404);

    await db
      .update(actions)
      .set({ disabled_at: new Date(), updated_at: new Date() })
      .where(eq(actions.id, existing.id));

    await recordAudit(
      agent.agentId,
      'action_disable',
      existing.id,
      { slug },
      { tenant_id: tenantId, ...(agent.userId ? { user_id: agent.userId } : {}) },
    );

    return c.json({ disabled: true as const, id: existing.id }, 200);
  },
);

export default app;
