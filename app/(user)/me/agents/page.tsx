import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { agents } from '@/src/server/db/schema';
import { resolveActiveUserWorkspace } from '@/src/server/user-workspaces';
import { revokeAgentTokenAction } from '@/app/dashboard/actions';
import TokenMinter from '@/app/dashboard/tokens/TokenMinter';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Row } from '@/app/components/Row';

export default async function MyAgentsPage() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  const ws = await resolveActiveUserWorkspace(session.userId);

  const rows = await db
    .select({
      id: agents.id,
      label: agents.label,
      scopes: agents.scopes,
      created_at: agents.created_at,
      last_used_at: agents.last_used_at,
    })
    .from(agents)
    .where(
      and(
        eq(agents.user_id, session.userId),
        eq(agents.user_workspace_id, ws.id),
        isNull(agents.revoked_at),
      ),
    );

  return (
    <>
      <header className="head">
        <div>
          <Kicker>06 — Agents</Kicker>
          <H1>
            Bearer tokens,
            <br />
            scoped to you.
          </H1>
        </div>
        <div className="headmeta">
          <b>{rows.length}</b> active
        </div>
      </header>

      <Row label="How this works">
        Pass as{' '}
        <code
          style={{
            padding: '1px 4px',
            background: 'var(--color-wash)',
            borderRadius: 5.5,
          }}
        >
          Authorization: Bearer agt_…
        </code>{' '}
        on any <code>/v1/*</code> request, or via the <code>agent_token</code>{' '}
        argument on <code>/mcp</code> tools. Only you and the agent ever see
        these values.
      </Row>

      <Row label="Mint new">
        <TokenMinter />
      </Row>

      {rows.length === 0 ? (
        <Row label="Active">No active tokens.</Row>
      ) : (
        rows.map((t) => (
          <Row key={t.id} label={t.label ?? '(unnamed)'}>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--color-ink-3)',
                letterSpacing: '0.04em',
              }}
            >
              {t.created_at && <>created {t.created_at.toISOString().slice(0, 10)}</>}
              {t.last_used_at
                ? <> · last used {t.last_used_at.toISOString().slice(0, 10)}</>
                : <> · never used</>}
            </div>
            <form
              action={async () => {
                'use server';
                await revokeAgentTokenAction(t.id);
              }}
              style={{ marginTop: 10 }}
            >
              <button
                type="submit"
                style={{
                  appearance: 'none',
                  background: 'transparent',
                  border: 0,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: 'var(--color-ink-3)',
                  padding: 0,
                }}
              >
                Revoke →
              </button>
            </form>
          </Row>
        ))
      )}
    </>
  );
}
