/**
 * User-workspaces module — all the read/write surface for personal
 * (non-tenant) workspaces in one place.
 *
 * Design constraints:
 *   1. Session JWT shape is stable. Which workspace is "active" is
 *      stored on `users.active_user_workspace_id` and resolved per-request.
 *   2. Personal and developer workspaces are kept visually + semantically
 *      separate. Helpers here only touch user_workspaces; tenant workspace
 *      plumbing lives in auth/workspace.ts.
 *   3. User-scoped agent tokens pin to exactly one workspace at creation
 *      time (`agents.user_workspace_id`). The resolver below prefers that
 *      pin over whatever is "currently active" for the human.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db/index';
import {
  audit_log,
  user_workspaces,
  users,
  type agents,
} from './db/schema';
import type { InferSelectModel } from 'drizzle-orm';

export type UserWorkspace = InferSelectModel<typeof user_workspaces>;

const SLUG_RE = /^[a-z0-9-]+$/;
const MAX_WORKSPACES_PER_USER = 25;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class UserWorkspaceError extends Error {
  constructor(
    public readonly kind:
      | 'invalid_name'
      | 'invalid_slug'
      | 'slug_taken'
      | 'not_found'
      | 'forbidden'
      | 'is_default'
      | 'last_remaining'
      | 'limit_reached'
      | 'name_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'UserWorkspaceError';
  }
}

// ---------------------------------------------------------------------------
// Inbox alias generation — same format as users.inbox_alias so the two
// surfaces stay visually coherent while we transition.
// ---------------------------------------------------------------------------
async function mintWorkspaceInboxAlias(base: string): Promise<string> {
  const local =
    base
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 20) || 'user';
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `${local}-${randomBytes(2).toString('hex')}`;
    const [clashWs] = await db
      .select({ id: user_workspaces.id })
      .from(user_workspaces)
      .where(eq(user_workspaces.inbox_alias, candidate))
      .limit(1);
    if (clashWs) continue;
    // Cross-check against legacy users.inbox_alias so a workspace alias
    // never shadows an older user alias.
    const [clashUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.inbox_alias, candidate))
      .limit(1);
    if (!clashUser) return candidate;
  }
  throw new UserWorkspaceError(
    'invalid_slug',
    'failed to mint a unique inbox alias after 5 attempts',
  );
}

function slugify(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40) || 'workspace'
  );
}

async function nextAvailableSlug(userId: string, base: string): Promise<string> {
  let slug = base;
  for (let attempt = 0; attempt < 5; attempt++) {
    const [clash] = await db
      .select({ id: user_workspaces.id })
      .from(user_workspaces)
      .where(
        and(
          eq(user_workspaces.user_id, userId),
          eq(user_workspaces.slug, slug),
        ),
      )
      .limit(1);
    if (!clash) return slug;
    slug = `${base}-${randomBytes(2).toString('hex')}`;
  }
  throw new UserWorkspaceError(
    'slug_taken',
    `could not derive an available slug after 5 attempts`,
  );
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * List every workspace a user owns, default row first, created-at ascending.
 */
export async function listUserWorkspaces(userId: string): Promise<UserWorkspace[]> {
  const rows = await db
    .select()
    .from(user_workspaces)
    .where(eq(user_workspaces.user_id, userId));
  return rows.sort((a, b) => {
    if (a.is_default && !b.is_default) return -1;
    if (!a.is_default && b.is_default) return 1;
    const at = a.created_at?.getTime?.() ?? 0;
    const bt = b.created_at?.getTime?.() ?? 0;
    return at - bt;
  });
}

/**
 * Resolve the "active" personal workspace for a given user.
 *
 * Priority:
 *   1. `users.active_user_workspace_id` if it points at a workspace the user
 *      still owns.
 *   2. The user's `is_default = true` row.
 *
 * Guaranteed-non-null after the 0021 migration because every user has at
 * least one is_default workspace. Throws if both lookups miss (should only
 * happen for a malformed user row and is logged up-stack).
 */
export async function resolveActiveUserWorkspace(
  userId: string,
): Promise<UserWorkspace> {
  const [userRow] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (userRow?.active_user_workspace_id) {
    const [active] = await db
      .select()
      .from(user_workspaces)
      .where(
        and(
          eq(user_workspaces.id, userRow.active_user_workspace_id),
          eq(user_workspaces.user_id, userId),
        ),
      )
      .limit(1);
    if (active) return active;
  }

  const [def] = await db
    .select()
    .from(user_workspaces)
    .where(
      and(
        eq(user_workspaces.user_id, userId),
        eq(user_workspaces.is_default, true),
      ),
    )
    .limit(1);
  if (def) return def;

  throw new Error(
    `user ${userId} has no workspace row — migration 0021 backfill missed?`,
  );
}

/**
 * Resolve the workspace a user-scoped agent bearer token is pinned to.
 *
 * Preference:
 *   1. `agents.user_workspace_id` if set.
 *   2. The user's currently-active workspace (legacy fallback for tokens
 *      minted before workspace pinning — returns the default workspace when
 *      active_user_workspace_id is null).
 *
 * Called by the bearer-auth middleware for every user-scoped agent request.
 */
export async function resolveWorkspaceForUserAgent(
  agent: Pick<InferSelectModel<typeof agents>, 'user_id' | 'user_workspace_id'>,
): Promise<UserWorkspace> {
  if (agent.user_workspace_id) {
    const [row] = await db
      .select()
      .from(user_workspaces)
      .where(eq(user_workspaces.id, agent.user_workspace_id))
      .limit(1);
    if (row) return row;
  }
  if (!agent.user_id) {
    throw new Error(
      'resolveWorkspaceForUserAgent called on an agent without user_id',
    );
  }
  return resolveActiveUserWorkspace(agent.user_id);
}

// ---------------------------------------------------------------------------
// Write helpers — create / switch / rename / delete
// ---------------------------------------------------------------------------

export interface CreateUserWorkspaceArgs {
  userId: string;
  name: string;
  slug?: string;
  makeActive?: boolean;
  /**
   * Skip the MAX_WORKSPACES_PER_USER guard. Only set by the signup path, which
   * needs to always succeed when minting the very first Default workspace.
   */
  bypassLimit?: boolean;
  /**
   * When set, the new workspace becomes the user's is_default row. Caller is
   * responsible for clearing the previous default first — the partial unique
   * index refuses two is_default=true rows per user.
   */
  asDefault?: boolean;
}

export async function createUserWorkspace(
  args: CreateUserWorkspaceArgs,
): Promise<UserWorkspace> {
  const name = args.name.trim();
  if (!name || name.length > 80) {
    throw new UserWorkspaceError(
      'invalid_name',
      'name must be 1-80 characters',
    );
  }

  if (!args.bypassLimit) {
    const existing = await db
      .select({ id: user_workspaces.id })
      .from(user_workspaces)
      .where(eq(user_workspaces.user_id, args.userId));
    if (existing.length >= MAX_WORKSPACES_PER_USER) {
      throw new UserWorkspaceError(
        'limit_reached',
        `max ${MAX_WORKSPACES_PER_USER} workspaces per user`,
      );
    }
  }

  const rawSlug = args.slug ?? slugify(name);
  if (!SLUG_RE.test(rawSlug) || rawSlug.length < 1 || rawSlug.length > 40) {
    throw new UserWorkspaceError(
      'invalid_slug',
      'slug must match [a-z0-9-]+ and be 1-40 chars',
    );
  }

  // If the caller pinned a slug, honour it strictly; otherwise resolve
  // collisions by appending a short suffix.
  let slug = rawSlug;
  if (!args.slug) {
    slug = await nextAvailableSlug(args.userId, rawSlug);
  } else {
    const [clash] = await db
      .select({ id: user_workspaces.id })
      .from(user_workspaces)
      .where(
        and(
          eq(user_workspaces.user_id, args.userId),
          eq(user_workspaces.slug, slug),
        ),
      )
      .limit(1);
    if (clash) {
      throw new UserWorkspaceError(
        'slug_taken',
        `slug "${slug}" already used in this account`,
      );
    }
  }

  const inboxAlias = await mintWorkspaceInboxAlias(slug);

  const [inserted] = await db
    .insert(user_workspaces)
    .values({
      user_id: args.userId,
      name,
      slug,
      is_default: args.asDefault ?? false,
      inbox_alias: inboxAlias,
    })
    .returning();

  if (args.makeActive) {
    await db
      .update(users)
      .set({ active_user_workspace_id: inserted.id })
      .where(eq(users.id, args.userId));
  }

  return inserted;
}

/**
 * Mint the initial "Default" workspace for a brand-new user. Called from the
 * signup path. Idempotent: if the user already has a workspace, returns the
 * existing default without touching the DB further.
 *
 * When `explicitInboxAlias` is provided the workspace inherits it (so
 * `users.inbox_alias` and the default workspace's alias stay aligned, which
 * is what the migration 0021 backfill produces for existing users). When
 * omitted, a fresh unique alias is minted from `emailForAlias`.
 */
export async function ensureDefaultUserWorkspace(
  userId: string,
  emailForAlias: string,
  explicitInboxAlias?: string,
): Promise<UserWorkspace> {
  const [existing] = await db
    .select()
    .from(user_workspaces)
    .where(
      and(
        eq(user_workspaces.user_id, userId),
        eq(user_workspaces.is_default, true),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const inboxAlias = explicitInboxAlias ?? (await mintWorkspaceInboxAlias(emailForAlias));
  const [inserted] = await db
    .insert(user_workspaces)
    .values({
      user_id: userId,
      name: 'Default',
      slug: 'default',
      is_default: true,
      inbox_alias: inboxAlias,
    })
    .returning();

  // Keep the legacy `users.inbox_alias` mirrored to the default workspace's
  // alias so readers that haven't migrated off it (scripts, email-parse
  // fallback) still see the same value.
  await db
    .update(users)
    .set({
      active_user_workspace_id: inserted.id,
      inbox_alias: inboxAlias,
    })
    .where(and(eq(users.id, userId), isNull(users.active_user_workspace_id)));

  return inserted;
}

export async function switchActiveUserWorkspace(
  userId: string,
  workspaceId: string,
): Promise<UserWorkspace> {
  const [row] = await db
    .select()
    .from(user_workspaces)
    .where(
      and(eq(user_workspaces.id, workspaceId), eq(user_workspaces.user_id, userId)),
    )
    .limit(1);
  if (!row) throw new UserWorkspaceError('not_found', 'workspace not found');

  await db
    .update(users)
    .set({ active_user_workspace_id: workspaceId })
    .where(eq(users.id, userId));

  return row;
}

export async function renameUserWorkspace(
  userId: string,
  workspaceId: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) {
    throw new UserWorkspaceError('invalid_name', 'name must be 1-80 characters');
  }
  const [row] = await db
    .select({ id: user_workspaces.id })
    .from(user_workspaces)
    .where(
      and(eq(user_workspaces.id, workspaceId), eq(user_workspaces.user_id, userId)),
    )
    .limit(1);
  if (!row) throw new UserWorkspaceError('not_found', 'workspace not found');
  await db
    .update(user_workspaces)
    .set({ name: trimmed })
    .where(eq(user_workspaces.id, workspaceId));
}

export interface DeleteUserWorkspaceArgs {
  userId: string;
  workspaceId: string;
  confirmName: string;
}

/**
 * Hard-delete a personal workspace. Every row with an FK onto this workspace
 * either cascades (accounts, signup_jobs, magic_links, agents pinned to this
 * workspace) or is set to null (audit_log, email_messages) — see migration
 * 0021.
 *
 * Guardrails:
 *   1. Workspace must belong to `userId` — 'not_found' otherwise.
 *   2. is_default workspaces cannot be deleted (designate another default
 *      first). Error 'is_default'.
 *   3. A user's last remaining workspace cannot be deleted. Error
 *      'last_remaining'. (Belt-and-braces: the is_default guard already
 *      catches this because the migration guarantees every user has
 *      is_default=true on one row, but we check anyway for defense in depth.)
 *   4. `confirmName` must equal the workspace's `name` exactly.
 */
export async function deleteUserWorkspace(
  args: DeleteUserWorkspaceArgs,
): Promise<void> {
  const [row] = await db
    .select()
    .from(user_workspaces)
    .where(
      and(
        eq(user_workspaces.id, args.workspaceId),
        eq(user_workspaces.user_id, args.userId),
      ),
    )
    .limit(1);
  if (!row) throw new UserWorkspaceError('not_found', 'workspace not found');

  if (row.is_default) {
    throw new UserWorkspaceError(
      'is_default',
      'the default workspace cannot be deleted — make another workspace default first',
    );
  }

  const allRows = await db
    .select({ id: user_workspaces.id })
    .from(user_workspaces)
    .where(eq(user_workspaces.user_id, args.userId));
  if (allRows.length <= 1) {
    throw new UserWorkspaceError(
      'last_remaining',
      'cannot delete your only remaining workspace',
    );
  }

  if (args.confirmName.trim() !== row.name) {
    throw new UserWorkspaceError(
      'name_mismatch',
      'confirm name must equal the workspace name exactly',
    );
  }

  // If the workspace being deleted is currently active, flip the user back
  // to their default workspace BEFORE the cascade so we never transiently
  // hold a dangling active_user_workspace_id.
  const [userRow] = await db
    .select()
    .from(users)
    .where(eq(users.id, args.userId))
    .limit(1);
  if (userRow?.active_user_workspace_id === row.id) {
    const [def] = await db
      .select()
      .from(user_workspaces)
      .where(
        and(
          eq(user_workspaces.user_id, args.userId),
          eq(user_workspaces.is_default, true),
        ),
      )
      .limit(1);
    await db
      .update(users)
      .set({ active_user_workspace_id: def?.id ?? null })
      .where(eq(users.id, args.userId));
  }

  await db.insert(audit_log).values({
    agent_id: null,
    action: 'user_workspace_delete',
    target: row.id,
    metadata: {
      workspace_slug: row.slug,
      workspace_name: row.name,
      by_user_id: args.userId,
    },
    user_id: args.userId,
  });

  await db.delete(user_workspaces).where(eq(user_workspaces.id, row.id));
}
