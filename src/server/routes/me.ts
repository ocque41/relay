/**
 * /v1/me/* — session-authed self-service routes for signed-in humans.
 *
 *   GET    /v1/me                                       → user or agent info
 *   GET    /v1/me/agent-tokens                          → list the caller's agent tokens
 *   POST   /v1/me/agent-tokens                          → mint a new token (plaintext once)
 *   DELETE /v1/me/agent-tokens/:id                      → revoke a token
 *   GET    /v1/me/tenants                               → list owned tenants
 *   POST   /v1/me/tenants                               → create a tenant
 *   GET    /v1/me/tenants/:id                           → tenant detail + provider list
 *   POST   /v1/me/tenants/:id/providers                 → register a tenant provider
 *   DELETE /v1/me/tenants/:id/providers/:providerId     → remove a provider
 *
 * `/v1/me` also accepts a bearer agent token (existing API surface preserved).
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { sessionAuth, readSession, type SessionEnv } from '../auth/session';
import { hashToken, encrypt } from '../crypto';
import { DEFAULT_AGENT_TOKEN_DAYS, mintAgentToken } from '../auth/mint-token';
import { db } from '../db/index';
import { agents, tenants, tenant_providers, users } from '../db/schema';

const app = new OpenAPIHono<SessionEnv>();
const ErrorResponse = z.object({ error: z.string() });

// ---------------------------------------------------------------------------
// GET /v1/me — accepts either session cookie or bearer agent token
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/me',
    tags: ['me'],
    summary: 'Identify the caller (session cookie OR bearer token)',
    security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    responses: {
      200: {
        description: 'Caller identity.',
        content: {
          'application/json': {
            schema: z.union([
              z.object({
                kind: z.literal('user'),
                userId: z.string().uuid(),
                email: z.string(),
                name: z.string().nullable(),
                inbox_alias: z.string().nullable(),
                inbox_address: z.string().nullable(),
              }),
              z.object({
                kind: z.literal('agent'),
                agentId: z.string().uuid(),
                scopes: z.array(z.string()),
                userId: z.string().uuid().nullable(),
                label: z.string().nullable(),
                inbox_alias: z.string().nullable(),
                inbox_address: z.string().nullable(),
              }),
            ]),
          },
        },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const catchallDomain = process.env.CATCHALL_DOMAIN ?? 'mail.example.com';

    const auth = c.req.header('Authorization');
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7);
      const hash = hashToken(token);
      const rows = await db
        .select()
        .from(agents)
        .where(and(eq(agents.token_hash, hash), isNull(agents.revoked_at)))
        .limit(1);
      const a = rows[0];
      if (!a) return c.json({ error: 'unauthorized' }, 401);
      if (a.expires_at && a.expires_at.getTime() <= Date.now()) {
        return c.json(
          {
            error: 'agent_token_expired',
            message:
              'Your Relay agent token has expired. Re-run register_tenant to get a new one.',
          },
          401,
        );
      }

      // Fetch alias from the owning user if any.
      let inbox_alias: string | null = null;
      if (a.user_id) {
        const u = await db
          .select({ inbox_alias: users.inbox_alias })
          .from(users)
          .where(eq(users.id, a.user_id))
          .limit(1);
        inbox_alias = u[0]?.inbox_alias ?? null;
      }

      return c.json(
        {
          kind: 'agent' as const,
          agentId: a.id,
          scopes: (a.scopes as string[]) ?? [],
          userId: a.user_id,
          label: a.label,
          inbox_alias,
          inbox_address: inbox_alias ? `${inbox_alias}@${catchallDomain}` : null,
        },
        200,
      );
    }

    const session = await readSession(c);
    if (!session) return c.json({ error: 'unauthorized' }, 401);

    const rows = await db
      .select({ name: users.name, email: users.email, inbox_alias: users.inbox_alias })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    const user = rows[0];
    return c.json(
      {
        kind: 'user' as const,
        userId: session.userId,
        email: user?.email ?? session.email,
        name: user?.name ?? null,
        inbox_alias: user?.inbox_alias ?? null,
        inbox_address: user?.inbox_alias ? `${user.inbox_alias}@${catchallDomain}` : null,
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// Agent tokens
// ---------------------------------------------------------------------------
const AgentTokenPublic = z.object({
  id: z.string().uuid(),
  label: z.string().nullable(),
  scopes: z.array(z.string()),
  created_at: z.string().nullable(),
  last_used_at: z.string().nullable(),
});

app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/me/agent-tokens',
    tags: ['me'],
    summary: 'List my agent tokens',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    responses: {
      200: { description: 'Tokens.', content: { 'application/json': { schema: z.array(AgentTokenPublic) } } },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const rows = await db
      .select({
        id: agents.id,
        label: agents.label,
        scopes: agents.scopes,
        created_at: agents.created_at,
        last_used_at: agents.last_used_at,
      })
      .from(agents)
      .where(and(eq(agents.user_id, session.userId), isNull(agents.revoked_at)));

    return c.json(
      rows.map((r) => ({
        id: r.id,
        label: r.label,
        scopes: (r.scopes as string[]) ?? [],
        created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
        last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
      })),
      200,
    );
  },
);

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/me/agent-tokens',
    tags: ['me'],
    summary: 'Mint a new agent token (plaintext returned once)',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              label: z.string().min(1).max(100),
              scopes: z.array(z.string()).optional(),
              expires_in_days: z
                .number()
                .int()
                .min(1)
                .max(365)
                .optional()
                .describe(
                  `How many days the new token remains valid. Defaults to ${DEFAULT_AGENT_TOKEN_DAYS}.`,
                ),
              never_expires: z
                .boolean()
                .optional()
                .describe('Opt in to a non-expiring token.'),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Created.',
        content: {
          'application/json': {
            schema: z.object({
              id: z.string().uuid(),
              token: z.string().describe('Plaintext — shown once.'),
              label: z.string(),
              scopes: z.array(z.string()),
              expires_at: z.string().nullable(),
            }),
          },
        },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const { label, scopes, expires_in_days, never_expires } =
      c.req.valid('json');

    const minted = await mintAgentToken({
      userId: session.userId,
      label,
      scopes: scopes ?? [],
      expiry: never_expires
        ? 'never'
        : { days: expires_in_days ?? DEFAULT_AGENT_TOKEN_DAYS },
      userRequestedNever: never_expires === true,
    });

    return c.json(
      {
        id: minted.agentId,
        token: minted.token,
        label,
        scopes: scopes ?? [],
        expires_at: minted.expiresAt ? minted.expiresAt.toISOString() : null,
      },
      201,
    );
  },
);

app.openapi(
  createRoute({
    method: 'delete',
    path: '/v1/me/agent-tokens/{id}',
    tags: ['me'],
    summary: 'Revoke an agent token',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    request: {
      params: z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) }),
    },
    responses: {
      200: {
        description: 'Revoked.',
        content: {
          'application/json': { schema: z.object({ revoked: z.literal(true), id: z.string().uuid() }) },
        },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Not found.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const { id } = c.req.valid('param');

    const found = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.user_id, session.userId)))
      .limit(1);
    if (!found[0]) return c.json({ error: 'not found' }, 404);

    await db.update(agents).set({ revoked_at: new Date() }).where(eq(agents.id, id));
    return c.json({ revoked: true as const, id }, 200);
  },
);

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------
function slugify(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
  return base || 'tenant';
}

const TenantPublic = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  created_at: z.string().nullable(),
});

app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/me/tenants',
    tags: ['me', 'tenants'],
    summary: 'List tenants I own',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    responses: {
      200: {
        description: 'Tenants.',
        content: { 'application/json': { schema: z.array(TenantPublic) } },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const rows = await db
      .select()
      .from(tenants)
      .where(eq(tenants.owner_user_id, session.userId));
    return c.json(
      rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
      })),
      200,
    );
  },
);

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/me/tenants',
    tags: ['me', 'tenants'],
    summary: 'Create a tenant',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              name: z.string().min(1).max(120),
              slug: z.string().regex(/^[a-z0-9-]+$/).min(1).max(40).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: 'Created.', content: { 'application/json': { schema: TenantPublic } } },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      409: { description: 'Slug taken.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const { name, slug: userSlug } = c.req.valid('json');
    const baseSlug = userSlug ?? slugify(name);

    // Probe for uniqueness; append a 4-char suffix if taken.
    let slug = baseSlug;
    const existing = await db
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.slug, baseSlug))
      .limit(1);
    if (existing[0]) {
      if (userSlug) return c.json({ error: 'slug already taken' }, 409);
      slug = `${baseSlug}-${randomBytes(2).toString('hex')}`;
    }

    const inserted = await db
      .insert(tenants)
      .values({ owner_user_id: session.userId, name, slug })
      .returning();

    const t = inserted[0];
    return c.json(
      {
        id: t.id,
        slug: t.slug,
        name: t.name,
        created_at: t.created_at ? new Date(t.created_at).toISOString() : null,
      },
      201,
    );
  },
);

app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/me/tenants/{id}',
    tags: ['me', 'tenants'],
    summary: 'Get a tenant + its providers',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    request: {
      params: z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) }),
    },
    responses: {
      200: {
        description: 'Tenant.',
        content: {
          'application/json': {
            schema: TenantPublic.extend({
              providers: z.array(
                z.object({
                  id: z.string().uuid(),
                  slug: z.string(),
                  display_name: z.string(),
                  signup_webhook_url: z.string(),
                  teardown_webhook_url: z.string().nullable(),
                  input_schema: z.record(z.string(), z.unknown()),
                  needs_email_verification: z.boolean(),
                  created_at: z.string().nullable(),
                }),
              ),
            }),
          },
        },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Not found.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const { id } = c.req.valid('param');

    const tRows = await db
      .select()
      .from(tenants)
      .where(and(eq(tenants.id, id), eq(tenants.owner_user_id, session.userId)))
      .limit(1);
    const t = tRows[0];
    if (!t) return c.json({ error: 'not found' }, 404);

    const pRows = await db
      .select({
        id: tenant_providers.id,
        slug: tenant_providers.slug,
        display_name: tenant_providers.display_name,
        signup_webhook_url: tenant_providers.signup_webhook_url,
        teardown_webhook_url: tenant_providers.teardown_webhook_url,
        input_schema: tenant_providers.input_schema,
        needs_email_verification: tenant_providers.needs_email_verification,
        created_at: tenant_providers.created_at,
      })
      .from(tenant_providers)
      .where(eq(tenant_providers.tenant_id, id));

    return c.json(
      {
        id: t.id,
        slug: t.slug,
        name: t.name,
        created_at: t.created_at ? new Date(t.created_at).toISOString() : null,
        providers: pRows.map((p) => ({
          id: p.id,
          slug: p.slug,
          display_name: p.display_name,
          signup_webhook_url: p.signup_webhook_url,
          teardown_webhook_url: p.teardown_webhook_url,
          input_schema: (p.input_schema ?? {}) as Record<string, unknown>,
          needs_email_verification: p.needs_email_verification,
          created_at: p.created_at ? new Date(p.created_at).toISOString() : null,
        })),
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// Tenant providers
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/me/tenants/{id}/providers',
    tags: ['me', 'tenants'],
    summary: 'Register a tenant provider (webhook secret is returned once)',
    description:
      'Relay will dispatch HMAC-signed webhook calls to `signup_webhook_url` when an agent initiates a signup. `needs_email_verification` is reserved for a future phase — today it is stored but not enforced; Relay does NOT yet send a confirmation email to the user before calling the integrator webhook.',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    request: {
      params: z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) }),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              slug: z.string().regex(/^[a-z0-9-]+$/).min(2).max(60),
              display_name: z.string().min(1).max(120),
              signup_webhook_url: z.string().url(),
              teardown_webhook_url: z.string().url().optional(),
              input_schema: z.record(z.string(), z.unknown()).optional(),
              needs_email_verification: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Provider registered.',
        content: {
          'application/json': {
            schema: z.object({
              id: z.string().uuid(),
              slug: z.string(),
              webhook_secret: z.string().describe('Plaintext — shown once.'),
            }),
          },
        },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Tenant not found.', content: { 'application/json': { schema: ErrorResponse } } },
      409: { description: 'Slug taken.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    const tRows = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.id, id), eq(tenants.owner_user_id, session.userId)))
      .limit(1);
    if (!tRows[0]) return c.json({ error: 'tenant not found' }, 404);

    const existing = await db
      .select({ slug: tenant_providers.slug })
      .from(tenant_providers)
      .where(eq(tenant_providers.slug, body.slug))
      .limit(1);
    if (existing[0]) return c.json({ error: 'slug already taken' }, 409);

    const webhookSecret = randomBytes(32).toString('base64url');
    const inserted = await db
      .insert(tenant_providers)
      .values({
        tenant_id: id,
        slug: body.slug,
        display_name: body.display_name,
        signup_webhook_url: body.signup_webhook_url,
        teardown_webhook_url: body.teardown_webhook_url ?? null,
        webhook_secret_enc: encrypt(webhookSecret),
        input_schema: body.input_schema ?? {},
        needs_email_verification: body.needs_email_verification ?? false,
      })
      .returning({ id: tenant_providers.id, slug: tenant_providers.slug });

    return c.json(
      { id: inserted[0].id, slug: inserted[0].slug, webhook_secret: webhookSecret },
      201,
    );
  },
);

app.openapi(
  createRoute({
    method: 'delete',
    path: '/v1/me/tenants/{id}/providers/{providerId}',
    tags: ['me', 'tenants'],
    summary: 'Remove a tenant provider',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    request: {
      params: z.object({
        id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
        providerId: z.string().uuid().openapi({ param: { name: 'providerId', in: 'path' } }),
      }),
    },
    responses: {
      200: {
        description: 'Deleted.',
        content: {
          'application/json': {
            schema: z.object({ deleted: z.literal(true), id: z.string().uuid() }),
          },
        },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Not found.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const { id, providerId } = c.req.valid('param');

    const tRows = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.id, id), eq(tenants.owner_user_id, session.userId)))
      .limit(1);
    if (!tRows[0]) return c.json({ error: 'tenant not found' }, 404);

    const deleted = await db
      .delete(tenant_providers)
      .where(and(eq(tenant_providers.id, providerId), eq(tenant_providers.tenant_id, id)))
      .returning({ id: tenant_providers.id });
    if (!deleted[0]) return c.json({ error: 'provider not found' }, 404);

    return c.json({ deleted: true as const, id: deleted[0].id }, 200);
  },
);

export default app;
