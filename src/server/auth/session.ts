/**
 * Session layer: signed JWT cookies backed by a `sessions` DB row.
 *
 * Design:
 *   - JWT is HS256, signed with SESSION_SECRET.
 *   - Claims: `sub` = user_id, `jti` = sessions.jti (PK).
 *   - Cookie: `relay_session`, HttpOnly, Secure (on https), SameSite=Lax.
 *   - Revocation: deleting the `sessions` row makes the JWT fail server-side
 *     even though it's still signature-valid. (Belt + suspenders.)
 *   - TTL: 30 days fixed. No rolling yet.
 */
import { randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db } from '../db/index';
import { sessions, users } from '../db/schema';

export const SESSION_COOKIE = 'relay_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Active workspace attached to a session. Defaults to `{ kind: 'user' }`
 * (the user's own end-user workspace) whenever the column is null.
 */
export type ActiveWorkspace =
  | { kind: 'user' }
  | { kind: 'tenant'; tenantId: string };

export function parseActiveWorkspace(raw: unknown): ActiveWorkspace {
  if (raw && typeof raw === 'object') {
    const v = raw as { kind?: unknown; tenantId?: unknown };
    if (v.kind === 'tenant' && typeof v.tenantId === 'string') {
      return { kind: 'tenant', tenantId: v.tenantId };
    }
  }
  return { kind: 'user' };
}

function getSecret(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (!raw) throw new Error('SESSION_SECRET is not set');
  if (raw.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  return new TextEncoder().encode(raw);
}

function newJti(): string {
  return randomBytes(16).toString('base64url');
}

export interface SessionUser {
  userId: string;
  email: string;
  sessionJti: string;
  /** Active workspace scope. Derived from sessions.active_workspace (default: user). */
  activeWorkspace: ActiveWorkspace;
}

export type SessionEnv = {
  Variables: {
    session?: SessionUser;
  };
};

/**
 * Create a new session row + signed JWT + set the cookie.
 * Returns the plaintext JWT (also written to the cookie).
 */
export async function issueSession(
  c: Context,
  userId: string,
  opts: { ip?: string | null; userAgent?: string | null } = {},
): Promise<string> {
  const jti = newJti();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

  await db.insert(sessions).values({
    jti,
    user_id: userId,
    expires_at: expiresAt,
    ip: opts.ip ?? null,
    user_agent: opts.userAgent ?? null,
  });

  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(getSecret());

  const url = new URL(c.req.url);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });

  return token;
}

/**
 * Destroy the current session (DB row + cookie). Idempotent.
 */
export async function destroySession(c: Context): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    try {
      const { payload } = await jwtVerify(token, getSecret());
      if (typeof payload.jti === 'string') {
        await db.delete(sessions).where(eq(sessions.jti, payload.jti));
      }
    } catch {
      // invalid token — nothing to delete
    }
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

/**
 * Read + verify a session JWT string. Shared by both the Hono middleware path
 * (which reads the cookie off the context) and Next.js Server Components
 * (which read it off `next/headers` and pass it in directly).
 */
export async function readSessionFromToken(
  token: string | undefined,
): Promise<SessionUser | null> {
  if (!token) return null;

  let payload: { sub?: string; jti?: string; exp?: number };
  try {
    ({ payload } = await jwtVerify(token, getSecret()));
  } catch {
    return null;
  }

  const userId = typeof payload.sub === 'string' ? payload.sub : null;
  const jti = typeof payload.jti === 'string' ? payload.jti : null;
  if (!userId || !jti) return null;

  const rows = await db
    .select({
      jti: sessions.jti,
      user_id: sessions.user_id,
      expires_at: sessions.expires_at,
      active_workspace: sessions.active_workspace,
    })
    .from(sessions)
    .where(eq(sessions.jti, jti))
    .limit(1);

  const session = rows[0];
  if (!session) return null;
  if (session.user_id !== userId) return null;
  if (session.expires_at && session.expires_at.getTime() < Date.now()) {
    await db.delete(sessions).where(eq(sessions.jti, jti));
    return null;
  }

  const userRows = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const user = userRows[0];
  if (!user) return null;

  return {
    userId,
    email: user.email,
    sessionJti: jti,
    activeWorkspace: parseActiveWorkspace(session.active_workspace),
  };
}

/**
 * Change the active workspace on the current session. Caller must verify the
 * user is allowed to switch to that workspace (owner/member of the tenant).
 */
export async function setActiveWorkspace(
  sessionJti: string,
  workspace: ActiveWorkspace,
): Promise<void> {
  await db
    .update(sessions)
    .set({ active_workspace: workspace })
    .where(eq(sessions.jti, sessionJti));
}

/**
 * Read + verify the current session from a Hono context (cookie-based).
 * Returns null if no valid session.
 */
export async function readSession(c: Context): Promise<SessionUser | null> {
  return readSessionFromToken(getCookie(c, SESSION_COOKIE));
}

/**
 * Middleware: requires a valid session cookie. Returns 401 if not.
 * Puts `session` on `c.var`.
 */
export const sessionAuth: MiddlewareHandler<SessionEnv> = async (c, next) => {
  const session = await readSession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  c.set('session', session);
  await next();
};

/**
 * Middleware: loads a session into context if present, but does not 401 if
 * absent. Use for endpoints that support both session + bearer auth.
 */
export const sessionOptional: MiddlewareHandler<SessionEnv> = async (c, next) => {
  const session = await readSession(c);
  if (session) c.set('session', session);
  await next();
};
