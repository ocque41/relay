'use server';

/**
 * Server actions for /me/workspaces. These are the thin form-binding layer
 * over src/server/user-workspaces.ts — they exist so the page can use plain
 * <form action={...}> without any client JS. Errors are surfaced via
 * redirect-with-query-string so the page can render an inline banner.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import {
  createUserWorkspace,
  deleteUserWorkspace,
  renameUserWorkspace,
  switchActiveUserWorkspace,
  UserWorkspaceError,
} from '@/src/server/user-workspaces';

async function requireSession() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  return session;
}

function redirectWithBanner(kind: 'ok' | 'error', message: string, workspaceId?: string): never {
  const qs = new URLSearchParams({ [kind]: message });
  if (workspaceId) qs.set('ws', workspaceId);
  redirect(`/me/workspaces?${qs.toString()}`);
}

export async function createUserWorkspaceFromForm(formData: FormData): Promise<void> {
  const session = await requireSession();
  const name = String(formData.get('name') ?? '').trim();
  const rawSlug = String(formData.get('slug') ?? '').trim();
  const slug = rawSlug || undefined;
  const makeActive = formData.get('make_active') === 'on';

  try {
    await createUserWorkspace({
      userId: session.userId,
      name,
      slug,
      makeActive,
    });
  } catch (e) {
    if (e instanceof UserWorkspaceError) {
      redirectWithBanner('error', e.message);
    }
    throw e;
  }
  redirect('/me/workspaces?ok=Workspace+created');
}

export async function renameUserWorkspaceAction(
  workspaceId: string,
  formData: FormData,
): Promise<void> {
  const session = await requireSession();
  const name = String(formData.get('name') ?? '').trim();
  try {
    await renameUserWorkspace(session.userId, workspaceId, name);
  } catch (e) {
    if (e instanceof UserWorkspaceError) {
      redirectWithBanner('error', e.message, workspaceId);
    }
    throw e;
  }
  redirect(`/me/workspaces?ok=Renamed&ws=${workspaceId}`);
}

export async function switchUserWorkspaceAction(workspaceId: string): Promise<void> {
  const session = await requireSession();
  try {
    await switchActiveUserWorkspace(session.userId, workspaceId);
  } catch (e) {
    if (e instanceof UserWorkspaceError) {
      redirectWithBanner('error', e.message, workspaceId);
    }
    throw e;
  }
  redirect('/me');
}

export async function deleteUserWorkspaceFromForm(
  workspaceId: string,
  formData: FormData,
): Promise<void> {
  const session = await requireSession();
  const confirmName = String(formData.get('confirm_name') ?? '');
  try {
    await deleteUserWorkspace({
      userId: session.userId,
      workspaceId,
      confirmName,
    });
  } catch (e) {
    if (e instanceof UserWorkspaceError) {
      redirectWithBanner('error', e.message, workspaceId);
    }
    throw e;
  }
  redirect('/me/workspaces?ok=Workspace+deleted');
}
