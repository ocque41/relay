/**
 * /v1/user/* — end-user workspace routes. Every endpoint below requires a
 * session cookie AND an active workspace of { kind: 'user' }. Reads are
 * strictly scoped by `user_id = session.userId`; there is no admin bypass.
 *
 *   GET    /v1/user                    → identity + inbox + token counts
 *   GET    /v1/user/accounts           → accounts the user's agents provisioned
 *   GET    /v1/user/accounts/:id       → detail with api_keys (no key bytes)
 *   GET    /v1/user/signups            → signup timeline
 *   GET    /v1/user/keys               → flat api_keys view across accounts
 *   GET    /v1/user/agent-tokens       → list tokens
 *   POST   /v1/user/agent-tokens       → mint new token (plaintext once)
 *   DELETE /v1/user/agent-tokens/:id   → revoke
 *   GET    /v1/user/inbox              → recent email_messages
 *   GET    /v1/user/audit-log          → user-scoped audit rows
 *   GET    /v1/user/magic-links        → active share links
 *   POST   /v1/user/magic-links        → mint a new share link
 *   DELETE /v1/user/magic-links/:id    → revoke a share link
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { hashToken } from '../crypto';
import { DEFAULT_AGENT_TOKEN_DAYS, mintAgentToken } from '../auth/mint-token';
import { db } from '../db/index';
import {
  accounts,
  agents,
  api_keys,
  audit_log,
  email_messages,
  magic_links,
  signup_jobs,
  tenants,
  users,
} from '../db/schema';
import { sessionAuth, type SessionEnv } from '../auth/session';
import { requireUserWorkspace, type WorkspaceEnv } from '../auth/workspace';
import { resolveActiveUserWorkspace } from '../user-workspaces';

const app = new OpenAPIHono<WorkspaceEnv>();

const ErrorResponse = z.object({ error: z.string() });

// ---------------------------------------------------------------------------
// GET /v1/user — identity, inbox, counts
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/user',
    tags: ['user'],
    summary: 'Current user identity + inbox + counts',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth, requireUserWorkspace] as const,
    responses: {
      200: {
        description: 'User profile + quick aggregates.',
        content: {
          'application/json': {
            schema: z.object({
              userId: z.string().uuid(),
              email: z.string(),
              name: z.string().nullable(),
              inboxAlias: z.string().nullable(),
              inboxAddress: z.string().nullable(),
              counts: z.object({
                accounts: z.number(),
                activeAgents: z.number(),
                activeMagicLinks: z.number(),
              }),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const catchallDomain = process.env.CATCHALL_DOMAIN ?? 'mail.example.com';
    const ws = await resolveActiveUserWorkspace(session.userId);

    const [u] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    const [accountsCount, agentsCount, magicCount] = await Promise.all([
      db
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.user_id, session.userId),
            eq(accounts.user_workspace_id, ws.id),
          ),
        ),
      db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.user_id, session.userId),
            eq(agents.user_workspace_id, ws.id),
            isNull(agents.revoked_at),
          ),
        ),
      db
        .select({ id: magic_links.id })
        .from(magic_links)
        .where(
          and(
            eq(magic_links.user_id, session.userId),
            eq(magic_links.user_workspace_id, ws.id),
            isNull(magic_links.claimed_at),
            gt(magic_links.expires_at, new Date()),
          ),
        ),
    ]);

    return c.json(
      {
        userId: session.userId,
        email: u?.email ?? session.email,
        name: u?.name ?? null,
        inboxAlias: ws.inbox_alias,
        inboxAddress: ws.inbox_alias ? `${ws.inbox_alias}@${catchallDomain}` : null,
        counts: {
          accounts: accountsCount.length,
          activeAgents: agentsCount.length,
          activeMagicLinks: magicCount.length,
        },
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// GET /v1/user/accounts
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/user/accounts',
    tags: ['user'],
    summary: 'List the user\'s accounts',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth, requireUserWorkspace] as const,
    responses: {
      200: {
        description: 'Accounts owned by the user (credentials omitted).',
        content: {
          'application/json': {
            schema: z.array(
              z.object({
                id: z.string().uuid(),
                provider_id: z.string(),
                label: z.string(),
                email_alias: z.string().nullable(),
                status: z.string(),
                created_at: z.string().nullable(),
              }),
            ),
          },
        },
      },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const ws = await resolveActiveUserWorkspace(session.userId);
    const rows = await db
      .select({
        id: accounts.id,
        provider_id: accounts.provider_id,
        label: accounts.label,
        email_alias: accounts.email_alias,
        status: accounts.status,
        created_at: accounts.created_at,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.user_id, session.userId),
          eq(accounts.user_workspace_id, ws.id),
        ),
      )
      .orderBy(desc(accounts.created_at));

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
// GET /v1/user/accounts/:id
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/user/accounts/{id}',
    tags: ['user'],
    summary: 'Account detail + non-revoked API key bookkeeping rows',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth, requireUserWorkspace] as const,
    request: {
      params: z.object({
        id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
      }),
    },
    responses: {
      200: {
        description: 'Account + keys.',
        content: {
          'application/json': {
            schema: z.object({
              id: z.string().uuid(),
              provider_id: z.string(),
              label: z.string(),
              email_alias: z.string().nullable(),
              status: z.string(),
              created_at: z.string().nullable(),
              keys: z.array(
                z.object({
                  id: z.string().uuid(),
                  label: z.string(),
                  provider_key_id: z.string().nullable(),
                  created_at: z.string().nullable(),
                  last_revealed_at: z.string().nullable(),
                }),
              ),
            }),
          },
        },
      },
      404: { description: 'Not found.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const { id } = c.req.valid('param');
    const ws = await resolveActiveUserWorkspace(session.userId);

    const [acc] = await db
      .select({
        id: accounts.id,
        provider_id: accounts.provider_id,
        label: accounts.label,
        email_alias: accounts.email_alias,
        status: accounts.status,
        created_at: accounts.created_at,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.id, id),
          eq(accounts.user_id, session.userId),
          eq(accounts.user_workspace_id, ws.id),
        ),
      )
      .limit(1);
    if (!acc) return c.json({ error: 'account not found' }, 404);

    const keys = await db
      .select({
        id: api_keys.id,
        label: api_keys.label,
        provider_key_id: api_keys.provider_key_id,
        created_at: api_keys.created_at,
        last_revealed_at: api_keys.last_revealed_at,
      })
      .from(api_keys)
      .where(and(eq(api_keys.account_id, id), isNull(api_keys.revoked_at)))
      .orderBy(desc(api_keys.created_at));

    return c.json(
      {
        ...acc,
        created_at: acc.created_at ? new Date(acc.created_at).toISOString() : null,
        keys: keys.map((k) => ({
          id: k.id,
          label: k.label,
          provider_key_id: k.provider_key_id,
          created_at: k.created_at ? new Date(k.created_at).toISOString() : null,
          last_revealed_at: k.last_revealed_at
            ? new Date(k.last_revealed_at).toISOString()
            : null,
        })),
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// GET /v1/user/signups
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/user/signups',
    tags: ['user'],
    summary: 'Timeline of signups initiated by the user\'s agents',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth, requireUserWorkspace] as const,
    responses: {
      200: {
        description: 'Signup jobs.',
        content: {
          'application/json': {
            schema: z.array(
              z.object({
                id: z.string().uuid(),
                status: z.string(),
                provider_slug: z.string().nullable(),
                tenant_name: z.string().nullable(),
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
    const session = c.get('session')!;
    const ws = await resolveActiveUserWorkspace(session.userId);
    const rows = await db
      .select({
        id: signup_jobs.id,
        status: signup_jobs.status,
        provider_slug: signup_jobs.provider_slug,
        tenant_id: signup_jobs.tenant_id,
        account_id: signup_jobs.account_id,
        error: signup_jobs.error,
        created_at: signup_jobs.created_at,
      })
      .from(signup_jobs)
      .where(
        and(
          eq(signup_jobs.user_id, session.userId),
          eq(signup_jobs.user_workspace_id, ws.id),
        ),
      )
      .orderBy(desc(signup_jobs.created_at))
      .limit(100);

    // Hydrate tenant names in a single lookup
    const tenantIds = [...new Set(rows.map((r) => r.tenant_id).filter((x): x is string => !!x))];
    const tenantRows = tenantIds.length
      ? await db
          .select({ id: tenants.id, name: tenants.name })
          .from(tenants)
          .where(inArray(tenants.id, tenantIds))
      : [];
    const tenantName = new Map(tenantRows.map((t) => [t.id, t.name] as const));

    return c.json(
      rows.map((r) => ({
        id: r.id,
        status: r.status,
        provider_slug: r.provider_slug,
        tenant_name: r.tenant_id ? (tenantName.get(r.tenant_id) ?? null) : null,
        account_id: r.account_id,
        error: r.error,
        created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
      })),
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// GET /v1/user/keys
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/user/keys',
    tags: ['user'],
    summary: 'Flat view of non-revoked API keys across the user\'s accounts',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth, requireUserWorkspace] as const,
    responses: {
      200: {
        description: 'Keys (bytes never returned).',
        content: {
          'application/json': {
            schema: z.array(
              z.object({
                id: z.string().uuid(),
                label: z.string(),
                account_id: z.string().uuid(),
                account_label: z.string(),
                provider_id: z.string(),
                created_at: z.string().nullable(),
                last_revealed_at: z.string().nullable(),
              }),
            ),
          },
        },
      },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const ws = await resolveActiveUserWorkspace(session.userId);
    const rows = await db
      .select({
        id: api_keys.id,
        label: api_keys.label,
        account_id: api_keys.account_id,
        account_label: accounts.label,
        provider_id: accounts.provider_id,
        created_at: api_keys.created_at,
        last_revealed_at: api_keys.last_revealed_at,
      })
      .from(api_keys)
      .innerJoin(accounts, eq(accounts.id, api_keys.account_id))
      .where(
        and(
          eq(accounts.user_id, session.userId),
          eq(accounts.user_workspace_id, ws.id),
          isNull(api_keys.revoked_at),
        ),
      )
      .orderBy(desc(api_keys.created_at));

    return c.json(
      rows.map((r) => ({
        ...r,
        created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
        last_revealed_at: r.last_revealed_at
          ? new Date(r.last_revealed_at).toISOString()
          : null,
      })),
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// GET /v1/user/agent-tokens
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
    path: '/v1/user/agent-tokens',
    tags: ['user'],
    summary: 'List active agent tokens',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth, requireUserWorkspace] as const,
    responses: {
      200: {
        description: 'Tokens.',
        content: { 'application/json': { schema: z.array(AgentTokenPublic) } },
      },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const ws = await resolveActiveUserWorkspace(session.userId);
    const rows = await db
      .select({
        id: agents.id,
        label: agents.label,
        scopes: agents.scopes,
        created_at: agents.created_at,
        last_used_at: agents.last_used_at,
      })
      .from(agents)
      .where(
        and(
          eq(agents.user_id, session.userId),
          eq(agents.user_workspace_id, ws.id),
          isNull(agents.revoked_at),
        ),
      );

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
    path: '/v1/user/agent-tokens',
    tags: ['user'],
    summary: 'Mint a new agent token (plaintext returned once)',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth, requireUserWorkspace] as const,
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
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const { label, scopes, expires_in_days, never_expires } =
      c.req.valid('json');
    const ws = await resolveActiveUserWorkspace(session.userId);

    const minted = await mintAgentToken({
      userId: session.userId,
      userWorkspaceId: ws.id,
      label,
      // `admin` scope is reserved for platform operators — mintAgentToken strips
      // it by default (allowAdmin defaults to false).
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
        scopes: (scopes ?? []).filter((s) => s !== 'admin'),
        expires_at: minted.expiresAt ? minted.expiresAt.toISOString() : null,
      },
      201,
    );
  },
);

app.openapi(
  createRoute({
    method: 'delete',
    path: '/v1/user/agent-tokens/{id}',
    tags: ['user'],
    summary: 'Revoke an agent token',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth, requireUserWorkspace] as const,
    request: {
      params: z.object({
        id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
      }),
    },
    responses: {
      200: {
        description: 'Revoked.',
        content: {
          'application/json': {
            schema: z.object({ revoked: z.literal(true), id: z.string().uuid() }),
          },
        },
      },
      404: { description: 'Not found.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const { id } = c.req.valid('param');
    const ws = await resolveActiveUserWorkspace(session.userId);

    const [found] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, id),
          eq(agents.user_id, session.userId),
          eq(agents.user_workspace_id, ws.id),
        ),
      )
      .limit(1);
    if (!found) return c.json({ error: 'not found' }, 404);

    await db.update(agents).set({ revoked_at: new Date() }).where(eq(agents.id, id));
    return c.json({ revoked: true as const, id }, 200);
  },
);

// ---------------------------------------------------------------------------
// GET /v1/user/inbox
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/user/inbox',
    tags: ['user'],
    summary: 'Recent emails delivered to the user\'s Relay inbox',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth, requireUserWorkspace] as const,
    request: {
      query: z.object({
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: 'Messages.',
        content: {
          'application/json': {
            schema: z.array(
              z.object({
                id: z.string().uuid(),
                to: z.string(),
                from: z.string(),
                subject: z.string().nullable(),
                body_text: z.string().nullable(),
                received_at: z.string().nullable(),
              }),
            ),
          },
        },
      },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const { limit } = c.req.valid('query');
    const cap = Math.min(100, Math.max(1, parseInt(limit ?? '25', 10) || 25));
    const ws = await resolveActiveUserWorkspace(session.userId);

    const rows = await db
      .select({
        id: email_messages.id,
        to: email_messages.to_address,
        from: email_messages.from_address,
        subject: email_messages.subject,
        body_text: email_messages.body_text,
        received_at: email_messages.received_at,
      })
      .from(email_messages)
      .where(
        and(
          eq(email_messages.user_id, session.userId),
          eq(email_messages.user_workspace_id, ws.id),
        ),
      )
      .orderBy(desc(email_messages.received_at))
      .limit(cap);

    return c.json(
      rows.map((r) => ({
        ...r,
        received_at: r.received_at ? new Date(r.received_at).toISOString() : null,
      })),
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// GET /v1/user/audit-log
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/user/audit-log',
    tags: ['user'],
    summary: 'Audit rows scoped to the current user',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth, requireUserWorkspace] as const,
    request: {
      query: z.object({
        limit: z.string().optional(),
        offset: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: 'Entries.',
        content: {
          'application/json': {
            schema: z.object({
              entries: z.array(
                z.object({
                  id: z.string().uuid(),
                  action: z.string(),
                  target: z.string().nullable(),
                  metadata: z.record(z.string(), z.unknown()).nullable(),
                  created_at: z.string().nullable(),
                }),
              ),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const { limit, offset } = c.req.valid('query');
    const cap = Math.min(200, Math.max(1, parseInt(limit ?? '50', 10) || 50));
    const skip = Math.max(0, parseInt(offset ?? '0', 10) || 0);
    const ws = await resolveActiveUserWorkspace(session.userId);

    const entries = await db
      .select({
        id: audit_log.id,
        action: audit_log.action,
        target: audit_log.target,
        metadata: audit_log.metadata,
        created_at: audit_log.created_at,
      })
      .from(audit_log)
      .where(
        and(
          eq(audit_log.user_id, session.userId),
          // audit_log.user_workspace_id is nullable (legacy rows). Include
          // rows that match the active workspace OR predate the column so
          // historical audit is still visible after workspace rollout.
          or(
            eq(audit_log.user_workspace_id, ws.id),
            isNull(audit_log.user_workspace_id),
          ),
        ),
      )
      .orderBy(desc(audit_log.created_at))
      .limit(cap)
      .offset(skip);

    return c.json(
      {
        entries: entries.map((e) => ({
          id: e.id,
          action: e.action,
          target: e.target,
          metadata: (e.metadata ?? null) as Record<string, unknown> | null,
          created_at: e.created_at ? new Date(e.created_at).toISOString() : null,
        })),
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// GET /v1/user/magic-links
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/user/magic-links',
    tags: ['user'],
    summary: 'List active share links',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth, requireUserWorkspace] as const,
    responses: {
      200: {
        description: 'Active links (plaintext tokens never returned).',
        content: {
          'application/json': {
            schema: z.array(
              z.object({
                id: z.string().uuid(),
                purpose: z.string(),
                expires_at: z.string(),
                claimed_at: z.string().nullable(),
                max_uses: z.number(),
                used_count: z.number(),
                created_at: z.string().nullable(),
              }),
            ),
          },
        },
      },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const ws = await resolveActiveUserWorkspace(session.userId);
    const rows = await db
      .select({
        id: magic_links.id,
        purpose: magic_links.purpose,
        expires_at: magic_links.expires_at,
        claimed_at: magic_links.claimed_at,
        max_uses: magic_links.max_uses,
        used_count: magic_links.used_count,
        created_at: magic_links.created_at,
      })
      .from(magic_links)
      .where(
        and(
          eq(magic_links.user_id, session.userId),
          eq(magic_links.user_workspace_id, ws.id),
          gt(magic_links.expires_at, new Date()),
        ),
      )
      .orderBy(desc(magic_links.created_at));

    return c.json(
      rows.map((r) => ({
        id: r.id,
        purpose: r.purpose,
        expires_at: r.expires_at.toISOString(),
        claimed_at: r.claimed_at ? r.claimed_at.toISOString() : null,
        max_uses: r.max_uses,
        used_count: r.used_count,
        created_at: r.created_at ? r.created_at.toISOString() : null,
      })),
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// POST /v1/user/magic-links
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/user/magic-links',
    tags: ['user'],
    summary: 'Mint a new share link (plaintext token returned once)',
    description:
      'Creates a session-less URL that opens a read-only summary of the user\'s Relay data. Default TTL 10 minutes, single-use. Plaintext token is never persisted — only its SHA-256 hash.',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth, requireUserWorkspace] as const,
    request: {
      body: {
        required: false,
        content: {
          'application/json': {
            schema: z.object({
              ttl_minutes: z.number().int().min(1).max(60).optional(),
              max_uses: z.number().int().min(1).max(10).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Link minted.',
        content: {
          'application/json': {
            schema: z.object({
              id: z.string().uuid(),
              url: z.string(),
              expires_at: z.string(),
            }),
          },
        },
      },
      402: {
        description: 'Token balance too low to cover share_link; top up to retry.',
        content: {
          'application/json': {
            schema: z.object({
              error: z.string(),
              required: z.number(),
              available: z.number(),
              topup_url: z.string(),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    let body: { ttl_minutes?: number; max_uses?: number } = {};
    try {
      body = c.req.valid('json');
    } catch {
      /* body optional */
    }
    const ttlMin = body.ttl_minutes ?? 10;
    const maxUses = body.max_uses ?? 1;

    // Share-link creation is free under the integrator-only revenue model.
    const token = 'mls_' + randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000);

    const ws = await resolveActiveUserWorkspace(session.userId);
    const [inserted] = await db
      .insert(magic_links)
      .values({
        user_id: session.userId,
        user_workspace_id: ws.id,
        token_hash: tokenHash,
        purpose: 'dashboard_summary',
        expires_at: expiresAt,
        max_uses: maxUses,
      })
      .returning({ id: magic_links.id });

    const base =
      process.env.APP_BASE_URL ??
      (process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.replace(/^https?:\/\//, '')}`
        : 'http://localhost:3000');

    return c.json(
      {
        id: inserted.id,
        url: `${base}/share/${token}`,
        expires_at: expiresAt.toISOString(),
      },
      201,
    );
  },
);

app.openapi(
  createRoute({
    method: 'delete',
    path: '/v1/user/magic-links/{id}',
    tags: ['user'],
    summary: 'Revoke a share link',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth, requireUserWorkspace] as const,
    request: {
      params: z.object({
        id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
      }),
    },
    responses: {
      200: {
        description: 'Revoked.',
        content: {
          'application/json': {
            schema: z.object({ revoked: z.literal(true), id: z.string().uuid() }),
          },
        },
      },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const { id } = c.req.valid('param');
    const ws = await resolveActiveUserWorkspace(session.userId);
    await db
      .delete(magic_links)
      .where(
        and(
          eq(magic_links.id, id),
          eq(magic_links.user_id, session.userId),
          eq(magic_links.user_workspace_id, ws.id),
        ),
      );
    return c.json({ revoked: true as const, id }, 200);
  },
);

// Silence unused import warning on `or` (reserved for future combined filters).
void or;

export default app;

// Export of SessionEnv so other modules can compose it; keeps TypeScript happy.
export type { SessionEnv };
