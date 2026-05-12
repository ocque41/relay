import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { users } from '@/src/server/db/schema';
import { listUserWorkspaces } from '@/src/server/user-workspaces';
import {
  deleteUserWorkspaceFromForm,
  renameUserWorkspaceAction,
  switchUserWorkspaceAction,
} from './actions';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Row } from '@/app/components/Row';

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  background: 'transparent',
  border: '1px solid var(--color-hair)',
  borderRadius: 5.5,
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
} as const;

const primaryButton = {
  padding: '8px 14px',
  background: 'var(--color-ink)',
  color: 'var(--color-paper)',
  border: 0,
  borderRadius: 5.5,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.1em',
  textTransform: 'uppercase' as const,
  cursor: 'pointer',
};

const dangerButton = {
  padding: '8px 14px',
  background: '#c03030',
  color: '#fff',
  border: 0,
  borderRadius: 5.5,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.1em',
  textTransform: 'uppercase' as const,
  cursor: 'pointer',
};

export default async function MyWorkspacesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');

  const params = (await searchParams) ?? {};
  const ok = Array.isArray(params.ok) ? params.ok[0] : params.ok;
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  const wsInError = Array.isArray(params.ws) ? params.ws[0] : params.ws;

  const workspaces = await listUserWorkspaces(session.userId);
  const [u] = await db
    .select({ active_id: users.active_user_workspace_id })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  const activeId =
    u?.active_id ??
    workspaces.find((w) => w.is_default)?.id ??
    workspaces[0]?.id ??
    null;

  const catchallDomain = process.env.CATCHALL_DOMAIN ?? 'mail.example.com';

  return (
    <>
      <header className="head">
        <div>
          <Kicker>Personal workspaces</Kicker>
          <H1>
            Your
            <br />
            workspaces.
          </H1>
        </div>
        <div className="headmeta">
          <b>{workspaces.length}</b>
          {workspaces.length === 1 ? ' workspace' : ' workspaces'}
        </div>
      </header>

      {ok ? (
        <Row label="">
          <div
            style={{
              padding: '10px 12px',
              background: '#eefaf2',
              border: '1px solid #2f8a56',
              borderRadius: 5.5,
              fontSize: 13,
              color: '#184d30',
            }}
          >
            {ok}
          </div>
        </Row>
      ) : null}

      {error ? (
        <Row label="">
          <div
            style={{
              padding: '10px 12px',
              background: '#fff5f5',
              border: '1px solid #c03030',
              borderRadius: 5.5,
              fontSize: 13,
              color: '#742020',
            }}
          >
            {error}
          </div>
        </Row>
      ) : null}

      <Row label="How workspaces work">
        Each workspace is a separate space for your accounts, API keys, and
        inbox. Use them to keep projects, clients, or personal experiments
        isolated. Agents you create in one workspace can&apos;t see the other
        workspaces&apos; data.
        <br />
        <br />
        <Link href="/me/workspaces/new" style={{ fontWeight: 500 }}>
          + New workspace
        </Link>
      </Row>

      {workspaces.map((w) => {
        const isActive = w.id === activeId;
        const canDelete = !w.is_default && workspaces.length > 1;
        const highlightError = wsInError === w.id ? error : null;
        return (
          <Row
            key={w.id}
            label={
              <>
                {w.name}
                {w.is_default ? (
                  <span
                    style={{
                      marginLeft: 8,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      letterSpacing: '0.14em',
                      textTransform: 'uppercase',
                      color: 'var(--color-ink-3)',
                    }}
                  >
                    default
                  </span>
                ) : null}
                {isActive ? (
                  <span
                    style={{
                      marginLeft: 8,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      letterSpacing: '0.14em',
                      textTransform: 'uppercase',
                      color: 'var(--color-ink)',
                    }}
                  >
                    active
                  </span>
                ) : null}
              </>
            }
          >
            <div style={{ display: 'grid', gap: 16 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-ink-3)' }}>
                slug <b style={{ color: 'var(--color-ink)' }}>/{w.slug}</b>
                {w.inbox_alias ? (
                  <>
                    {' · '}inbox{' '}
                    <b style={{ color: 'var(--color-ink)' }}>
                      {w.inbox_alias}@{catchallDomain}
                    </b>
                  </>
                ) : null}
              </div>

              {highlightError ? (
                <div
                  style={{
                    padding: '8px 10px',
                    background: '#fff5f5',
                    border: '1px solid #c03030',
                    borderRadius: 5.5,
                    fontSize: 12,
                    color: '#742020',
                  }}
                >
                  {highlightError}
                </div>
              ) : null}

              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                {!isActive ? (
                  <form action={switchUserWorkspaceAction.bind(null, w.id)}>
                    <button type="submit" style={primaryButton}>
                      Open
                    </button>
                  </form>
                ) : null}

                <form
                  action={renameUserWorkspaceAction.bind(null, w.id)}
                  style={{ display: 'flex', gap: 8, alignItems: 'center' }}
                >
                  <input
                    type="text"
                    name="name"
                    defaultValue={w.name}
                    required
                    style={{ ...inputStyle, width: 220 }}
                  />
                  <button
                    type="submit"
                    style={{
                      padding: '8px 14px',
                      background: 'transparent',
                      color: 'var(--color-ink)',
                      border: '1px solid var(--color-ink)',
                      borderRadius: 5.5,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                      cursor: 'pointer',
                    }}
                  >
                    Rename
                  </button>
                </form>
              </div>

              {canDelete ? (
                <details
                  style={{
                    border: '1px solid #c03030',
                    borderRadius: 5.5,
                    padding: 12,
                  }}
                >
                  <summary
                    style={{
                      cursor: 'pointer',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                      color: '#c03030',
                    }}
                  >
                    Danger zone — delete this workspace
                  </summary>
                  <div style={{ marginTop: 12, fontSize: 13, color: 'var(--color-ink-2)', lineHeight: 1.5 }}>
                    Permanently removes this workspace and every account, API
                    key, inbox message, share link, and signup history scoped
                    to it. The agent tokens pinned to this workspace are
                    revoked. This cannot be undone.
                  </div>
                  <form
                    action={deleteUserWorkspaceFromForm.bind(null, w.id)}
                    style={{ marginTop: 12, display: 'grid', gap: 10 }}
                  >
                    <label style={{ fontSize: 13, color: 'var(--color-ink-2)' }}>
                      Type{' '}
                      <b style={{ fontFamily: 'var(--font-mono)' }}>{w.name}</b>{' '}
                      to confirm:
                    </label>
                    <input
                      name="confirm_name"
                      required
                      autoComplete="off"
                      style={inputStyle}
                      placeholder={w.name}
                    />
                    <button type="submit" style={{ ...dangerButton, alignSelf: 'flex-start' }}>
                      Delete workspace
                    </button>
                  </form>
                </details>
              ) : (
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--color-ink-3)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {w.is_default
                    ? 'The default workspace cannot be deleted.'
                    : 'You can\'t delete your only remaining workspace.'}
                </div>
              )}
            </div>
          </Row>
        );
      })}
    </>
  );
}
