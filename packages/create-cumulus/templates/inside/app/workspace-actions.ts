'use server';

/**
 * Workspace-switch server actions shared by the (user) and (dev) layouts.
 * Implemented server-side so the JWT cookie is never exposed; the active
 * workspace is persisted on the `sessions` row.
 */
import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import {
  readSessionFromToken,
  setActiveWorkspace,
  SESSION_COOKIE,
} from '@/src/server/auth/session';
import { userCanAccessTenant } from '@/src/server/auth/workspace';
import { db } from '@/src/server/db/index';
import { tenants, users } from '@/src/server/db/schema';
import {
  createUserWorkspace,
  switchActiveUserWorkspace,
  UserWorkspaceError,
} from '@/src/server/user-workspaces';

async function requireSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const session = await readSessionFromToken(token);
  if (!session) redirect('/login');
  return session;
}

export async function switchToUserWorkspace(): Promise<void> {
  const session = await requireSession();
  await setActiveWorkspace(session.sessionJti, { kind: 'user' });
  redirect('/me');
}

/**
 * Make a specific user workspace the active one AND switch the session into
 * the user shell. Called from the workspace switcher when a user clicks a
 * workspace row that isn't the currently-active one.
 */
export async function switchToUserWorkspaceById(
  workspaceId: string,
): Promise<void> {
  const session = await requireSession();
  try {
    await switchActiveUserWorkspace(session.userId, workspaceId);
  } catch (e) {
    if (e instanceof UserWorkspaceError) throw new Error(e.message);
    throw e;
  }
  await setActiveWorkspace(session.sessionJti, { kind: 'user' });
  redirect('/me');
}

/**
 * Create a new personal workspace. Called from the switcher's "+ New workspace"
 * row (auto-names from the user's email local part + short suffix) AND from
 * the /me/workspaces/new form (name supplied by the user).
 *
 * The new workspace becomes the caller's active one and the session shell
 * flips into /me so the user lands inside the workspace they just made.
 */
export async function createUserWorkspaceAction(
  formData?: FormData,
): Promise<void> {
  const session = await requireSession();

  const rawName = formData?.get('name');
  let name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name) {
    const [u] = await db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    const base = (u?.name ?? u?.email?.split('@')[0] ?? 'workspace').trim();
    name = `${base}'s space ${randomBytes(1).toString('hex')}`;
  }

  const rawSlug = formData?.get('slug');
  const slug =
    typeof rawSlug === 'string' && rawSlug.trim() ? rawSlug.trim() : undefined;

  try {
    await createUserWorkspace({
      userId: session.userId,
      name,
      slug,
      makeActive: true,
    });
  } catch (e) {
    if (e instanceof UserWorkspaceError) throw new Error(e.message);
    throw e;
  }

  await setActiveWorkspace(session.sessionJti, { kind: 'user' });
  redirect('/me');
}

export async function switchToTenantWorkspace(tenantId: string): Promise<void> {
  const session = await requireSession();
  const allowed = await userCanAccessTenant(session.userId, tenantId);
  if (!allowed) throw new Error('not a member of that tenant');
  await setActiveWorkspace(session.sessionJti, { kind: 'tenant', tenantId });
  redirect('/dev');
}

function slugify(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
  return base || 'tenant';
}

/**
 * One-click "become a developer". Derives a tenant name from the user's
 * email local-part, picks a non-colliding slug, and activates the new
 * workspace in the same request. Redirects to /dev so the dev shell
 * loads against the fresh tenant.
 */
export async function createDeveloperWorkspaceAction(): Promise<void> {
  const session = await requireSession();
  const [u] = await db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  const displayName = (u?.name ?? u?.email?.split('@')[0] ?? 'My tenant').trim();
  const baseSlug = slugify(displayName);
  const [clash] = await db
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.slug, baseSlug))
    .limit(1);
  const slug = clash ? `${baseSlug}-${randomBytes(2).toString('hex')}` : baseSlug;

  const [inserted] = await db
    .insert(tenants)
    .values({ owner_user_id: session.userId, name: displayName, slug })
    .returning({ id: tenants.id });

  await setActiveWorkspace(session.sessionJti, {
    kind: 'tenant',
    tenantId: inserted.id,
  });
  redirect('/dev');
}
