/**
 * Tests for src/server/user-workspaces.ts — the helpers behind personal
 * workspace creation, switching, renaming, and deletion.
 *
 * Uses a stateful in-memory DB mock so we can exercise ordering-sensitive
 * flows (delete-active-then-fallback-to-default, is_default guard, etc.)
 * without standing up real Postgres.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface WorkspaceRow {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  is_default: boolean;
  inbox_alias: string | null;
  created_at: Date;
}
interface UserRow {
  id: string;
  email: string;
  inbox_alias: string | null;
  active_user_workspace_id: string | null;
}

// ---------------------------------------------------------------------------
// State that tests set per case.
// ---------------------------------------------------------------------------
const state = {
  workspaces: [] as WorkspaceRow[],
  users: [] as UserRow[],
  auditInserts: [] as unknown[],
  nextId: 0,
};

function makeId(): string {
  state.nextId += 1;
  return `ws-${String(state.nextId).padStart(3, '0')}`;
}

vi.mock('./db/index', async () => {
  const schema = await import('./db/schema');

  function match(
    row: Record<string, unknown>,
    clauses: Array<{ col: string; val: unknown }>,
  ): boolean {
    return clauses.every((c) => row[c.col] === c.val);
  }

  /**
   * Minimal query builder: supports select/from/where/limit/orderBy +
   * insert/values/returning + update/set/where + delete/where.
   *
   * `where` is traced and re-applied when the promise awaits. Only `eq`
   * clauses are supported — that's all the code under test uses.
   */
  interface PendingWhere {
    col: string;
    val: unknown;
  }

  function buildReader(rows: Record<string, unknown>[]) {
    let filters: PendingWhere[] = [];
    let limit: number | null = null;

    const runner = () => {
      let out = rows;
      if (filters.length) {
        out = out.filter((r) => match(r, filters));
      }
      if (limit !== null) out = out.slice(0, limit);
      return out;
    };

    const api: {
      where: (expr: unknown) => typeof api;
      orderBy: () => typeof api;
      limit: (n: number) => Promise<unknown[]>;
      then: (resolve: (v: unknown[]) => void) => void;
      catch: (reject: (e: unknown) => void) => void;
    } = {
      where: (expr: unknown) => {
        // The eq() and and() calls wrap up filters in an object. We peek
        // into the private __drzl_where array that our test-time `eq` stub
        // populates. See the `eq` wrapper below.
        const collected = (expr as { __filters?: PendingWhere[] }).__filters ?? [];
        filters = [...filters, ...collected];
        return api;
      },
      orderBy: () => api,
      limit: (n: number) => {
        limit = n;
        return Promise.resolve(runner());
      },
      then: (resolve: (v: unknown[]) => void) => resolve(runner()),
      catch: () => {},
    };
    return api;
  }

  return {
    db: {
      select: () => ({
        from: (table: unknown) => {
          if (table === schema.user_workspaces) {
            return buildReader(
              state.workspaces.map((w) => ({ ...w })) as Record<string, unknown>[],
            );
          }
          if (table === schema.users) {
            return buildReader(
              state.users.map((u) => ({ ...u })) as Record<string, unknown>[],
            );
          }
          return buildReader([]);
        },
      }),
      insert: (table: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          if (table === schema.user_workspaces) {
            const row: WorkspaceRow = {
              id: (vals.id as string | undefined) ?? makeId(),
              user_id: vals.user_id as string,
              name: vals.name as string,
              slug: vals.slug as string,
              is_default: (vals.is_default as boolean) ?? false,
              inbox_alias: (vals.inbox_alias as string | null) ?? null,
              created_at: new Date(),
            };
            state.workspaces.push(row);
            return {
              returning: () => Promise.resolve([row]),
            };
          }
          if (table === schema.audit_log) {
            state.auditInserts.push(vals);
            return Promise.resolve([]);
          }
          return {
            returning: () => Promise.resolve([]),
          };
        },
      }),
      update: (table: unknown) => ({
        set: (vals: Record<string, unknown>) => ({
          where: (expr: unknown) => {
            const filters = (expr as { __filters?: PendingWhere[] }).__filters ?? [];
            if (table === schema.users) {
              for (const u of state.users) {
                if (match(u as unknown as Record<string, unknown>, filters)) {
                  Object.assign(u, vals);
                }
              }
            }
            if (table === schema.user_workspaces) {
              for (const w of state.workspaces) {
                if (match(w as unknown as Record<string, unknown>, filters)) {
                  Object.assign(w, vals);
                }
              }
            }
            return Promise.resolve([]);
          },
        }),
      }),
      delete: (table: unknown) => ({
        where: (expr: unknown) => {
          const filters = (expr as { __filters?: PendingWhere[] }).__filters ?? [];
          if (table === schema.user_workspaces) {
            state.workspaces = state.workspaces.filter(
              (w) => !match(w as unknown as Record<string, unknown>, filters),
            );
          }
          return Promise.resolve([]);
        },
      }),
    },
  };
});

// drizzle-orm exports we intercept to record filter intent.
vi.mock('drizzle-orm', async (importOriginal) => {
  const mod = (await importOriginal()) as typeof import('drizzle-orm');
  function colName(col: unknown): string {
    // Drizzle column objects carry their SQL name under various internals;
    // happy path for the tests: inspect .name or the quoted SQL string.
    const c = col as { name?: string; fieldAlias?: string };
    return (c.name ?? c.fieldAlias ?? 'col') as string;
  }
  const eq = (col: unknown, val: unknown) => ({
    __filters: [{ col: colName(col), val }],
  });
  const and = (...parts: unknown[]) => ({
    __filters: parts.flatMap(
      (p) => (p as { __filters?: { col: string; val: unknown }[] }).__filters ?? [],
    ),
  });
  const isNull = () => ({ __filters: [] as { col: string; val: unknown }[] });
  return { ...mod, eq, and, isNull };
});

// After the mocks are hoisted — import the SUT.
import {
  createUserWorkspace,
  deleteUserWorkspace,
  ensureDefaultUserWorkspace,
  listUserWorkspaces,
  renameUserWorkspace,
  resolveActiveUserWorkspace,
  switchActiveUserWorkspace,
  UserWorkspaceError,
} from './user-workspaces';

beforeEach(() => {
  state.workspaces = [];
  state.users = [];
  state.auditInserts = [];
  state.nextId = 0;
});

function seedUser(email = 'alice@test.com'): string {
  const id = `user-${state.users.length + 1}`;
  state.users.push({
    id,
    email,
    inbox_alias: null,
    active_user_workspace_id: null,
  });
  return id;
}

describe('ensureDefaultUserWorkspace', () => {
  it('creates the default workspace and points active_user_workspace_id at it', async () => {
    const userId = seedUser('alice@test.com');
    const ws = await ensureDefaultUserWorkspace(userId, 'alice@test.com');
    expect(ws.name).toBe('Default');
    expect(ws.slug).toBe('default');
    expect(ws.is_default).toBe(true);
    expect(ws.inbox_alias).toMatch(/^alice-[0-9a-f]{4}$/);

    const u = state.users.find((x) => x.id === userId)!;
    expect(u.active_user_workspace_id).toBe(ws.id);
  });

  it('honours an explicit inbox alias when provided', async () => {
    const userId = seedUser();
    const ws = await ensureDefaultUserWorkspace(
      userId,
      'alice@test.com',
      'alice-abcd',
    );
    expect(ws.inbox_alias).toBe('alice-abcd');
  });

  it('is idempotent — re-running returns the existing default', async () => {
    const userId = seedUser();
    const first = await ensureDefaultUserWorkspace(userId, 'alice@test.com');
    const second = await ensureDefaultUserWorkspace(userId, 'alice@test.com');
    expect(second.id).toBe(first.id);
    expect(state.workspaces.filter((w) => w.user_id === userId)).toHaveLength(1);
  });
});

describe('resolveActiveUserWorkspace', () => {
  it('returns the active workspace when the pointer is set', async () => {
    const userId = seedUser();
    const ws = await ensureDefaultUserWorkspace(userId, 'alice@test.com');
    const active = await resolveActiveUserWorkspace(userId);
    expect(active.id).toBe(ws.id);
  });

  it('falls back to is_default when active_user_workspace_id is null', async () => {
    const userId = seedUser();
    const def = await ensureDefaultUserWorkspace(userId, 'alice@test.com');
    // Simulate a race where active pointer got cleared.
    state.users.find((u) => u.id === userId)!.active_user_workspace_id = null;
    const active = await resolveActiveUserWorkspace(userId);
    expect(active.id).toBe(def.id);
  });
});

describe('createUserWorkspace', () => {
  it('creates a second workspace with unique inbox alias', async () => {
    const userId = seedUser('alice@test.com');
    await ensureDefaultUserWorkspace(userId, 'alice@test.com');
    const ws = await createUserWorkspace({
      userId,
      name: 'Side project',
    });
    expect(ws.name).toBe('Side project');
    expect(ws.slug).toBe('side-project');
    expect(ws.inbox_alias).not.toBe(state.workspaces[0].inbox_alias);
  });

  it('rejects an empty name', async () => {
    const userId = seedUser();
    await expect(() =>
      createUserWorkspace({ userId, name: '  ' }),
    ).rejects.toBeInstanceOf(UserWorkspaceError);
  });

  it('rejects an invalid slug', async () => {
    const userId = seedUser();
    await expect(() =>
      createUserWorkspace({ userId, name: 'Ok', slug: 'Not A Slug!' }),
    ).rejects.toBeInstanceOf(UserWorkspaceError);
  });

  it('makeActive=true flips users.active_user_workspace_id', async () => {
    const userId = seedUser();
    await ensureDefaultUserWorkspace(userId, 'alice@test.com');
    const ws = await createUserWorkspace({
      userId,
      name: 'Second',
      makeActive: true,
    });
    expect(state.users.find((u) => u.id === userId)!.active_user_workspace_id).toBe(
      ws.id,
    );
  });
});

describe('renameUserWorkspace', () => {
  it('renames an owned workspace', async () => {
    const userId = seedUser();
    const ws = await ensureDefaultUserWorkspace(userId, 'alice@test.com');
    await renameUserWorkspace(userId, ws.id, 'Renamed');
    expect(state.workspaces.find((w) => w.id === ws.id)!.name).toBe('Renamed');
  });

  it('refuses to rename someone else\'s workspace', async () => {
    const aliceId = seedUser('alice@test.com');
    const bobId = seedUser('bob@test.com');
    const alice = await ensureDefaultUserWorkspace(aliceId, 'alice@test.com');
    await expect(() =>
      renameUserWorkspace(bobId, alice.id, 'Stolen'),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('deleteUserWorkspace', () => {
  it('deletes a non-default workspace and logs an audit row', async () => {
    const userId = seedUser();
    await ensureDefaultUserWorkspace(userId, 'alice@test.com');
    const second = await createUserWorkspace({
      userId,
      name: 'Second',
    });
    await deleteUserWorkspace({
      userId,
      workspaceId: second.id,
      confirmName: 'Second',
    });
    expect(state.workspaces.find((w) => w.id === second.id)).toBeUndefined();
    expect(state.auditInserts).toHaveLength(1);
  });

  it('refuses to delete the default workspace', async () => {
    const userId = seedUser();
    const def = await ensureDefaultUserWorkspace(userId, 'alice@test.com');
    await expect(() =>
      deleteUserWorkspace({
        userId,
        workspaceId: def.id,
        confirmName: 'Default',
      }),
    ).rejects.toMatchObject({ kind: 'is_default' });
  });

  it('refuses when confirm name mismatches', async () => {
    const userId = seedUser();
    await ensureDefaultUserWorkspace(userId, 'alice@test.com');
    const second = await createUserWorkspace({ userId, name: 'Second' });
    await expect(() =>
      deleteUserWorkspace({
        userId,
        workspaceId: second.id,
        confirmName: 'second',
      }),
    ).rejects.toMatchObject({ kind: 'name_mismatch' });
  });

  it('refuses when the workspace does not belong to the caller', async () => {
    const aliceId = seedUser('alice@test.com');
    const bobId = seedUser('bob@test.com');
    await ensureDefaultUserWorkspace(aliceId, 'alice@test.com');
    const aliceSecond = await createUserWorkspace({
      userId: aliceId,
      name: 'Alice second',
    });
    await expect(() =>
      deleteUserWorkspace({
        userId: bobId,
        workspaceId: aliceSecond.id,
        confirmName: 'Alice second',
      }),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('flips active pointer back to default when deleting the currently-active workspace', async () => {
    const userId = seedUser();
    const def = await ensureDefaultUserWorkspace(userId, 'alice@test.com');
    const second = await createUserWorkspace({
      userId,
      name: 'Second',
      makeActive: true,
    });
    expect(state.users.find((u) => u.id === userId)!.active_user_workspace_id).toBe(
      second.id,
    );
    await deleteUserWorkspace({
      userId,
      workspaceId: second.id,
      confirmName: 'Second',
    });
    expect(state.users.find((u) => u.id === userId)!.active_user_workspace_id).toBe(
      def.id,
    );
  });
});

describe('switchActiveUserWorkspace', () => {
  it('updates users.active_user_workspace_id when the workspace is owned', async () => {
    const userId = seedUser();
    await ensureDefaultUserWorkspace(userId, 'alice@test.com');
    const second = await createUserWorkspace({ userId, name: 'Second' });
    await switchActiveUserWorkspace(userId, second.id);
    expect(state.users.find((u) => u.id === userId)!.active_user_workspace_id).toBe(
      second.id,
    );
  });

  it('refuses to switch to a workspace owned by someone else', async () => {
    const aliceId = seedUser('alice@test.com');
    const bobId = seedUser('bob@test.com');
    const aliceWs = await ensureDefaultUserWorkspace(aliceId, 'alice@test.com');
    await expect(() =>
      switchActiveUserWorkspace(bobId, aliceWs.id),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('listUserWorkspaces', () => {
  it('returns the default workspace first regardless of insertion order', async () => {
    const userId = seedUser();
    // Create a non-default first, then the default, to verify sort.
    await createUserWorkspace({ userId, name: 'Side' });
    await ensureDefaultUserWorkspace(userId, 'alice@test.com');
    const rows = await listUserWorkspaces(userId);
    expect(rows[0].is_default).toBe(true);
    expect(rows[1].name).toBe('Side');
  });

  it('filters by user_id', async () => {
    const aliceId = seedUser('alice@test.com');
    const bobId = seedUser('bob@test.com');
    await ensureDefaultUserWorkspace(aliceId, 'alice@test.com');
    await ensureDefaultUserWorkspace(bobId, 'bob@test.com');
    const aliceRows = await listUserWorkspaces(aliceId);
    expect(aliceRows).toHaveLength(1);
    expect(aliceRows[0].user_id).toBe(aliceId);
  });
});
