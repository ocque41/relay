import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { and, desc, eq } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { accounts } from '@/src/server/db/schema';
import { resolveActiveUserWorkspace } from '@/src/server/user-workspaces';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Row } from '@/app/components/Row';

export default async function MyAccountsPage() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  const ws = await resolveActiveUserWorkspace(session.userId);

  const rows = await db
    .select({
      id: accounts.id,
      provider_id: accounts.provider_id,
      label: accounts.label,
      email_alias: accounts.email_alias,
      status: accounts.status,
      created_at: accounts.created_at,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.user_id, session.userId),
        eq(accounts.user_workspace_id, ws.id),
      ),
    )
    .orderBy(desc(accounts.created_at));

  const byProvider = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byProvider.get(r.provider_id) ?? [];
    list.push(r);
    byProvider.set(r.provider_id, list);
  }

  return (
    <>
      <header className="head">
        <div>
          <Kicker>02 — Accounts</Kicker>
          <H1>
            Third-party
            <br />
            accounts.
          </H1>
        </div>
        <div className="headmeta">
          <b>{rows.length}</b> total
        </div>
      </header>

      {rows.length === 0 ? (
        <Row label="Status">
          No accounts yet. Ask an agent to sign up on your behalf — the account
          will appear here.
        </Row>
      ) : (
        <>
          {[...byProvider.entries()].map(([provider, list]) => (
            <Row key={provider} label={provider}>
              {list.map((a) => (
                <div key={a.id} style={{ marginBottom: 18 }}>
                  <Link
                    href={`/me/accounts/${a.id}`}
                    style={{
                      borderBottom: '1px solid var(--color-ink)',
                      paddingBottom: 1,
                      fontWeight: 500,
                    }}
                  >
                    {a.label}
                  </Link>
                  {a.email_alias && (
                    <span
                      style={{
                        marginLeft: 12,
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        color: 'var(--color-ink-3)',
                      }}
                    >
                      {a.email_alias}
                    </span>
                  )}
                  <div
                    style={{
                      marginTop: 4,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: 'var(--color-ink-3)',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {a.status}
                    {a.created_at && (
                      <> · created {new Date(a.created_at).toISOString().slice(0, 10)}</>
                    )}
                  </div>
                </div>
              ))}
            </Row>
          ))}
        </>
      )}
    </>
  );
}
