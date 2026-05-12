import { cookies } from 'next/headers';
import { jwtVerify, SignJWT } from 'jose';

export const SESSION_COOKIE = 'cumulus_session';

export interface AppSession {
  externalUserId: string;
  relayUserId?: string;
  email: string;
  actor: 'agent' | 'human';
}

function sessionSecret(): Uint8Array {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters');
  }
  return new TextEncoder().encode(value);
}

export async function signAppSession(session: AppSession): Promise<string> {
  return new SignJWT({ ...session })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(sessionSecret());
}

export async function verifyAppSession(token: string | undefined): Promise<AppSession | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionSecret());
    if (typeof payload.externalUserId !== 'string' || typeof payload.email !== 'string') {
      return null;
    }
    return {
      externalUserId: payload.externalUserId,
      relayUserId: typeof payload.relayUserId === 'string' ? payload.relayUserId : undefined,
      email: payload.email,
      actor: payload.actor === 'human' ? 'human' : 'agent',
    };
  } catch {
    return null;
  }
}

export async function readAppSession(): Promise<AppSession | null> {
  const jar = await cookies();
  return verifyAppSession(jar.get(SESSION_COOKIE)?.value);
}
