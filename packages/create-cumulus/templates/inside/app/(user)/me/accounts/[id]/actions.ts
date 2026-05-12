'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  readSessionFromToken,
  SESSION_COOKIE,
} from '@/src/server/auth/session';
import {
  AccountNotFound,
  ApiKeyNotFound,
  ProviderNotRegistered,
  mintApiKeyForUser,
  rotateApiKeyForUser,
  type MintedKey,
  type RotationResult,
} from '@/src/server/api-keys/ops';

async function requireSession() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  return session;
}

export async function mintKeyAction(
  accountId: string,
  formData: FormData,
): Promise<MintedKey> {
  const session = await requireSession();
  const raw = String(formData.get('label') ?? '').trim();
  const label = raw || `key-${Date.now()}`;
  try {
    return await mintApiKeyForUser(
      { userId: session.userId, source: 'session' },
      accountId,
      label,
    );
  } catch (err) {
    if (err instanceof AccountNotFound) throw new Error('Account not found.');
    if (err instanceof ProviderNotRegistered) throw new Error(err.message);
    throw err;
  }
}

export async function rotateKeyAction(
  accountId: string,
  keyId: string,
): Promise<RotationResult> {
  const session = await requireSession();
  try {
    return await rotateApiKeyForUser(
      { userId: session.userId, source: 'session' },
      accountId,
      keyId,
    );
  } catch (err) {
    if (err instanceof AccountNotFound) throw new Error('Account not found.');
    if (err instanceof ApiKeyNotFound) throw new Error('Key not found.');
    if (err instanceof ProviderNotRegistered) throw new Error(err.message);
    throw err;
  }
}
