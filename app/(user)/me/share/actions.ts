'use server';

import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import {
  readSessionFromToken,
  SESSION_COOKIE,
} from '@/src/server/auth/session';
import { hashToken } from '@/src/server/crypto';
import { db } from '@/src/server/db/index';
import { magic_links } from '@/src/server/db/schema';
import { resolveActiveUserWorkspace } from '@/src/server/user-workspaces';

function baseUrl(): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.replace(/^https?:\/\//, '')}`;
  }
  return 'http://localhost:3000';
}

async function requireSession() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  return session;
}

export async function mintShareLinkAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const ws = await resolveActiveUserWorkspace(session.userId);
  const ttl = Math.min(60, Math.max(1, parseInt(String(formData.get('ttl_minutes') ?? 10), 10) || 10));
  const uses = Math.min(10, Math.max(1, parseInt(String(formData.get('max_uses') ?? 1), 10) || 1));

  const token = 'mls_' + randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + ttl * 60 * 1000);

  await db.insert(magic_links).values({
    user_id: session.userId,
    user_workspace_id: ws.id,
    token_hash: tokenHash,
    purpose: 'dashboard_summary',
    expires_at: expiresAt,
    max_uses: uses,
  });

  const url = `${baseUrl()}/share/${token}`;
  redirect(
    `/me/share?minted=${encodeURIComponent(url)}&expires=${encodeURIComponent(expiresAt.toISOString())}`,
  );
}

export async function revokeShareLinkAction(id: string): Promise<void> {
  const session = await requireSession();
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
}
