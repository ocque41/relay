'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  readSessionFromToken,
  setActiveWorkspace,
  SESSION_COOKIE,
} from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import {
  sessions,
  tenant_feature_flags,
  tenant_subscriptions,
  tenants,
} from '@/src/server/db/schema';
import { recordAudit } from '@/src/server/audit';

async function requireTenantSession() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  if (session.activeWorkspace.kind !== 'tenant') redirect('/dev');
  return { session, tenantId: session.activeWorkspace.tenantId };
}

export type DeleteWorkspaceError =
  | 'not_owner'
  | 'name_mismatch'
  | 'active_subscription'
  | 'not_found';

export async function updateTenantNameAction(formData: FormData): Promise<void> {
  const { session, tenantId } = await requireTenantSession();
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return;

  // Owner-only
  const [t] = await db
    .select({ owner_user_id: tenants.owner_user_id })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!t || t.owner_user_id !== session.userId) return;

  await db.update(tenants).set({ name }).where(eq(tenants.id, tenantId));
}

export async function toggleFeatureFlagAction(
  flag: string,
  currentlyOn: boolean,
): Promise<void> {
  const { session, tenantId } = await requireTenantSession();

  if (currentlyOn) {
    await db
      .delete(tenant_feature_flags)
      .where(
        and(
          eq(tenant_feature_flags.tenant_id, tenantId),
          eq(tenant_feature_flags.flag, flag),
        ),
      );
  } else {
    try {
      await db.insert(tenant_feature_flags).values({
        tenant_id: tenantId,
        flag,
        enabled_by: session.userId,
      });
    } catch {
      /* already enabled */
    }
  }
}

/**
 * Hard-delete the active workspace.
 *
 * Four guardrails, each surfacing a distinct reason so the UI can show a
 * specific message:
 *   1. Caller must be the owner.
 *   2. The typed confirm_name must equal the workspace name exactly.
 *   3. No live Stripe subscription (cancel billing first).
 *   4. Tenant row still exists (race with a concurrent delete).
 *
 * On success every session pointing at this tenant is flipped back to the
 * user workspace, the current session's active workspace is updated in
 * place, the row is deleted (cascades fire), and the caller is redirected
 * to /me. Audit entry recorded before the delete with a pre-delete
 * snapshot.
 */
function redirectWithError(err: DeleteWorkspaceError, extra?: string): never {
  const qs = new URLSearchParams({ delete_error: err });
  if (extra) qs.set('sub', extra);
  redirect(`/dev/settings?${qs.toString()}`);
}

export async function deleteWorkspaceAction(
  formData: FormData,
): Promise<void> {
  const { session, tenantId } = await requireTenantSession();
  const confirmName = String(formData.get('confirm_name') ?? '').trim();

  const [t] = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      owner_user_id: tenants.owner_user_id,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!t) redirectWithError('not_found');
  if (t.owner_user_id !== session.userId) redirectWithError('not_owner');
  if (confirmName !== t.name) redirectWithError('name_mismatch');

  const [sub] = await db
    .select({ status: tenant_subscriptions.status })
    .from(tenant_subscriptions)
    .where(eq(tenant_subscriptions.tenant_id, tenantId))
    .orderBy(desc(tenant_subscriptions.created_at))
    .limit(1);
  if (
    sub &&
    (sub.status === 'trialing' ||
      sub.status === 'active' ||
      sub.status === 'past_due')
  ) {
    redirectWithError('active_subscription', sub.status);
  }

  await recordAudit(
    null,
    'tenant_delete',
    tenantId,
    {
      tenant_slug: t.slug,
      tenant_name: t.name,
      by_user_id: session.userId,
      via: 'dashboard',
    },
    { user_id: session.userId, tenant_id: tenantId },
  );

  // Flip every other session whose active_workspace points at this tenant
  // back to the user workspace so their switcher doesn't load a dangling id.
  await db
    .update(sessions)
    .set({ active_workspace: { kind: 'user' } })
    .where(sql`${sessions.active_workspace} ->> 'tenantId' = ${tenantId}`);

  // Also update *this* session synchronously so the redirect below lands in
  // the user workspace shell without a stale cookie round-trip.
  await setActiveWorkspace(session.sessionJti, { kind: 'user' });

  await db.delete(tenants).where(eq(tenants.id, tenantId));

  redirect('/me');
}
