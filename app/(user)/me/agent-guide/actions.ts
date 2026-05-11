'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import {
  readSessionFromToken,
  SESSION_COOKIE,
} from '@/src/server/auth/session';
import { recordAudit } from '@/src/server/audit';
import { db } from '@/src/server/db/index';
import { users } from '@/src/server/db/schema';

export const MAX_GUIDE_BYTES = 64 * 1024;

async function requireSession() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  return session;
}

export async function saveAgentGuideAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const content = String(formData.get('content') ?? '');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_GUIDE_BYTES) {
    redirect('/me/agent-guide?error=too_large');
  }

  const now = new Date();
  await db
    .update(users)
    .set({ agent_guide: content, agent_guide_updated_at: now })
    .where(eq(users.id, session.userId));

  await recordAudit(
    null,
    'agent_guide_update',
    session.userId,
    { bytes, via: 'dashboard' },
    { user_id: session.userId },
  );

  redirect('/me/agent-guide?saved=1');
}
