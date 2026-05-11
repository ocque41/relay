/**
 * User-scoped API-key operations. Shared by:
 *   - /v1/me/accounts/:id/api-keys (POST)           — session mint
 *   - /v1/me/accounts/:id/api-keys/:keyId/rotate    — session rotate
 *   - /v1/accounts/:id/api-keys/:keyId/rotate       — bearer rotate
 *   - app/(user)/me/accounts/[id]/actions.ts        — dashboard server actions
 *
 * Every entry point enforces ownership via `accounts.user_id = userId`. Mint
 * and rotate both call `provider.createApiKey` and return plaintext exactly
 * once — Relay never persists key bytes.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index';
import { accounts, api_keys } from '../db/schema';
import { getProvider } from '../providers/index';
import { decrypt } from '../crypto';
import { recordAudit } from '../audit';
import type { NeonAccount } from '../providers/neon';

export class AccountNotFound extends Error {
  constructor() {
    super('account not found');
  }
}
export class ApiKeyNotFound extends Error {
  constructor() {
    super('api key not found');
  }
}
export class ProviderNotRegistered extends Error {
  constructor(id: string) {
    super(`provider "${id}" not registered`);
  }
}

export interface MintedKey {
  id: string;
  account_id: string;
  label: string;
  key: string;
  created_at: string | null;
}

export interface RotationResult {
  rotated: true;
  revoked_key_id: string;
  new_key: MintedKey;
  note: string;
}

type AuditSource = 'session' | 'bearer';

interface OpContext {
  userId: string;
  agentId?: string | null;
  source: AuditSource;
}

function providerRowToNeonShape(account: {
  external_id: string;
  label: string;
  credentials_enc: Buffer | null;
}): NeonAccount & { accountId: string } {
  const shape: NeonAccount & { accountId: string } = {
    projectId: account.external_id,
    accountId: account.external_id,
    name: account.label,
    connectionUri: '',
  };
  if (account.credentials_enc) {
    try {
      shape.connectionUri = decrypt(account.credentials_enc).toString('utf8');
    } catch {
      /* optional — many provider createApiKey paths don't need the URI */
    }
  }
  return shape;
}

async function requireOwnedAccount(accountId: string, userId: string) {
  const [acc] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.user_id, userId)))
    .limit(1);
  if (!acc) throw new AccountNotFound();
  return acc;
}

export async function mintApiKeyForUser(
  ctx: OpContext,
  accountId: string,
  label: string,
): Promise<MintedKey> {
  const account = await requireOwnedAccount(accountId, ctx.userId);
  const provider = await getProvider(account.provider_id);
  if (!provider) throw new ProviderNotRegistered(account.provider_id);

  const providerAccount = providerRowToNeonShape(account);
  const minted = await provider.createApiKey({ db }, providerAccount as never, label);
  const now = new Date();

  const [row] = await db
    .insert(api_keys)
    .values({
      account_id: accountId,
      label,
      last_used_at: now,
      ...(minted.providerKeyId != null ? { provider_key_id: minted.providerKeyId } : {}),
    })
    .returning({
      id: api_keys.id,
      account_id: api_keys.account_id,
      label: api_keys.label,
      created_at: api_keys.created_at,
    });

  await recordAudit(
    ctx.agentId ?? null,
    'key_create',
    row.id,
    { account_id: accountId, label, source: ctx.source },
    { user_id: account.user_id, tenant_id: account.tenant_id },
  );

  return {
    id: row.id,
    account_id: row.account_id,
    label: row.label,
    key: minted.key,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

export async function rotateApiKeyForUser(
  ctx: OpContext,
  accountId: string,
  keyId: string,
): Promise<RotationResult> {
  const account = await requireOwnedAccount(accountId, ctx.userId);

  const [oldKey] = await db
    .select()
    .from(api_keys)
    .where(and(eq(api_keys.id, keyId), eq(api_keys.account_id, accountId), isNull(api_keys.revoked_at)))
    .limit(1);
  if (!oldKey) throw new ApiKeyNotFound();

  const provider = await getProvider(account.provider_id);
  if (!provider) throw new ProviderNotRegistered(account.provider_id);

  const providerAccount = providerRowToNeonShape(account);
  const minted = await provider.createApiKey({ db }, providerAccount as never, oldKey.label);
  const now = new Date();

  const [newKey] = await db
    .insert(api_keys)
    .values({
      account_id: accountId,
      label: oldKey.label,
      last_used_at: now,
      ...(minted.providerKeyId != null ? { provider_key_id: minted.providerKeyId } : {}),
    })
    .returning({
      id: api_keys.id,
      account_id: api_keys.account_id,
      label: api_keys.label,
      created_at: api_keys.created_at,
    });

  await db
    .update(api_keys)
    .set({ revoked_at: now, last_used_at: now })
    .where(eq(api_keys.id, oldKey.id));

  if (oldKey.provider_key_id) {
    try {
      await provider.revokeApiKey({ db }, providerAccount as never, oldKey.provider_key_id);
    } catch (err) {
      console.error(
        `[api-keys] provider-side revoke failed for ${oldKey.provider_key_id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  await recordAudit(
    ctx.agentId ?? null,
    'key_rotate',
    newKey.id,
    {
      account_id: accountId,
      revoked_key_id: oldKey.id,
      label: oldKey.label,
      source: ctx.source,
    },
    { user_id: account.user_id, tenant_id: account.tenant_id },
  );

  return {
    rotated: true as const,
    revoked_key_id: oldKey.id,
    new_key: {
      id: newKey.id,
      account_id: newKey.account_id,
      label: newKey.label,
      key: minted.key,
      created_at: newKey.created_at ? new Date(newKey.created_at).toISOString() : null,
    },
    note:
      'Plaintext returned exactly once. Relay does not persist key bytes. If you lose this, rotate again.',
  };
}
