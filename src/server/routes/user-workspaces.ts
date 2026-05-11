/**
 * /v1/user/workspaces — personal (user) workspace CRUD.
 *
 * Read & write scopes:
 *   - GET    /v1/user/workspaces              — list every workspace the caller owns
 *   - POST   /v1/user/workspaces              — create a new workspace
 *   - POST   /v1/user/workspaces/:id/switch   — make this workspace the caller's active one
 *   - POST   /v1/user/workspaces/:id/rename   — rename
 *   - DELETE /v1/user/workspaces/:id          — delete (requires confirm_name)
 *
 * Auth: cookie session OR user-scoped bearer (via requireUserFromBearerOrSession).
 * /switch is cookie-only — a bearer token is pinned to a specific workspace at
 * creation time, so "which one is active" is only meaningful for the interactive
 * shell.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { bearerAuth, type AppEnv } from '../auth';
import { sessionAuth, type SessionEnv } from '../auth/session';
import { requireUserFromBearerOrSession, type WorkspaceEnv } from '../auth/workspace';
import {
  createUserWorkspace,
  deleteUserWorkspace,
  listUserWorkspaces,
  renameUserWorkspace,
  resolveActiveUserWorkspace,
  switchActiveUserWorkspace,
  UserWorkspaceError,
} from '../user-workspaces';

const app = new OpenAPIHono<WorkspaceEnv>();
const ErrorResponse = z.object({ error: z.string() });

const WorkspaceItem = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    is_default: z.boolean(),
    inbox_alias: z.string().nullable(),
    is_active: z.boolean().openapi({
      description:
        'True when this workspace is the caller\'s currently-active workspace.',
    }),
    created_at: z.string().nullable(),
  })
  .openapi('UserWorkspace');

const securityCookieOrBearer: Array<Record<string, string[]>> = [
  { cookieAuth: [] },
  { bearerAuth: [] },
];

function mapError(e: unknown): { status: 400 | 403 | 404 | 409; body: { error: string } } {
  if (e instanceof UserWorkspaceError) {
    if (e.kind === 'not_found') return { status: 404, body: { error: e.message } };
    if (e.kind === 'forbidden') return { status: 403, body: { error: e.message } };
    if (e.kind === 'slug_taken') return { status: 409, body: { error: e.message } };
    if (
      e.kind === 'is_default' ||
      e.kind === 'last_remaining' ||
      e.kind === 'limit_reached' ||
      e.kind === 'name_mismatch' ||
      e.kind === 'invalid_name' ||
      e.kind === 'invalid_slug'
    ) {
      return { status: 400, body: { error: e.message } };
    }
  }
  return {
    status: 400,
    body: { error: e instanceof Error ? e.message : String(e) },
  };
}

// ---------------------------------------------------------------------------
// GET /v1/user/workspaces
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/user/workspaces',
    tags: ['user-workspaces'],
    summary: 'List the caller\'s personal workspaces',
    security: securityCookieOrBearer,
    middleware: [requireUserFromBearerOrSession] as const,
    responses: {
      200: {
        description: 'Workspaces owned by the caller.',
        content: {
          'application/json': {
            schema: z.object({
              active_id: z.string().uuid(),
              workspaces: z.array(WorkspaceItem),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const userId = c.get('activeUserId')!;
    const [rows, active] = await Promise.all([
      listUserWorkspaces(userId),
      resolveActiveUserWorkspace(userId),
    ]);
    return c.json(
      {
        active_id: active.id,
        workspaces: rows.map((w) => ({
          id: w.id,
          name: w.name,
          slug: w.slug,
          is_default: w.is_default,
          inbox_alias: w.inbox_alias,
          is_active: w.id === active.id,
          created_at: w.created_at ? new Date(w.created_at).toISOString() : null,
        })),
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// POST /v1/user/workspaces
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/user/workspaces',
    tags: ['user-workspaces'],
    summary: 'Create a new personal workspace',
    security: securityCookieOrBearer,
    middleware: [requireUserFromBearerOrSession] as const,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              name: z.string().min(1).max(80),
              slug: z
                .string()
                .regex(/^[a-z0-9-]+$/)
                .min(1)
                .max(40)
                .optional(),
              make_active: z
                .boolean()
                .optional()
                .describe(
                  'If true, the new workspace becomes the caller\'s active workspace (cookie sessions only — bearer tokens are immutably pinned).',
                ),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Created.',
        content: {
          'application/json': { schema: WorkspaceItem },
        },
      },
      400: {
        description: 'Invalid name / slug, or limit reached.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      403: {
        description: 'Forbidden.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      404: {
        description: 'Not found.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      409: {
        description: 'Slug already used in this account.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const userId = c.get('activeUserId')!;
    const body = c.req.valid('json');
    try {
      const row = await createUserWorkspace({
        userId,
        name: body.name,
        slug: body.slug,
        makeActive: !!body.make_active,
      });
      const active = await resolveActiveUserWorkspace(userId);
      return c.json(
        {
          id: row.id,
          name: row.name,
          slug: row.slug,
          is_default: row.is_default,
          inbox_alias: row.inbox_alias,
          is_active: row.id === active.id,
          created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
        },
        201,
      );
    } catch (e) {
      const { status, body: err } = mapError(e);
      return c.json(err, status);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /v1/user/workspaces/:id/switch
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/user/workspaces/{id}/switch',
    tags: ['user-workspaces'],
    summary: 'Make this the caller\'s active workspace',
    description:
      'Sets `users.active_user_workspace_id`. Cookie sessions only — bearer tokens are immutably pinned to the workspace they were minted in, so this call is rejected for bearer callers with 400.',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    request: {
      params: z.object({
        id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
      }),
    },
    responses: {
      200: {
        description: 'Switched.',
        content: { 'application/json': { schema: WorkspaceItem } },
      },
      400: {
        description: 'Bad request.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      403: {
        description: 'Forbidden.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      404: {
        description: 'Workspace not found or not owned by the caller.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      409: {
        description: 'Conflict.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const { id } = c.req.valid('param');
    try {
      const row = await switchActiveUserWorkspace(session.userId, id);
      return c.json(
        {
          id: row.id,
          name: row.name,
          slug: row.slug,
          is_default: row.is_default,
          inbox_alias: row.inbox_alias,
          is_active: true,
          created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
        },
        200,
      );
    } catch (e) {
      const { status, body } = mapError(e);
      return c.json(body, status);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /v1/user/workspaces/:id/rename
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/user/workspaces/{id}/rename',
    tags: ['user-workspaces'],
    summary: 'Rename a personal workspace',
    security: securityCookieOrBearer,
    middleware: [requireUserFromBearerOrSession] as const,
    request: {
      params: z.object({
        id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
      }),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({ name: z.string().min(1).max(80) }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Renamed.',
        content: {
          'application/json': {
            schema: z.object({ id: z.string().uuid(), name: z.string() }),
          },
        },
      },
      400: {
        description: 'Invalid name.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      403: {
        description: 'Forbidden.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      404: {
        description: 'Workspace not found.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      409: {
        description: 'Conflict.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const userId = c.get('activeUserId')!;
    const { id } = c.req.valid('param');
    const { name } = c.req.valid('json');
    try {
      await renameUserWorkspace(userId, id, name);
      return c.json({ id, name: name.trim() }, 200);
    } catch (e) {
      const { status, body } = mapError(e);
      return c.json(body, status);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /v1/user/workspaces/:id
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'delete',
    path: '/v1/user/workspaces/{id}',
    tags: ['user-workspaces'],
    summary: 'Delete a personal workspace (hard)',
    description:
      'Permanently deletes the workspace and every row scoped to it (accounts, keys, inbox, signup history). The default workspace cannot be deleted — make another workspace the default first. Requires `confirm_name` to equal the workspace name exactly.',
    security: securityCookieOrBearer,
    middleware: [requireUserFromBearerOrSession] as const,
    request: {
      params: z.object({
        id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
      }),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({ confirm_name: z.string().min(1) }),
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
              id: z.string().uuid(),
            }),
          },
        },
      },
      400: {
        description:
          'Cannot delete (is_default, last remaining, confirm_name mismatch).',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      403: {
        description: 'Forbidden.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      404: {
        description: 'Workspace not found.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      409: {
        description: 'Conflict.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const userId = c.get('activeUserId')!;
    const { id } = c.req.valid('param');
    const { confirm_name } = c.req.valid('json');
    try {
      await deleteUserWorkspace({ userId, workspaceId: id, confirmName: confirm_name });
      return c.json({ deleted: true as const, id }, 200);
    } catch (e) {
      const { status, body } = mapError(e);
      return c.json(body, status);
    }
  },
);

export default app;
