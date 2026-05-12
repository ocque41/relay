/**
 * Developer workspace shell. Wraps every /dev/* page.
 *
 * Enforcement:
 *   - session required
 *   - if no tenant workspace active yet, auto-pick the first tenant the user
 *     can access; if they have none, redirect to /me with a prompt to create
 *     one.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import {
  readSessionFromToken,
  setActiveWorkspace,
  SESSION_COOKIE,
} from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { tenant_members, tenants } from '@/src/server/db/schema';
import WorkspaceSwitcher from '@/app/WorkspaceSwitcher';
import { DashboardShell } from '@/app/components/DashboardShell';
import { DEV_NAV } from '@/app/router';

async function firstAccessibleTenant(userId: string): Promise<string | null> {
  const [owned] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.owner_user_id, userId))
    .limit(1);
  if (owned) return owned.id;

  const [member] = await db
    .select({ tenant_id: tenant_members.tenant_id })
    .from(tenant_members)
    .where(eq(tenant_members.user_id, userId))
    .limit(1);
  return member?.tenant_id ?? null;
}

export default async function DevLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const session = await readSessionFromToken(token);
  if (!session) redirect('/login');

  let tenantId: string | null =
    session.activeWorkspace.kind === 'tenant'
      ? session.activeWorkspace.tenantId
      : null;

  if (!tenantId) {
    tenantId = await firstAccessibleTenant(session.userId);
    if (!tenantId) redirect('/me?no_tenant=1');
    await setActiveWorkspace(session.sessionJti, { kind: 'tenant', tenantId });
  } else {
    const [owned] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.id, tenantId), eq(tenants.owner_user_id, session.userId)))
      .limit(1);
    if (!owned) {
      const [member] = await db
        .select({ id: tenant_members.tenant_id })
        .from(tenant_members)
        .where(
          and(
            eq(tenant_members.tenant_id, tenantId),
            eq(tenant_members.user_id, session.userId),
          ),
        )
        .limit(1);
      if (!member) {
        await setActiveWorkspace(session.sessionJti, { kind: 'user' });
        redirect('/me');
      }
    }
  }

  const [activeTenant] = await db
    .select({ name: tenants.name, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  return (
    <DashboardShell
      nav={DEV_NAV}
      brand={{ line1: 'Relay', line2: 'developer' }}
      workspaceLabel={activeTenant?.slug ?? 'dev'}
      footer={{
        primary: activeTenant?.name ?? '—',
        secondary: activeTenant?.slug ? `/${activeTenant.slug}` : undefined,
        signOutAction: '/v1/auth/logout',
      }}
      workspaceSwitcher={
        <WorkspaceSwitcher
          userId={session.userId}
          active={{ kind: 'tenant', tenantId }}
        />
      }
      paletteFooterRight={`relay · ${activeTenant?.slug ?? ''}`}
    >
      {children}
    </DashboardShell>
  );
}
