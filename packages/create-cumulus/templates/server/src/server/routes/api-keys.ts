import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, isNull } from 'drizzle-orm';
import { bearerAuth, type AppEnv } from '../auth';
import { readRateLimit, writeRateLimit } from '../rate-limit';
import { recordAudit } from '../audit';
import { callerUserId } from '../auth/caller';
import { db } from '../db/index';
import { accounts, api_keys } from '../db/schema';
import { getProvider } from '../providers/index';
import { decrypt } from '../crypto';
import type { NeonAccount } from '../providers/neon';
import {
  AccountNotFound,
  ApiKeyNotFound,
  ProviderNotRegistered,
  rotateApiKeyForUser,
} from '../api-keys/ops';
import {
  chargeAction,
  refundAction,
  type ChargeReceipt,
} from '../billing/charge-action';
import { TenantInactive } from '../billing/charge';
import { IntegratorQuotaExhausted } from '../billing/quota';
import { UserRateLimited } from '../abuse/signup-limit';
import { checkKeyRevealLimit } from '../abuse/key-reveal-limit';

const app = new OpenAPIHono<AppEnv>();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const ApiKey = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    label: z.string(),
    provider_key_id: z.string().nullable().optional(),
    last_revealed_at: z.string().nullable().optional(),
    last_used_at: z
      .string()
      .nullable()
      .optional()
      .openapi({
        description:
          'Most recent Relay-observable use: mint, signup delivery, legacy reveal, or rotation. Does NOT track direct provider-side calls.',
      }),
    created_at: z.string().nullable(),
    revoked_at: z.string().nullable().optional(),
  })
  .openapi('ApiKey');

const ApiKeyList = z.array(ApiKey).openapi('ApiKeyList');

const ApiKeyCreateBody = z
  .object({ label: z.string().optional() })
  .openapi('ApiKeyCreateBody');

const ApiKeyCreateResponse = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    label: z.string(),
    key: z
      .string()
      .openapi({
        description:
          'Plaintext API key from the provider. Returned EXACTLY ONCE. Relay does not persist the key bytes — hand it to the user in-chat and forget it.',
      }),
    created_at: z.string().nullable(),
  })
  .openapi('ApiKeyCreateResponse');

const ErrorResponse = z.object({ error: z.string() });
const RateLimitResponse = z.object({
  error: z.string(),
  retryAfter: z.number().optional(),
});

// ---------------------------------------------------------------------------
// GET /v1/accounts/:id/api-keys
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/accounts/{id}/api-keys',
    tags: ['api-keys'],
    summary: 'List API keys for an account',
    security: [{ bearerAuth: [] }],
    middleware: [bearerAuth, readRateLimit] as const,
    request: {
      params: z.object({
        id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
      }),
    },
    responses: {
      200: {
        description:
          'Non-revoked API key bookkeeping rows. Key bytes are never returned here; they are revealed only at mint time.',
        content: { 'application/json': { schema: ApiKeyList } },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Account not found.', content: { 'application/json': { schema: ErrorResponse } } },
      429: { description: 'Rate limit exceeded.', content: { 'application/json': { schema: RateLimitResponse } } },
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const uid = await callerUserId(c.get('agent').agentId);
    if (!uid) return c.json({ error: 'agent_token is not associated with a user' }, 401);

    const accountRows = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.user_id, uid)))
      .limit(1);

    if (accountRows.length === 0) return c.json({ error: 'account not found' }, 404);

    const keys = await db
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

    const mapped = keys.map((k) => ({
      ...k,
      last_revealed_at: k.last_revealed_at
        ? new Date(k.last_revealed_at).toISOString()
        : null,
      last_used_at: k.last_used_at ? new Date(k.last_used_at).toISOString() : null,
      created_at: k.created_at ? new Date(k.created_at).toISOString() : null,
      revoked_at: k.revoked_at ? new Date(k.revoked_at).toISOString() : null,
    }));

    return c.json(mapped, 200);
  },
);

// ---------------------------------------------------------------------------
// POST /v1/accounts/:id/api-keys
//
// Mints a fresh key on the provider and returns the plaintext EXACTLY ONCE.
// Relay does NOT persist the key bytes — only the bookkeeping row (label +
// provider_key_id) so future revocations have a handle.
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/accounts/{id}/api-keys',
    tags: ['api-keys'],
    summary: 'Mint a new API key (plaintext returned once, not stored)',
    description:
      "Mints a new API key on the provider. Relay returns the plaintext EXACTLY ONCE in the response and persists ONLY the label + provider_key_id so the key can be revoked later. Agents must hand the plaintext to the user in-chat; Relay does not retain a copy.",
    security: [{ bearerAuth: [] }],
    middleware: [bearerAuth, writeRateLimit] as const,
    request: {
      params: z.object({
        id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
      }),
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
      404: { description: 'Account not found.', content: { 'application/json': { schema: ErrorResponse } } },
      429: { description: 'Rate limit exceeded or quota exhausted.', content: { 'application/json': { schema: RateLimitResponse } } },
      500: { description: 'Server error.', content: { 'application/json': { schema: ErrorResponse } } },
      503: {
        description: "Integrator's Relay subscription is inactive; their product is temporarily unavailable.",
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const agent = c.get('agent');
    const agentId = agent.agentId;
    const uid = await callerUserId(agentId);
    if (!uid) return c.json({ error: 'agent_token is not associated with a user' }, 401);

    const accountRows = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.user_id, uid)))
      .limit(1);

    if (accountRows.length === 0) return c.json({ error: 'account not found' }, 404);
    const account = accountRows[0];

    // Body is optional; label may be missing.
    let parsedBody: { label?: string } = {};
    try {
      parsedBody = c.req.valid('json') as { label?: string };
    } catch {
      /* body is optional */
    }
    const label = parsedBody?.label ?? `key-${Date.now()}`;

    const provider = await getProvider(account.provider_id);
    if (!provider) {
      return c.json(
        { error: `provider "${account.provider_id}" not registered` },
        500,
      );
    }

    // Charge the action against the integrator quota (BILLING_METER=actions)
    // and the per-user-month action cap. Refunded if the provider call
    // throws below.
    let receipt: ChargeReceipt;
    try {
      receipt = await chargeAction({
        tenantId: account.tenant_id,
        userId: uid,
        providerId: account.provider_id,
        action: 'mint',
      });
    } catch (err) {
      if (err instanceof TenantInactive) {
        return c.json({ error: `tenant_${err.state}` }, 503);
      }
      if (err instanceof UserRateLimited || err instanceof IntegratorQuotaExhausted) {
        return c.json({ error: 'rate_limit_exceeded' }, 429);
      }
      throw err;
    }

    const providerAccount: NeonAccount & { accountId: string } = {
      projectId: account.external_id,
      accountId: account.external_id,
      name: account.label,
      connectionUri: '',
    };
    if (account.credentials_enc) {
      try {
        providerAccount.connectionUri = decrypt(account.credentials_enc).toString('utf8');
      } catch {
        /* ignore — createApiKey may not need it */
      }
    }

    let rawKey: string;
    let providerKeyId: string | undefined;
    let newKey: {
      id: string;
      account_id: string;
      label: string;
      created_at: Date | string | null;
    };
    try {
      const minted = await provider.createApiKey(
        { db },
        providerAccount as never,
        label,
      );
      rawKey = minted.key;
      providerKeyId = minted.providerKeyId ?? undefined;

      [newKey] = await db
        .insert(api_keys)
        .values({
          account_id: id,
          label,
          // key_enc intentionally omitted — zero-retention policy.
          last_used_at: new Date(),
          ...(providerKeyId != null ? { provider_key_id: providerKeyId } : {}),
        })
        .returning({
          id: api_keys.id,
          account_id: api_keys.account_id,
          label: api_keys.label,
          created_at: api_keys.created_at,
        });
    } catch (err) {
      await refundAction({ tenantId: account.tenant_id, userId: uid, receipt });
      throw err;
    }

    await recordAudit(
      agentId,
      'key_create',
      newKey.id,
      { account_id: id, label },
      { user_id: account.user_id, tenant_id: account.tenant_id },
    );

    return c.json(
      {
        id: newKey.id,
        account_id: newKey.account_id,
        label: newKey.label,
        key: rawKey,
        created_at: newKey.created_at
          ? new Date(newKey.created_at).toISOString()
          : null,
      },
      201,
    );
  },
);

// ---------------------------------------------------------------------------
// POST /v1/accounts/:id/api-keys/:keyId/reveal
//
// Legacy endpoint preserved for rows created before the zero-retention
// policy. If key_enc is still populated, decrypt-and-scrub on first call so
// the key cannot be revealed twice. New rows cannot be revealed — the response
// directs the caller to mint a new key instead.
// ---------------------------------------------------------------------------
const ApiKeyRevealResponse = z
  .object({
    id: z.string().uuid(),
    label: z.string(),
    key: z.string().openapi({ description: 'Plaintext API key (legacy reveal).' }),
    revealed_at: z.string(),
    note: z.string(),
  })
  .openapi('ApiKeyRevealResponse');

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/accounts/{id}/api-keys/{keyId}/reveal',
    tags: ['api-keys'],
    summary: 'Reveal a legacy stored API key (one-time, then scrubbed)',
    description:
      'Legacy-only: decrypts and returns the plaintext for a key created before the zero-retention policy, then scrubs the key_enc column. New keys have never been stored and cannot be revealed — call POST /v1/accounts/:id/api-keys to mint a fresh one.',
    security: [{ bearerAuth: [] }],
    middleware: [bearerAuth, writeRateLimit] as const,
    request: {
      params: z.object({
        id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
        keyId: z.string().uuid().openapi({ param: { name: 'keyId', in: 'path' } }),
      }),
    },
    responses: {
      200: {
        description: 'Plaintext key revealed (and then scrubbed).',
        content: { 'application/json': { schema: ApiKeyRevealResponse } },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Not found.', content: { 'application/json': { schema: ErrorResponse } } },
      410: {
        description: 'Key bytes not stored — mint a new key instead.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      429: { description: 'Rate limit exceeded or quota exhausted.', content: { 'application/json': { schema: RateLimitResponse } } },
      500: { description: 'Server error.', content: { 'application/json': { schema: ErrorResponse } } },
      503: {
        description: "Integrator's Relay subscription is inactive; their product is temporarily unavailable.",
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const { id, keyId } = c.req.valid('param');
    const agent = c.get('agent');
    const agentId = agent.agentId;
    const uid = await callerUserId(agentId);
    if (!uid) return c.json({ error: 'agent_token is not associated with a user' }, 401);

    const accRows = await db
      .select({
        user_id: accounts.user_id,
        tenant_id: accounts.tenant_id,
        provider_id: accounts.provider_id,
      })
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.user_id, uid)))
      .limit(1);
    if (accRows.length === 0) return c.json({ error: 'account not found' }, 404);
    const accountRow = accRows[0];

    const keyRows = await db
      .select()
      .from(api_keys)
      .where(
        and(
          eq(api_keys.id, keyId),
          eq(api_keys.account_id, id),
          isNull(api_keys.revoked_at),
        ),
      )
      .limit(1);

    if (keyRows.length === 0) return c.json({ error: 'api key not found' }, 404);
    const keyRow = keyRows[0];

    if (!keyRow.key_enc) {
      return c.json(
        {
          error:
            'key bytes are not stored (zero-retention policy); mint a new key with POST /v1/accounts/:id/api-keys to rotate',
        },
        410,
      );
    }

    // Per-key-per-day reveal cap (in-memory bucket, ABUSE_ENFORCEMENT-aware).
    try {
      checkKeyRevealLimit(uid, keyId);
    } catch (err) {
      if (err instanceof UserRateLimited) {
        return c.json({ error: 'rate_limit_exceeded' }, 429);
      }
      throw err;
    }

    // Charge the reveal against the integrator quota + per-user-month
    // action cap. Refunded if decryption fails below.
    let receipt: ChargeReceipt;
    try {
      receipt = await chargeAction({
        tenantId: accountRow.tenant_id,
        userId: uid,
        providerId: accountRow.provider_id,
        action: 'reveal',
      });
    } catch (err) {
      if (err instanceof TenantInactive) {
        return c.json({ error: `tenant_${err.state}` }, 503);
      }
      if (err instanceof UserRateLimited || err instanceof IntegratorQuotaExhausted) {
        return c.json({ error: 'rate_limit_exceeded' }, 429);
      }
      throw err;
    }

    let plaintext: string;
    try {
      plaintext = decrypt(keyRow.key_enc).toString('utf8');
    } catch (err: unknown) {
      await refundAction({ tenantId: accountRow.tenant_id, userId: uid, receipt });
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `key decryption failed: ${msg}` }, 500);
    }

    const now = new Date();
    // Scrub after revealing — a legacy key can be revealed at most once.
    await db
      .update(api_keys)
      .set({ last_revealed_at: now, last_used_at: now, key_enc: null })
      .where(eq(api_keys.id, keyId));

    await recordAudit(
      agentId,
      'key_reveal',
      keyId,
      { account_id: id, legacy: true },
      { user_id: accountRow.user_id, tenant_id: accountRow.tenant_id },
    );

    return c.json(
      {
        id: keyRow.id,
        label: keyRow.label,
        key: plaintext,
        revealed_at: now.toISOString(),
        note: 'Legacy reveal. Key bytes have been scrubbed — future reveals will fail.',
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// POST /v1/accounts/:id/api-keys/:keyId/rotate  — bearer rotate
//
// Agent-facing counterpart to the session rotate endpoint. Same behaviour:
// mint fresh key at the provider, return plaintext exactly once, revoke old
// bookkeeping row, best-effort provider-side revoke.
// ---------------------------------------------------------------------------
const RotateResponseSchema = z
  .object({
    rotated: z.literal(true),
    revoked_key_id: z.string().uuid(),
    new_key: z.object({
      id: z.string().uuid(),
      account_id: z.string().uuid(),
      label: z.string(),
      key: z.string(),
      created_at: z.string().nullable(),
    }),
    note: z.string(),
  })
  .openapi('ApiKeyRotateResponse');

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/accounts/{id}/api-keys/{keyId}/rotate',
    tags: ['api-keys'],
    summary: 'Rotate an API key (mint new + revoke old; plaintext returned once)',
    description:
      'Agent-facing rotate. Mints a new key via the provider, returns the plaintext EXACTLY ONCE, revokes the old key, and attempts best-effort provider-side revocation. If the plaintext is lost, rotate again — Relay never stores key bytes.',
    security: [{ bearerAuth: [] }],
    middleware: [bearerAuth, writeRateLimit] as const,
    request: {
      params: z.object({
        id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
        keyId: z.string().uuid().openapi({ param: { name: 'keyId', in: 'path' } }),
      }),
    },
    responses: {
      200: {
        description: 'Rotation complete.',
        content: { 'application/json': { schema: RotateResponseSchema } },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Not found.', content: { 'application/json': { schema: ErrorResponse } } },
      429: { description: 'Rate limit exceeded or quota exhausted.', content: { 'application/json': { schema: RateLimitResponse } } },
      500: { description: 'Server error.', content: { 'application/json': { schema: ErrorResponse } } },
      503: {
        description: "Integrator's Relay subscription is inactive; their product is temporarily unavailable.",
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const { id, keyId } = c.req.valid('param');
    const agentId = c.get('agent').agentId;
    const uid = await callerUserId(agentId);
    if (!uid) return c.json({ error: 'agent_token is not associated with a user' }, 401);

    // Resolve tenant for the charge — rotate ops re-validates ownership.
    const [accRow] = await db
      .select({
        tenant_id: accounts.tenant_id,
        provider_id: accounts.provider_id,
      })
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.user_id, uid)))
      .limit(1);
    if (!accRow) return c.json({ error: 'account not found' }, 404);

    // Per-key-per-day reveal cap (rotates count as reveals — they leak
    // a fresh credential, same end-user-impact for abuse).
    try {
      checkKeyRevealLimit(uid, keyId);
    } catch (err) {
      if (err instanceof UserRateLimited) {
        return c.json({ error: 'rate_limit_exceeded' }, 429);
      }
      throw err;
    }

    let receipt: ChargeReceipt;
    try {
      receipt = await chargeAction({
        tenantId: accRow.tenant_id,
        userId: uid,
        providerId: accRow.provider_id,
        action: 'rotate',
      });
    } catch (err) {
      if (err instanceof TenantInactive) {
        return c.json({ error: `tenant_${err.state}` }, 503);
      }
      if (err instanceof UserRateLimited || err instanceof IntegratorQuotaExhausted) {
        return c.json({ error: 'rate_limit_exceeded' }, 429);
      }
      throw err;
    }

    try {
      const result = await rotateApiKeyForUser(
        { userId: uid, agentId, source: 'bearer' },
        id,
        keyId,
      );
      return c.json(result, 200);
    } catch (err) {
      await refundAction({ tenantId: accRow.tenant_id, userId: uid, receipt });
      if (err instanceof AccountNotFound) return c.json({ error: 'account not found' }, 404);
      if (err instanceof ApiKeyNotFound) return c.json({ error: 'api key not found' }, 404);
      if (err instanceof ProviderNotRegistered) return c.json({ error: err.message }, 500);
      throw err;
    }
  },
);

// ---------------------------------------------------------------------------
// POST /v1/accounts/keys/reveal-batch
//
// Companion to /v1/intent's existing-account resolutions: reveal multiple
// legacy keys in one round-trip. Per-key results are independent — one bad
// id doesn't fail the batch. Each successful reveal is charged + audited
// individually so billing stays per-action; failed reveals (key bytes not
// stored under zero-retention policy) come back as `mint_required` so the
// caller can rotate via the existing per-key endpoint.
// ---------------------------------------------------------------------------
const RevealBatchBody = z
  .object({
    keyIds: z.array(z.string().uuid()).min(1).max(50),
  })
  .openapi('RevealBatchBody');

const RevealBatchEntry = z.object({
  id: z.string().uuid(),
  status: z.enum(['revealed', 'mint_required', 'not_found', 'rate_limited', 'tenant_inactive', 'error']),
  key: z.string().optional(),
  label: z.string().optional(),
  revealed_at: z.string().optional(),
  error: z.string().optional(),
});

const RevealBatchResponse = z
  .object({
    revealed: z.array(RevealBatchEntry),
  })
  .openapi('RevealBatchResponse');

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/accounts/keys/reveal-batch',
    tags: ['api-keys'],
    summary: 'Reveal multiple legacy API keys in one call',
    description:
      'Batched legacy reveal — used by /v1/intent consumers to populate an env block ' +
      'without N+1 round-trips. Each key in `keyIds` is processed independently; per-key ' +
      'failures (zero-retention, rate limit, missing) come back inline with a status code, ' +
      'never aborting the batch. Successful reveals scrub key bytes just like the per-key endpoint.',
    security: [{ bearerAuth: [] }],
    middleware: [bearerAuth, writeRateLimit] as const,
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: RevealBatchBody } },
      },
    },
    responses: {
      200: {
        description: 'Per-key results.',
        content: { 'application/json': { schema: RevealBatchResponse } },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      429: {
        description: 'Rate limit exceeded for the batch dispatch (per-key limits report inline).',
        content: { 'application/json': { schema: RateLimitResponse } },
      },
    },
  }),
  async (c) => {
    const { keyIds } = c.req.valid('json');
    const agent = c.get('agent');
    const agentId = agent.agentId;
    const uid = await callerUserId(agentId);
    if (!uid) return c.json({ error: 'agent_token is not associated with a user' }, 401);

    const results: Array<z.infer<typeof RevealBatchEntry>> = [];

    for (const keyId of keyIds) {
      const keyRows = await db
        .select({
          id: api_keys.id,
          label: api_keys.label,
          key_enc: api_keys.key_enc,
          account_id: api_keys.account_id,
        })
        .from(api_keys)
        .where(and(eq(api_keys.id, keyId), isNull(api_keys.revoked_at)))
        .limit(1);
      if (keyRows.length === 0) {
        results.push({ id: keyId, status: 'not_found' });
        continue;
      }
      const keyRow = keyRows[0];

      const accRows = await db
        .select({
          user_id: accounts.user_id,
          tenant_id: accounts.tenant_id,
          provider_id: accounts.provider_id,
        })
        .from(accounts)
        .where(and(eq(accounts.id, keyRow.account_id), eq(accounts.user_id, uid)))
        .limit(1);
      if (accRows.length === 0) {
        results.push({ id: keyId, status: 'not_found' });
        continue;
      }
      const accountRow = accRows[0];

      if (!keyRow.key_enc) {
        results.push({ id: keyId, status: 'mint_required' });
        continue;
      }

      try {
        checkKeyRevealLimit(uid, keyId);
      } catch (err) {
        if (err instanceof UserRateLimited) {
          results.push({ id: keyId, status: 'rate_limited' });
          continue;
        }
        throw err;
      }

      let receipt: ChargeReceipt;
      try {
        receipt = await chargeAction({
          tenantId: accountRow.tenant_id,
          userId: uid,
          providerId: accountRow.provider_id,
          action: 'reveal',
        });
      } catch (err) {
        if (err instanceof TenantInactive) {
          results.push({ id: keyId, status: 'tenant_inactive' });
          continue;
        }
        if (err instanceof UserRateLimited || err instanceof IntegratorQuotaExhausted) {
          results.push({ id: keyId, status: 'rate_limited' });
          continue;
        }
        throw err;
      }

      let plaintext: string;
      try {
        plaintext = decrypt(keyRow.key_enc).toString('utf8');
      } catch (err: unknown) {
        await refundAction({ tenantId: accountRow.tenant_id, userId: uid, receipt });
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ id: keyId, status: 'error', error: `decrypt_failed: ${msg}` });
        continue;
      }

      const now = new Date();
      await db
        .update(api_keys)
        .set({ last_revealed_at: now, last_used_at: now, key_enc: null })
        .where(eq(api_keys.id, keyId));

      await recordAudit(
        agentId,
        'key_reveal',
        keyId,
        { account_id: keyRow.account_id, legacy: true, batch: true },
        { user_id: accountRow.user_id, tenant_id: accountRow.tenant_id },
      );

      results.push({
        id: keyId,
        status: 'revealed',
        key: plaintext,
        label: keyRow.label,
        revealed_at: now.toISOString(),
      });
    }

    return c.json({ revealed: results }, 200);
  },
);

export default app;
