/**
 * /v1/session/* — read + mutate the session's active workspace.
 *
 *   GET  /v1/session                 → { userId, email, activeWorkspace, tenants }
 *   POST /v1/session/workspace       → set activeWorkspace = { kind, tenantId? }
 *   POST /v1/auth/logout             (handled in /v1/auth)
 *
 * The JWT cookie only carries sub+jti — the workspace is stored server-side
 * so switching doesn't require a re-issue. That also means a stolen JWT
 * cannot elevate to a tenant workspace unless the DB row is first updated
 * through this endpoint (which requires the session to be valid).
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { sessionAuth, setActiveWorkspace, type SessionEnv } from '../auth/session';
import { userCanAccessTenant } from '../auth/workspace';
import { db } from '../db/index';
import { tenant_members, tenants } from '../db/schema';

const app = new OpenAPIHono<SessionEnv>();

const ErrorResponse = z.object({ error: z.string() });

const WorkspaceSchema = z.union([
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('tenant'), tenantId: z.string().uuid() }),
]);

const TenantSummary = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  role: z.enum(['owner', 'admin', 'viewer', 'member']),
});

const SessionResponse = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  activeWorkspace: WorkspaceSchema,
  tenants: z.array(TenantSummary).openapi({
    description: 'Tenants the user is an owner or member of, used to populate the workspace switcher.',
  }),
});

// ---------------------------------------------------------------------------
// GET /v1/session
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/session',
    tags: ['session'],
    summary: 'Read the current session + workspace context',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    responses: {
      200: {
        description: 'Session + owned/member tenants.',
        content: { 'application/json': { schema: SessionResponse } },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session')!;

    const owned = await db
      .select({ id: tenants.id, slug: tenants.slug, name: tenants.name })
      .from(tenants)
      .where(eq(tenants.owner_user_id, session.userId));

    const memberOf = await db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        role: tenant_members.role,
      })
      .from(tenant_members)
      .innerJoin(tenants, eq(tenants.id, tenant_members.tenant_id))
      .where(eq(tenant_members.user_id, session.userId));

    const seen = new Set<string>();
    const merged: { id: string; slug: string; name: string; role: 'owner' | 'admin' | 'viewer' | 'member' }[] = [];
    for (const t of owned) {
      seen.add(t.id);
      merged.push({ ...t, role: 'owner' });
    }
    for (const t of memberOf) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const role = (t.role as string) as 'owner' | 'admin' | 'viewer' | 'member';
      merged.push({ id: t.id, slug: t.slug, name: t.name, role });
    }

    return c.json(
      {
        userId: session.userId,
        email: session.email,
        activeWorkspace: session.activeWorkspace,
        tenants: merged,
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// POST /v1/session/workspace
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/session/workspace',
    tags: ['session'],
    summary: 'Switch the active workspace for this session',
    description:
      'Switch between the end-user workspace ({ kind: "user" }) and a developer workspace for a tenant the user can access ({ kind: "tenant", tenantId }).',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: WorkspaceSchema } },
      },
    },
    responses: {
      200: {
        description: 'Active workspace updated.',
        content: {
          'application/json': {
            schema: z.object({ activeWorkspace: WorkspaceSchema }),
          },
        },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      403: { description: 'Not a member of that tenant.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const body = c.req.valid('json');

    if (body.kind === 'tenant') {
      const allowed = await userCanAccessTenant(session.userId, body.tenantId);
      if (!allowed) {
        return c.json({ error: 'not a member of that tenant' }, 403);
      }
    }

    await setActiveWorkspace(session.sessionJti, body);
    return c.json({ activeWorkspace: body }, 200);
  },
);

export default app;

// Re-export used elsewhere
export { and };
