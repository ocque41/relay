import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';

export default async function DashboardIndex() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  // Route to the workspace that is already active on the session.
  redirect(session.activeWorkspace.kind === 'tenant' ? '/dev' : '/me');
}
