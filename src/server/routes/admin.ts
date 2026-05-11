/**
 * /v1/admin/* — ops-only routes gated on the `admin` bearer scope.
 *
 * Currently surfaces the abuse-limit override. Future admin utilities
 * (tenant suspension, quota adjustment, audit export) land here.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { bearerAuth, type AppEnv } from '../auth';
import { writeRateLimit } from '../rate-limit';
import { db } from '../db/index';
import { users } from '../db/schema';
import { recordAudit } from '../audit';

const app = new OpenAPIHono<AppEnv>();

const ErrorResponse = z.object({ error: z.string() });

// ---------------------------------------------------------------------------
// POST /v1/admin/users/:id/raise-limit
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/admin/users/{id}/raise-limit',
    tags: ['admin'],
    summary: 'Raise a user\'s monthly signup cap (admin scope only)',
    description:
      'Sets `users.signup_limit_override`. Pass `limit: null` to clear the override and fall back to USER_SIGNUP_MONTHLY_LIMIT.',
    security: [{ bearerAuth: [] }],
    middleware: [bearerAuth, writeRateLimit] as const,
    request: {
      params: z.object({
        id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
      }),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              limit: z.number().int().positive().nullable(),
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
            schema: z.object({
              user_id: z.string().uuid(),
              signup_limit_override: z.number().int().nullable(),
            }),
          },
        },
      },
      401: {
        description: 'Unauthorized.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      403: {
        description: 'Admin scope required.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      404: {
        description: 'User not found.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const agent = c.get('agent');
    if (!agent.scopes.includes('admin')) {
      return c.json({ error: 'admin_scope_required' }, 403);
    }

    const { id } = c.req.valid('param');
    const { limit } = c.req.valid('json');

    const [updated] = await db
      .update(users)
      .set({ signup_limit_override: limit })
      .where(eq(users.id, id))
      .returning({
        id: users.id,
        signup_limit_override: users.signup_limit_override,
      });

    if (!updated) return c.json({ error: 'user_not_found' }, 404);

    await recordAudit(
      agent.agentId,
      'admin.raise_signup_limit',
      id,
      { limit },
      { user_id: id },
    );

    return c.json(
      {
        user_id: updated.id,
        signup_limit_override: updated.signup_limit_override,
      },
      200,
    );
  },
);

export default app;
