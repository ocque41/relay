/**
 * /v1/dev/* — developer workspace routes. Cookie session + active workspace of
 * { kind: 'tenant', tenantId }. Every read/write is filtered by the active
 * tenant id that `requireTenantWorkspace` dropped into the context.
 *
 *   GET    /v1/dev                          → tenant overview + weekly aggregates
 *   GET    /v1/dev/products                 → tenant_providers for this tenant
 *   GET    /v1/dev/products/:slug           → detail + recent signups
 *   POST   /v1/dev/products                 → register a new product
 *   POST   /v1/dev/products/:slug/rotate    → rotate webhook secret (plaintext once)
 *   DELETE /v1/dev/products/:slug           → remove
 *   GET    /v1/dev/users                    → distinct end-users who signed up
 *   GET    /v1/dev/team                     → tenant_members + owner
 *   POST   /v1/dev/team                     → invite user by email
 *   DELETE /v1/dev/team/:userId             → remove member (owner only)
 *   GET    /v1/dev/settings                 → tenant row
 *   PATCH  /v1/dev/settings                 → update name
 *   DELETE /v1/dev/settings                 → delete the workspace (owner-only, hard)
 *   GET    /v1/dev/stats                    → weekly status counts
 *   GET    /v1/dev/logs                     → recent signup_jobs
 *   GET    /v1/dev/feature-flags            → flags currently enabled
 *   POST   /v1/dev/feature-flags            → enable a flag
 *   DELETE /v1/dev/feature-flags/:flag      → disable
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { randomBytes } from 'node:crypto';
import { and, countDistinct, desc, eq, gt, sql } from 'drizzle-orm';
import { encrypt } from '../crypto';
import { db } from '../db/index';
import {
  accounts,
  sessions,
  signup_jobs,
  tenant_feature_flags,
  tenant_members,
  tenant_providers,
  tenant_subscriptions,
  tenants,
  users,
} from '../db/schema';
import { type SessionEnv } from '../auth/session';
import {
  requireTenantWorkspaceFromBearerOrSession,
  type WorkspaceEnv,
} from '../auth/workspace';
import {
  registerTenantProduct,
  RegisterTenantProductFailure,
} from '../dev/products';
import { recordAudit } from '../audit';

const app = new OpenAPIHono<WorkspaceEnv>();

const ErrorResponse = z.object({ error: z.string() });

// Both auth modes are acceptable on /v1/dev/*: cookie session (dashboard) and
// agent bearer token (AI agent, with `X-Relay-Tenant` header). The explicit
// `as Array<Record<string, string[]>>` cast keeps TypeScript from widening
// the tuple into a union that poisons downstream `c.req.valid(...)` inference.
const securityCookieOrBearer: Array<Record<string, string[]>> = [
  { cookieAuth: [] },
  { bearerAuth: [] },
];

// Helper: is the caller the tenant's owner?
async function isOwner(userId: string, tenantId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.id, tenantId), eq(tenants.owner_user_id, userId)))
    .limit(1);
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// GET /v1/dev — overview
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/dev',
    tags: ['dev'],
    summary: 'Developer workspace overview',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    responses: {
      200: {
        description: 'Tenant + weekly aggregates.',
        content: {
          'application/json': {
            schema: z.object({
              tenant: z.object({
                id: z.string().uuid(),
                slug: z.string(),
                name: z.string(),
                created_at: z.string().nullable(),
              }),
              weekly: z.object({
                signupsStarted: z.number(),
                signupsCompleted: z.number(),
                signupsFailed: z.number(),
                awaitingEmail: z.number(),
                uniqueUsers: z.number(),
              }),
            }),
          },
        },
      },
      404: { description: 'Tenant not found.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const tenantId = c.get('activeTenantId')!;

    const [t] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!t) return c.json({ error: 'tenant not found' }, 404);

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [started, completed, failed, awaiting] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(signup_jobs)
        .where(and(eq(signup_jobs.tenant_id, tenantId), gt(signup_jobs.created_at, weekAgo))),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(signup_jobs)
        .where(
          and(
            eq(signup_jobs.tenant_id, tenantId),
            eq(signup_jobs.status, 'complete'),
            gt(signup_jobs.created_at, weekAgo),
          ),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(signup_jobs)
        .where(
          and(
            eq(signup_jobs.tenant_id, tenantId),
            eq(signup_jobs.status, 'failed'),
            gt(signup_jobs.created_at, weekAgo),
          ),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(signup_jobs)
        .where(
          and(
            eq(signup_jobs.tenant_id, tenantId),
            eq(signup_jobs.status, 'awaiting_email'),
          ),
        ),
    ]);

    const [uniq] = await db
      .select({ count: countDistinct(signup_jobs.user_id) })
      .from(signup_jobs)
      .where(and(eq(signup_jobs.tenant_id, tenantId), gt(signup_jobs.created_at, weekAgo)));

    return c.json(
      {
        tenant: {
          id: t.id,
          slug: t.slug,
          name: t.name,
          created_at: t.created_at ? new Date(t.created_at).toISOString() : null,
        },
        weekly: {
          signupsStarted: Number(started[0]?.count ?? 0),
          signupsCompleted: Number(completed[0]?.count ?? 0),
          signupsFailed: Number(failed[0]?.count ?? 0),
          awaitingEmail: Number(awaiting[0]?.count ?? 0),
          uniqueUsers: Number(uniq?.count ?? 0),
        },
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
const ProductSummary = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  display_name: z.string(),
  signup_webhook_url: z.string(),
  teardown_webhook_url: z.string().nullable(),
  verification_mode: z.string(),
  needs_email_verification: z.boolean(),
  created_at: z.string().nullable(),
  signups_total: z.number(),
  signups_week: z.number(),
});

app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/dev/products',
    tags: ['dev'],
    summary: 'List products (tenant providers) with per-product counts',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    responses: {
      200: {
        description: 'Products.',
        content: { 'application/json': { schema: z.array(ProductSummary) } },
      },
    },
  }),
  async (c) => {
    const tenantId = c.get('activeTenantId')!;
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const products = await db
      .select()
      .from(tenant_providers)
      .where(eq(tenant_providers.tenant_id, tenantId));

    const summaries = await Promise.all(
      products.map(async (p) => {
        const [total] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(signup_jobs)
          .where(eq(signup_jobs.provider_slug, p.slug));
        const [week] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(signup_jobs)
          .where(and(eq(signup_jobs.provider_slug, p.slug), gt(signup_jobs.created_at, weekAgo)));

        return {
          id: p.id,
          slug: p.slug,
          display_name: p.display_name,
          signup_webhook_url: p.signup_webhook_url,
          teardown_webhook_url: p.teardown_webhook_url,
          verification_mode: p.verification_mode,
          needs_email_verification: p.needs_email_verification,
          created_at: p.created_at ? new Date(p.created_at).toISOString() : null,
          signups_total: Number(total?.count ?? 0),
          signups_week: Number(week?.count ?? 0),
        };
      }),
    );

    return c.json(summaries, 200);
  },
);

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/dev/products',
    tags: ['dev'],
    summary: 'Register a new product on this tenant (webhook secret returned once)',
    security: [{ cookieAuth: [] }, { bearerAuth: [] }] as Array<Record<string, string[]>>,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    request: {
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
              verification_mode: z.enum(['none', 'relay_confirm_link', 'integrator_email']).optional(),
              description: z.string().max(500).optional(),
              docs_url: z.string().url().optional(),
              homepage: z.string().url().optional(),
              npm_package: z.string().max(214).optional(),
              categories: z.array(z.string()).max(8).optional(),
              pricing_model: z
                .enum(['free', 'free-tier', 'paid', 'usage-based', 'freemium'])
                .optional(),
              pricing_url: z.string().url().optional(),
              free_tier_summary: z.string().max(240).optional(),
              capabilities: z.array(z.string()).max(24).optional(),
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
              slug: z.string(),
              webhook_secret: z.string(),
              categories: z.array(z.string()),
            }),
          },
        },
      },
      400: {
        description: 'Invalid slug, categories, or pricing model.',
        content: {
          'application/json': {
            schema: z.object({
              error: z.string(),
              invalid: z.array(z.string()).optional(),
              canonical: z.array(z.string()).optional(),
            }),
          },
        },
      },
      409: { description: 'Slug taken.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const tenantId = c.get('activeTenantId')!;
    const body = c.req.valid('json');

    try {
      const result = await registerTenantProduct({
        tenantId,
        slug: body.slug,
        displayName: body.display_name,
        signupWebhookUrl: body.signup_webhook_url,
        teardownWebhookUrl: body.teardown_webhook_url,
        verificationMode: body.verification_mode,
        inputSchema: body.input_schema,
        description: body.description,
        docsUrl: body.docs_url,
        homepage: body.homepage,
        npmPackage: body.npm_package,
        categories: body.categories,
        pricingModel: body.pricing_model,
        pricingUrl: body.pricing_url,
        freeTierSummary: body.free_tier_summary,
        capabilities: body.capabilities,
      });
      return c.json(result, 201);
    } catch (e) {
      if (e instanceof RegisterTenantProductFailure) {
        if (e.kind === 'slug_taken') {
          return c.json({ error: e.message }, 409);
        }
        if (e.kind === 'invalid_categories') {
          return c.json(
            {
              error: e.message,
              invalid: e.invalid ?? [],
              canonical: [...(e.canonical ?? [])],
            },
            400,
          );
        }
        return c.json({ error: e.message }, 400);
      }
      throw e;
    }
  },
);

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/dev/products/{slug}/rotate',
    tags: ['dev'],
    summary: 'Rotate a product\'s webhook secret (new plaintext returned once)',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    request: {
      params: z.object({
        slug: z.string().openapi({ param: { name: 'slug', in: 'path' } }),
      }),
    },
    responses: {
      200: {
        description: 'Rotated.',
        content: {
          'application/json': {
            schema: z.object({
              slug: z.string(),
              webhook_secret: z.string(),
            }),
          },
        },
      },
      404: { description: 'Product not found.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const tenantId = c.get('activeTenantId')!;
    const { slug } = c.req.valid('param');

    const [p] = await db
      .select({ id: tenant_providers.id })
      .from(tenant_providers)
      .where(and(eq(tenant_providers.slug, slug), eq(tenant_providers.tenant_id, tenantId)))
      .limit(1);
    if (!p) return c.json({ error: 'product not found' }, 404);

    const secret = randomBytes(32).toString('base64url');
    await db
      .update(tenant_providers)
      .set({ webhook_secret_enc: encrypt(secret) })
      .where(eq(tenant_providers.id, p.id));

    return c.json({ slug, webhook_secret: secret }, 200);
  },
);

app.openapi(
  createRoute({
    method: 'delete',
    path: '/v1/dev/products/{slug}',
    tags: ['dev'],
    summary: 'Remove a product',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    request: {
      params: z.object({
        slug: z.string().openapi({ param: { name: 'slug', in: 'path' } }),
      }),
    },
    responses: {
      200: {
        description: 'Deleted.',
        content: {
          'application/json': {
            schema: z.object({ deleted: z.literal(true), slug: z.string() }),
          },
        },
      },
    },
  }),
  async (c) => {
    const tenantId = c.get('activeTenantId')!;
    const { slug } = c.req.valid('param');
    await db
      .delete(tenant_providers)
      .where(and(eq(tenant_providers.slug, slug), eq(tenant_providers.tenant_id, tenantId)));
    return c.json({ deleted: true as const, slug }, 200);
  },
);

// ---------------------------------------------------------------------------
// GET /v1/dev/users
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/dev/users',
    tags: ['dev'],
    summary: 'End-users who signed up through this tenant',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    responses: {
      200: {
        description: 'Users.',
        content: {
          'application/json': {
            schema: z.array(
              z.object({
                user_id: z.string().uuid(),
                email: z.string(),
                signups: z.number(),
                last_signup_at: z.string().nullable(),
                last_product: z.string().nullable(),
                last_status: z.string().nullable(),
              }),
            ),
          },
        },
      },
    },
  }),
  async (c) => {
    const tenantId = c.get('activeTenantId')!;

    const rows = await db
      .select({
        user_id: signup_jobs.user_id,
        email: users.email,
        signups: sql<number>`count(${signup_jobs.id})::int`,
        last_signup_at: sql<Date | null>`max(${signup_jobs.created_at})`,
      })
      .from(signup_jobs)
      .innerJoin(users, eq(users.id, signup_jobs.user_id))
      .where(eq(signup_jobs.tenant_id, tenantId))
      .groupBy(signup_jobs.user_id, users.email);

    // Hydrate "last product + status" with a second query (simpler than
    // window functions; bounded to the tenant's signup volume).
    const perUser = await Promise.all(
      rows.map(async (r) => {
        const [latest] = r.user_id
          ? await db
              .select({
                provider_slug: signup_jobs.provider_slug,
                status: signup_jobs.status,
              })
              .from(signup_jobs)
              .where(
                and(
                  eq(signup_jobs.tenant_id, tenantId),
                  eq(signup_jobs.user_id, r.user_id),
                ),
              )
              .orderBy(desc(signup_jobs.created_at))
              .limit(1)
          : [];
        return {
          user_id: r.user_id as string,
          email: r.email,
          signups: Number(r.signups ?? 0),
          last_signup_at: r.last_signup_at
            ? new Date(r.last_signup_at).toISOString()
            : null,
          last_product: latest?.provider_slug ?? null,
          last_status: latest?.status ?? null,
        };
      }),
    );

    return c.json(perUser, 200);
  },
);

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------
const MemberRow = z.object({
  user_id: z.string().uuid(),
  email: z.string(),
  role: z.string(),
  is_owner: z.boolean(),
  created_at: z.string().nullable(),
});

app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/dev/team',
    tags: ['dev'],
    summary: 'List tenant members (owner + additional members)',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    responses: {
      200: {
        description: 'Members.',
        content: { 'application/json': { schema: z.array(MemberRow) } },
      },
    },
  }),
  async (c) => {
    const tenantId = c.get('activeTenantId')!;

    const [t] = await db
      .select({ owner_user_id: tenants.owner_user_id })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!t) return c.json([], 200);

    const [owner] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, t.owner_user_id))
      .limit(1);

    const members = await db
      .select({
        user_id: tenant_members.user_id,
        email: users.email,
        role: tenant_members.role,
        created_at: tenant_members.created_at,
      })
      .from(tenant_members)
      .innerJoin(users, eq(users.id, tenant_members.user_id))
      .where(eq(tenant_members.tenant_id, tenantId));

    const list = [] as z.infer<typeof MemberRow>[];
    if (owner) {
      list.push({
        user_id: owner.id,
        email: owner.email,
        role: 'owner',
        is_owner: true,
        created_at: null,
      });
    }
    for (const m of members) {
      if (owner && m.user_id === owner.id) continue;
      list.push({
        user_id: m.user_id,
        email: m.email,
        role: m.role,
        is_owner: false,
        created_at: m.created_at ? new Date(m.created_at).toISOString() : null,
      });
    }

    return c.json(list, 200);
  },
);

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/dev/team',
    tags: ['dev'],
    summary: 'Invite an existing Relay user to the tenant',
    description:
      'Owner-only. The invitee must already have a Relay user (by email). This does not send an email; their next login will surface the tenant in their workspace switcher.',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              email: z.string().email(),
              role: z.enum(['admin', 'viewer', 'member']).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Added.',
        content: {
          'application/json': {
            schema: z.object({ user_id: z.string().uuid(), role: z.string() }),
          },
        },
      },
      403: { description: 'Owner-only.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'User not found.', content: { 'application/json': { schema: ErrorResponse } } },
      409: { description: 'Already a member.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const activeUserId = c.get('activeUserId')!;
    const tenantId = c.get('activeTenantId')!;

    if (!(await isOwner(activeUserId, tenantId))) {
      return c.json({ error: 'owner-only' }, 403);
    }

    const { email, role } = c.req.valid('json');
    const [target] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!target) return c.json({ error: 'user with that email not found' }, 404);

    const [existing] = await db
      .select({ user_id: tenant_members.user_id })
      .from(tenant_members)
      .where(
        and(
          eq(tenant_members.tenant_id, tenantId),
          eq(tenant_members.user_id, target.id),
        ),
      )
      .limit(1);
    if (existing) return c.json({ error: 'already a member' }, 409);

    const assignedRole = role ?? 'viewer';
    await db.insert(tenant_members).values({
      tenant_id: tenantId,
      user_id: target.id,
      role: assignedRole,
    });

    return c.json({ user_id: target.id, role: assignedRole }, 201);
  },
);

app.openapi(
  createRoute({
    method: 'delete',
    path: '/v1/dev/team/{userId}',
    tags: ['dev'],
    summary: 'Remove a tenant member',
    description: 'Owner-only. Cannot remove the owner themselves.',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    request: {
      params: z.object({
        userId: z.string().uuid().openapi({ param: { name: 'userId', in: 'path' } }),
      }),
    },
    responses: {
      200: {
        description: 'Removed.',
        content: {
          'application/json': {
            schema: z.object({ removed: z.literal(true), user_id: z.string().uuid() }),
          },
        },
      },
      403: { description: 'Owner-only.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const activeUserId = c.get('activeUserId')!;
    const tenantId = c.get('activeTenantId')!;
    const { userId } = c.req.valid('param');

    if (!(await isOwner(activeUserId, tenantId))) {
      return c.json({ error: 'owner-only' }, 403);
    }

    await db
      .delete(tenant_members)
      .where(
        and(
          eq(tenant_members.tenant_id, tenantId),
          eq(tenant_members.user_id, userId),
        ),
      );
    return c.json({ removed: true as const, user_id: userId }, 200);
  },
);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/dev/settings',
    tags: ['dev'],
    summary: 'Tenant settings',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    responses: {
      200: {
        description: 'Tenant row.',
        content: {
          'application/json': {
            schema: z.object({
              id: z.string().uuid(),
              slug: z.string(),
              name: z.string(),
              created_at: z.string().nullable(),
            }),
          },
        },
      },
      404: { description: 'Tenant not found.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const tenantId = c.get('activeTenantId')!;
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!t) return c.json({ error: 'tenant not found' }, 404);
    return c.json(
      {
        id: t.id,
        slug: t.slug,
        name: t.name,
        created_at: t.created_at ? new Date(t.created_at).toISOString() : null,
      },
      200,
    );
  },
);

app.openapi(
  createRoute({
    method: 'patch',
    path: '/v1/dev/settings',
    tags: ['dev'],
    summary: 'Update tenant name',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              name: z.string().min(1).max(120),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Updated.',
        content: {
          'application/json': {
            schema: z.object({ id: z.string().uuid(), name: z.string() }),
          },
        },
      },
      403: { description: 'Owner-only.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const activeUserId = c.get('activeUserId')!;
    const tenantId = c.get('activeTenantId')!;
    const { name } = c.req.valid('json');

    if (!(await isOwner(activeUserId, tenantId))) {
      return c.json({ error: 'owner-only' }, 403);
    }

    await db.update(tenants).set({ name }).where(eq(tenants.id, tenantId));
    return c.json({ id: tenantId, name }, 200);
  },
);

// ---------------------------------------------------------------------------
// DELETE /v1/dev/settings — hard delete the active workspace.
//
// Preconditions:
//   1. Caller is the workspace owner.
//   2. No live Stripe subscription exists (status in trialing|active|past_due).
//      Owners must cancel billing first via /dev/billing.
//   3. The typed `confirm_name` matches the tenant's current name exactly.
//      (UI enforces type-to-confirm; route double-checks so CLI / MCP can't
//      skip it.)
//
// On success every FK with onDelete: 'cascade' (tenant_members, tenant_providers,
// tenant_feature_flags, tenant_subscriptions, tenant_quota_state, agents,
// user_external_identities, actions, tenant_plan_features, subscription_events,
// stripe_pending_invoice_items, scale_benchmark_samples) drops with the tenant.
// Historical rows with onDelete: 'set null' (accounts, signup_jobs, audit_log)
// keep their user-side record but forget the tenant link.
//
// Every active session whose active_workspace points at this tenant is flipped
// back to { kind: 'user' } in-place so the switcher can't show a dangling id.
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'delete',
    path: '/v1/dev/settings',
    tags: ['dev'],
    summary: 'Delete the active workspace (hard, owner-only)',
    description:
      'Permanently deletes the workspace and everything scoped to it. ' +
      'Requires the caller to be the owner, no live Stripe subscription, and ' +
      'a confirm_name body field that exactly matches the workspace name.',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              confirm_name: z
                .string()
                .min(1)
                .describe('Must equal the workspace name exactly.'),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Deleted.',
        content: {
          'application/json': {
            schema: z.object({
              deleted: z.literal(true),
              tenant_id: z.string().uuid(),
              slug: z.string(),
            }),
          },
        },
      },
      400: {
        description: 'confirm_name did not match the workspace name.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      403: {
        description: 'Owner-only.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      404: {
        description: 'Tenant not found.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      409: {
        description:
          'A live Stripe subscription exists — cancel via /dev/billing first.',
        content: {
          'application/json': {
            schema: z.object({
              error: z.literal('active_subscription'),
              subscription_status: z.string(),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const activeUserId = c.get('activeUserId')!;
    const tenantId = c.get('activeTenantId')!;
    const { confirm_name } = c.req.valid('json');

    const [t] = await db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        owner_user_id: tenants.owner_user_id,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!t) return c.json({ error: 'tenant not found' }, 404);
    if (t.owner_user_id !== activeUserId) {
      return c.json({ error: 'owner-only' }, 403);
    }
    if (confirm_name.trim() !== t.name) {
      return c.json(
        {
          error:
            'confirm_name must equal the workspace name exactly (case-sensitive)',
        },
        400,
      );
    }

    const [sub] = await db
      .select({ status: tenant_subscriptions.status })
      .from(tenant_subscriptions)
      .where(eq(tenant_subscriptions.tenant_id, tenantId))
      .orderBy(desc(tenant_subscriptions.created_at))
      .limit(1);
    if (sub && (sub.status === 'trialing' || sub.status === 'active' || sub.status === 'past_due')) {
      return c.json(
        { error: 'active_subscription' as const, subscription_status: sub.status },
        409,
      );
    }

    // Audit BEFORE the delete so the row survives the cascade (audit_log
    // keeps tenant_id with onDelete: 'set null', so it's safe either way,
    // but recording up-front preserves the pre-delete snapshot).
    await recordAudit(
      null,
      'tenant_delete',
      tenantId,
      {
        tenant_slug: t.slug,
        tenant_name: t.name,
        by_user_id: activeUserId,
      },
      { user_id: activeUserId, tenant_id: tenantId },
    );

    // Flip every session whose active_workspace points at this tenant back
    // to the user workspace so the switcher doesn't load a dangling id.
    await db
      .update(sessions)
      .set({ active_workspace: { kind: 'user' } })
      .where(
        sql`${sessions.active_workspace} ->> 'tenantId' = ${tenantId}`,
      );

    await db.delete(tenants).where(eq(tenants.id, tenantId));

    return c.json(
      { deleted: true as const, tenant_id: tenantId, slug: t.slug },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// Logs + stats
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/dev/logs',
    tags: ['dev'],
    summary: 'Recent signup_jobs for this tenant',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    request: {
      query: z.object({
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: 'Rows.',
        content: {
          'application/json': {
            schema: z.array(
              z.object({
                id: z.string().uuid(),
                status: z.string(),
                provider_slug: z.string().nullable(),
                account_id: z.string().uuid().nullable(),
                error: z.string().nullable(),
                created_at: z.string().nullable(),
              }),
            ),
          },
        },
      },
    },
  }),
  async (c) => {
    const tenantId = c.get('activeTenantId')!;
    const { limit } = c.req.valid('query');
    const cap = Math.min(200, Math.max(1, parseInt(limit ?? '50', 10) || 50));

    const rows = await db
      .select({
        id: signup_jobs.id,
        status: signup_jobs.status,
        provider_slug: signup_jobs.provider_slug,
        account_id: signup_jobs.account_id,
        error: signup_jobs.error,
        created_at: signup_jobs.created_at,
      })
      .from(signup_jobs)
      .where(eq(signup_jobs.tenant_id, tenantId))
      .orderBy(desc(signup_jobs.created_at))
      .limit(cap);

    return c.json(
      rows.map((r) => ({
        ...r,
        created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
      })),
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/dev/feature-flags',
    tags: ['dev'],
    summary: 'Enabled feature flags for this tenant',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    responses: {
      200: {
        description: 'Flags.',
        content: {
          'application/json': {
            schema: z.array(
              z.object({
                flag: z.string(),
                enabled_at: z.string(),
              }),
            ),
          },
        },
      },
    },
  }),
  async (c) => {
    const tenantId = c.get('activeTenantId')!;
    const rows = await db
      .select()
      .from(tenant_feature_flags)
      .where(eq(tenant_feature_flags.tenant_id, tenantId));
    return c.json(
      rows.map((r) => ({
        flag: r.flag,
        enabled_at: r.enabled_at.toISOString(),
      })),
      200,
    );
  },
);

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/dev/feature-flags',
    tags: ['dev'],
    summary: 'Enable a feature flag',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              flag: z.enum([
                'per_product_rate_limits',
                'webhook_retries',
                'audit_log_export',
              ]),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Enabled.',
        content: {
          'application/json': {
            schema: z.object({ flag: z.string(), enabled_at: z.string() }),
          },
        },
      },
    },
  }),
  async (c) => {
    const activeUserId = c.get('activeUserId')!;
    const tenantId = c.get('activeTenantId')!;
    const { flag } = c.req.valid('json');

    // Idempotent upsert via PK conflict-ignore.
    try {
      await db.insert(tenant_feature_flags).values({
        tenant_id: tenantId,
        flag,
        enabled_by: activeUserId,
      });
    } catch {
      /* already enabled — fine */
    }

    const [row] = await db
      .select()
      .from(tenant_feature_flags)
      .where(
        and(
          eq(tenant_feature_flags.tenant_id, tenantId),
          eq(tenant_feature_flags.flag, flag),
        ),
      )
      .limit(1);

    return c.json(
      {
        flag,
        enabled_at: row ? row.enabled_at.toISOString() : new Date().toISOString(),
      },
      201,
    );
  },
);

app.openapi(
  createRoute({
    method: 'delete',
    path: '/v1/dev/feature-flags/{flag}',
    tags: ['dev'],
    summary: 'Disable a feature flag',
    security: securityCookieOrBearer,
    middleware: [requireTenantWorkspaceFromBearerOrSession] as const,
    request: {
      params: z.object({
        flag: z.string().openapi({ param: { name: 'flag', in: 'path' } }),
      }),
    },
    responses: {
      200: {
        description: 'Disabled.',
        content: {
          'application/json': {
            schema: z.object({ disabled: z.literal(true), flag: z.string() }),
          },
        },
      },
    },
  }),
  async (c) => {
    const tenantId = c.get('activeTenantId')!;
    const { flag } = c.req.valid('param');
    await db
      .delete(tenant_feature_flags)
      .where(
        and(
          eq(tenant_feature_flags.tenant_id, tenantId),
          eq(tenant_feature_flags.flag, flag),
        ),
      );
    return c.json({ disabled: true as const, flag }, 200);
  },
);

// Unused imports kept via void for future features.
void accounts;

export default app;

// Re-export for router registration.
export type { SessionEnv };
