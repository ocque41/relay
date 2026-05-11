import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';

export default async function LegacyAuditRedirect() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  // Tenant sessions → /dev/audit-log; user sessions → /me/audit-log (which
  // doesn't exist yet as a distinct page; fall back to /me/signups which is
  // the closest end-user activity view until the user audit page lands).
  redirect(
    session.activeWorkspace.kind === 'tenant' ? '/dev/audit-log' : '/me/signups',
  );
}
