/**
 * Server-rendered workspace switcher used in both (user) and (dev) shells.
 *
 * Renders a <details>/<summary> popover with:
 *   - "My workspace" → switches to { kind: 'user' }
 *   - one row per tenant the user can access → switches to { kind: 'tenant', tenantId }
 *
 * Uses plain <form action={serverAction}> so no client JS is needed.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/src/server/db/index';
import { tenant_members, tenants, user_workspaces, users } from '@/src/server/db/schema';
import {
  createDeveloperWorkspaceAction,
  createUserWorkspaceAction,
  switchToTenantWorkspace,
  switchToUserWorkspace,
  switchToUserWorkspaceById,
} from './workspace-actions';

interface Props {
  userId: string;
  active: { kind: 'user' } | { kind: 'tenant'; tenantId: string };
}

const popoverStyle = {
  position: 'absolute' as const,
  left: 0,
  right: 0,
  bottom: 'calc(100% + 4px)',
  zIndex: 12,
  background: 'var(--color-paper)',
  border: '1px solid var(--color-ink)',
  borderRadius: 5.5,
  boxShadow: 'var(--shadow-modal)',
  overflow: 'hidden',
};

const sectionStyle = {
  padding: '12px 14px 6px',
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '0.2em',
  textTransform: 'uppercase' as const,
  color: 'var(--color-ink-4)',
};

const itemStyle = {
  appearance: 'none' as const,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '10px 14px',
  background: 'transparent',
  border: 0,
  textAlign: 'left' as const,
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--color-ink)',
  letterSpacing: '0.02em',
  transition: 'background 120ms, color 120ms',
};

const dotStyle = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'var(--color-ink)',
  flexShrink: 0,
} as const;

const metaStyle = {
  marginLeft: 'auto',
  fontSize: 10,
  color: 'var(--color-ink-3)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase' as const,
};

export default async function WorkspaceSwitcher({ userId, active }: Props) {
  const owned = await db
    .select({ id: tenants.id, slug: tenants.slug, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.owner_user_id, userId));
  const memberOf = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      role: tenant_members.role,
    })
    .from(tenant_members)
    .innerJoin(tenants, eq(tenants.id, tenant_members.tenant_id))
    .where(eq(tenant_members.user_id, userId));

  const seen = new Set<string>();
  const combined: { id: string; slug: string; name: string; role: string }[] = [];
  for (const t of owned) {
    seen.add(t.id);
    combined.push({ ...t, role: 'owner' });
  }
  for (const t of memberOf) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    combined.push({ id: t.id, slug: t.slug, name: t.name, role: t.role as string });
  }

  // Personal user workspaces. Each row in the Workspace group below
  // corresponds to one of these. Default workspace is surfaced first so the
  // switcher is stable regardless of creation order.
  const userWorkspaceRows = await db
    .select({
      id: user_workspaces.id,
      name: user_workspaces.name,
      slug: user_workspaces.slug,
      is_default: user_workspaces.is_default,
    })
    .from(user_workspaces)
    .where(eq(user_workspaces.user_id, userId));
  const userWorkspacesSorted = userWorkspaceRows.sort((a, b) => {
    if (a.is_default && !b.is_default) return -1;
    if (!a.is_default && b.is_default) return 1;
    return a.name.localeCompare(b.name);
  });
  const [userRow] = await db
    .select({ active_id: users.active_user_workspace_id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const activeUserWsId =
    userRow?.active_id ??
    userWorkspacesSorted.find((w) => w.is_default)?.id ??
    userWorkspacesSorted[0]?.id ??
    null;

  const activeUserWs = userWorkspacesSorted.find((w) => w.id === activeUserWsId);
  const label =
    active.kind === 'user'
      ? activeUserWs?.name ?? 'My workspace'
      : combined.find((t) => t.id === active.tenantId)?.name ?? 'Developer';

  return (
    <details className="ws-details" style={{ position: 'relative' }}>
      <summary
        style={{
          listStyle: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          border: '1px solid var(--color-hair)',
          borderRadius: 5.5,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.04em',
          color: 'var(--color-ink)',
          transition: 'border-color 150ms',
        }}
      >
        <span style={dotStyle} />
        <span style={{ flex: 1 }}>{label}</span>
        <span
          style={{
            fontSize: 9,
            color: 'var(--color-ink-3)',
          }}
        >
          ›
        </span>
      </summary>
      <div style={popoverStyle}>
        <div style={sectionStyle}>Workspace</div>
        {userWorkspacesSorted.length === 0 ? (
          // Safety net: if somehow a session lands on a user with no
          // workspaces (migration gap), give them a one-click way to fix it.
          <form action={switchToUserWorkspace}>
            <button
              type="submit"
              style={{
                ...itemStyle,
                fontWeight: active.kind === 'user' ? 500 : 400,
              }}
            >
              <span style={dotStyle} />
              <span style={{ flex: 1 }}>My workspace</span>
              <span style={metaStyle}>user</span>
            </button>
          </form>
        ) : (
          userWorkspacesSorted.map((w) => {
            const isActive =
              active.kind === 'user' && w.id === activeUserWsId;
            return (
              <form
                key={w.id}
                action={switchToUserWorkspaceById.bind(null, w.id)}
              >
                <button
                  type="submit"
                  style={{
                    ...itemStyle,
                    fontWeight: isActive ? 500 : 400,
                  }}
                >
                  <span style={dotStyle} />
                  <span style={{ flex: 1 }}>{w.name}</span>
                  <span style={metaStyle}>
                    {w.is_default ? 'default' : 'user'}
                  </span>
                </button>
              </form>
            );
          })
        )}
        <form action={createUserWorkspaceAction}>
          <button
            type="submit"
            style={{
              ...itemStyle,
              color: 'var(--color-ink-3)',
              borderTop: '1px solid var(--color-hair)',
            }}
          >
            <span style={{ ...dotStyle, background: 'var(--color-ink-3)' }} />
            <span style={{ flex: 1 }}>New workspace</span>
            <span style={metaStyle}>+</span>
          </button>
        </form>
        <div style={sectionStyle}>Developer</div>
        {combined.map((t) => (
          <form
            key={t.id}
            action={switchToTenantWorkspace.bind(null, t.id)}
          >
            <button
              type="submit"
              style={{
                ...itemStyle,
                fontWeight:
                  active.kind === 'tenant' && active.tenantId === t.id
                    ? 500
                    : 400,
              }}
            >
              <span style={dotStyle} />
              <span style={{ flex: 1 }}>{t.name}</span>
              <span style={metaStyle}>{t.role}</span>
            </button>
          </form>
        ))}
        <form action={createDeveloperWorkspaceAction}>
          <button
            type="submit"
            style={{
              ...itemStyle,
              color: 'var(--color-ink-3)',
              borderTop: '1px solid var(--color-hair)',
            }}
          >
            <span style={{ ...dotStyle, background: 'var(--color-ink-3)' }} />
            <span style={{ flex: 1 }}>
              {combined.length === 0 ? 'Become a developer' : 'New developer workspace'}
            </span>
            <span style={metaStyle}>+</span>
          </button>
        </form>
      </div>
    </details>
  );
}
