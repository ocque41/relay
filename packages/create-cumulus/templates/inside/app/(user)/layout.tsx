/**
 * End-user workspace shell. Wraps every /me/* page.
 *
 * Enforcement:
 *   - session required (redirect /login)
 *   - if session.activeWorkspace is NOT 'user', silently switch back so the
 *     UI matches the URL. Self-healing route group.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import {
  readSessionFromToken,
  setActiveWorkspace,
  SESSION_COOKIE,
} from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { users } from '@/src/server/db/schema';
import WorkspaceSwitcher from '@/app/WorkspaceSwitcher';
import { DashboardShell } from '@/app/components/DashboardShell';
import { USER_NAV } from '@/app/router';

export default async function UserLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const session = await readSessionFromToken(token);
  if (!session) redirect('/login');

  if (session.activeWorkspace.kind !== 'user') {
    await setActiveWorkspace(session.sessionJti, { kind: 'user' });
  }

  const [u] = await db
    .select({ inbox_alias: users.inbox_alias })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  const catchallDomain = process.env.CATCHALL_DOMAIN ?? 'mail.example.com';
  const inboxAddress = u?.inbox_alias ? `${u.inbox_alias}@${catchallDomain}` : null;

  return (
    <DashboardShell
      nav={USER_NAV}
      brand={{ line1: 'Relay', line2: 'by Cumulus' }}
      workspaceLabel={session.email.split('@')[0] ?? 'me'}
      footer={{
        primary: session.email,
        secondary: inboxAddress ?? undefined,
        signOutAction: '/v1/auth/logout',
      }}
      workspaceSwitcher={
        <WorkspaceSwitcher userId={session.userId} active={{ kind: 'user' }} />
      }
      paletteFooterRight={`relay · ${session.email}`}
    >
      {children}
    </DashboardShell>
  );
}
