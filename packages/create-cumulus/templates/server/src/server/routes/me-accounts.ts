/**
 * /v1/me/accounts/* — session-authed self-service for signed-in humans.
 *
 *   GET    /v1/me/accounts                                       → list my accounts
 *   GET    /v1/me/accounts/:id                                   → account detail (metadata only)
 *   GET    /v1/me/accounts/:id/api-keys                          → list keys + last_used_at
 *   POST   /v1/me/accounts/:id/api-keys                          → mint a new key (plaintext once)
 *   POST   /v1/me/accounts/:id/api-keys/:keyId/rotate            → mint new + revoke old (retrieval = rotation)
 *
 * Zero-retention model: Relay never persists plaintext key bytes. The
 * "retrieve my key" dashboard button is really a rotate: the old row is
 * revoked, a fresh key is minted at the provider, and the plaintext is
 * returned exactly once. If the user loses the new plaintext, the only
 * recovery path is to rotate again.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, isNull } from 'drizzle-orm';
import { sessionAuth, type SessionEnv } from '../auth/session';
import { db } from '../db/index';
import { accounts, api_keys } from '../db/schema';
import {
  AccountNotFound,
  ApiKeyNotFound,
  ProviderNotRegistered,
  mintApiKeyForUser,
  rotateApiKeyForUser,
} from '../api-keys/ops';
import { resolveActiveUserWorkspace } from '../user-workspaces';

const app = new OpenAPIHono<SessionEnv>();

const ErrorResponse = z.object({ error: z.string() });

const Account = z
  .object({
    id: z.string().uuid(),
    provider_id: z.string(),
    external_id: z.string(),
    label: z.string(),
    email_alias: z.string().nullable(),
    status: z.string(),
    created_at: z.string().nullable(),
  })
  .openapi('MeAccount');

const AccountList = z.array(Account).openapi('MeAccountList');

const ApiKey = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    label: z.string(),
    provider_key_id: z.string().nullable().optional(),
    last_revealed_at: z.string().nullable().optional(),
    last_used_at: z.string().nullable().optional(),
    created_at: z.string().nullable(),
    revoked_at: z.string().nullable().optional(),
  })
  .openapi('MeApiKey');

const ApiKeyList = z.array(ApiKey).openapi('MeApiKeyList');

const ApiKeyCreateBody = z
  .object({ label: z.string().optional() })
  .openapi('MeApiKeyCreateBody');

const ApiKeyCreateResponse = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    label: z.string(),
    key: z.string().openapi({
      description:
        'Plaintext API key from the provider. Returned EXACTLY ONCE. Relay does not persist the key bytes.',
    }),
    created_at: z.string().nullable(),
  })
  .openapi('MeApiKeyCreateResponse');

const RotateResponse = z
  .object({
    rotated: z.literal(true),
    revoked_key_id: z.string().uuid(),
    new_key: ApiKeyCreateResponse,
    note: z.string(),
  })
  .openapi('MeApiKeyRotateResponse');


// ---------------------------------------------------------------------------
// GET /v1/me/accounts
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/me/accounts',
    tags: ['me', 'accounts'],
    summary: 'List accounts I own',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    responses: {
      200: {
        description: 'Accounts (credentials omitted).',
        content: { 'application/json': { schema: AccountList } },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const ws = await resolveActiveUserWorkspace(session.userId);
    const rows = await db
      .select({
        id: accounts.id,
        provider_id: accounts.provider_id,
        external_id: accounts.external_id,
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
      );
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
// GET /v1/me/accounts/:id
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/me/accounts/{id}',
    tags: ['me', 'accounts'],
    summary: 'Account detail (metadata only)',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    request: {
      params: z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) }),
    },
    responses: {
      200: { description: 'Account.', content: { 'application/json': { schema: Account } } },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Not found.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const { id } = c.req.valid('param');
    const ws = await resolveActiveUserWorkspace(session.userId);

    const rows = await db
      .select({
        id: accounts.id,
        provider_id: accounts.provider_id,
        external_id: accounts.external_id,
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

    if (rows.length === 0) return c.json({ error: 'account not found' }, 404);
    const r = rows[0];
    return c.json(
      { ...r, created_at: r.created_at ? new Date(r.created_at).toISOString() : null },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// GET /v1/me/accounts/:id/api-keys
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/me/accounts/{id}/api-keys',
    tags: ['me', 'api-keys'],
    summary: 'List my API keys for an account',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    request: {
      params: z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) }),
    },
    responses: {
      200: {
        description:
          'Non-revoked key bookkeeping. `last_used_at` reflects Relay-observable use (mint, delivery, rotation, legacy reveal).',
        content: { 'application/json': { schema: ApiKeyList } },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Not found.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const { id } = c.req.valid('param');
    const ws = await resolveActiveUserWorkspace(session.userId);

    const ownership = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.id, id),
          eq(accounts.user_id, session.userId),
          eq(accounts.user_workspace_id, ws.id),
        ),
      )
      .limit(1);
    if (ownership.length === 0) return c.json({ error: 'account not found' }, 404);

    const rows = await db
      .select({
        id: api_keys.id,
        account_id: api_keys.account_id,
        label: api_keys.label,
        provider_key_id: api_keys.provider_key_id,
        last_revealed_at: api_keys.last_revealed_at,
        last_used_at: api_keys.last_used_at,
        created_at: api_keys.created_at,
        revoked_at: api_keys.revoked_at,
      })
      .from(api_keys)
      .where(and(eq(api_keys.account_id, id), isNull(api_keys.revoked_at)));

    return c.json(
      rows.map((k) => ({
        ...k,
        last_revealed_at: k.last_revealed_at
          ? new Date(k.last_revealed_at).toISOString()
          : null,
        last_used_at: k.last_used_at ? new Date(k.last_used_at).toISOString() : null,
        created_at: k.created_at ? new Date(k.created_at).toISOString() : null,
        revoked_at: k.revoked_at ? new Date(k.revoked_at).toISOString() : null,
      })),
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// POST /v1/me/accounts/:id/api-keys
//
// Mints an ADDITIONAL key without touching the existing ones. Plaintext
// returned once; not stored.
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/me/accounts/{id}/api-keys',
    tags: ['me', 'api-keys'],
    summary: 'Mint a new API key (plaintext returned once, not stored)',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    request: {
      params: z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) }),
      body: {
        required: false,
        content: { 'application/json': { schema: ApiKeyCreateBody } },
      },
    },
    responses: {
      201: {
        description: 'Minted key returned once; not stored.',
        content: { 'application/json': { schema: ApiKeyCreateResponse } },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Not found.', content: { 'application/json': { schema: ErrorResponse } } },
      500: { description: 'Server error.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const { id } = c.req.valid('param');

    let parsedBody: { label?: string } = {};
    try {
      parsedBody = c.req.valid('json') as { label?: string };
    } catch {
      /* body is optional */
    }
    const label = parsedBody?.label ?? `key-${Date.now()}`;

    try {
      const minted = await mintApiKeyForUser(
        { userId: session.userId, source: 'session' },
        id,
        label,
      );
      return c.json(minted, 201);
    } catch (err) {
      if (err instanceof AccountNotFound) return c.json({ error: 'account not found' }, 404);
      if (err instanceof ProviderNotRegistered) return c.json({ error: err.message }, 500);
      throw err;
    }
  },
);

// ---------------------------------------------------------------------------
// POST /v1/me/accounts/:id/api-keys/:keyId/rotate
//
// The canonical "retrieve my key" path for signed-in humans. Mints a fresh
// key at the provider, returns the plaintext once, marks the old bookkeeping
// row revoked, and best-effort revokes the old key at the provider. Losing
// the returned plaintext means you rotate again — Relay never stores bytes.
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/me/accounts/{id}/api-keys/{keyId}/rotate',
    tags: ['me', 'api-keys'],
    summary: 'Rotate an API key (mint new + revoke old; plaintext returned once)',
    description:
      'Retrieve-my-key = rotate. Mints a new key via the provider, returns the plaintext EXACTLY ONCE, marks the old key revoked, and attempts best-effort provider-side revocation of the old key (logs and continues on failure).',
    security: [{ cookieAuth: [] }],
    middleware: [sessionAuth] as const,
    request: {
      params: z.object({
        id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
        keyId: z.string().uuid().openapi({ param: { name: 'keyId', in: 'path' } }),
      }),
    },
    responses: {
      200: {
        description: 'Rotation complete.',
        content: { 'application/json': { schema: RotateResponse } },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Not found.', content: { 'application/json': { schema: ErrorResponse } } },
      500: { description: 'Server error.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const session = c.get('session')!;
    const { id, keyId } = c.req.valid('param');

    try {
      const result = await rotateApiKeyForUser(
        { userId: session.userId, source: 'session' },
        id,
        keyId,
      );
      return c.json(result, 200);
    } catch (err) {
      if (err instanceof AccountNotFound) return c.json({ error: 'account not found' }, 404);
      if (err instanceof ApiKeyNotFound) return c.json({ error: 'api key not found' }, 404);
      if (err instanceof ProviderNotRegistered) return c.json({ error: err.message }, 500);
      throw err;
    }
  },
);

export default app;
