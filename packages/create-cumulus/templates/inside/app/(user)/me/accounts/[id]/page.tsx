import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { accounts, api_keys, signup_jobs } from '@/src/server/db/schema';
import { resolveActiveUserWorkspace } from '@/src/server/user-workspaces';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Stat, Stats } from '@/app/components/Stat';
import { Row, RowMono } from '@/app/components/Row';
import KeyActions from './KeyActions';

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  const ws = await resolveActiveUserWorkspace(session.userId);

  const [acc] = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.id, id),
        eq(accounts.user_id, session.userId),
        eq(accounts.user_workspace_id, ws.id),
      ),
    )
    .limit(1);
  if (!acc) notFound();

  const keys = await db
    .select({
      id: api_keys.id,
      label: api_keys.label,
      provider_key_id: api_keys.provider_key_id,
      created_at: api_keys.created_at,
      last_revealed_at: api_keys.last_revealed_at,
    })
    .from(api_keys)
    .where(and(eq(api_keys.account_id, id), isNull(api_keys.revoked_at)))
    .orderBy(desc(api_keys.created_at));

  const trace = await db
    .select({
      id: signup_jobs.id,
      status: signup_jobs.status,
      provider_slug: signup_jobs.provider_slug,
      created_at: signup_jobs.created_at,
      error: signup_jobs.error,
    })
    .from(signup_jobs)
    .where(eq(signup_jobs.account_id, id))
    .orderBy(desc(signup_jobs.created_at));

  return (
    <>
      <header className="head">
        <div>
          <Kicker>
            <Link href="/me/accounts">02 — Accounts</Link> / {acc.provider_id}
          </Kicker>
          <H1>{acc.label}</H1>
        </div>
        <div className="headmeta">
          <b>{acc.status}</b>
          <br />
          {acc.created_at ? new Date(acc.created_at).toISOString().slice(0, 10) : '—'}
        </div>
      </header>

      <Stats>
        <Stat label="Email alias" value={acc.email_alias ?? '—'} />
        <Stat label="Status" value={acc.status} />
        <Stat
          label="Created"
          value={acc.created_at ? new Date(acc.created_at).toISOString().slice(0, 10) : '—'}
        />
      </Stats>

      <RowMono label="External id">
        <span className="addr">{acc.external_id}</span>
      </RowMono>

      <Row label="API keys">
        Relay does not store key bytes. Minting returns the plaintext once;
        rotation = retrieve-my-key (new plaintext, old one revoked both in
        Relay's bookkeeping and, best-effort, at the provider).
      </Row>

      <Row label="Manage">
        <KeyActions accountId={acc.id} initialKeys={keys} />
      </Row>

      <Row label="Signup trace">
        {trace.length === 0 ? (
          <>No trace rows.</>
        ) : (
          trace.map((t) => (
            <div key={t.id} style={{ marginBottom: 14 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                {t.provider_slug ?? '—'}
              </span>
              <span
                style={{
                  marginLeft: 10,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--color-ink-3)',
                  letterSpacing: '0.04em',
                }}
              >
                {t.status}
                {' · '}
                {t.created_at
                  ? new Date(t.created_at).toISOString().slice(0, 16).replace('T', ' ')
                  : ''}
              </span>
              {t.error && (
                <pre
                  style={{
                    marginTop: 6,
                    padding: 10,
                    background: 'var(--color-wash)',
                    border: '1px solid var(--color-hair)',
                    borderRadius: 5.5,
                    fontSize: 11,
                    fontFamily: 'var(--font-mono)',
                    whiteSpace: 'pre-wrap',
                    overflowX: 'auto',
                  }}
                >
                  {t.error}
                </pre>
              )}
            </div>
          ))
        )}
      </Row>
    </>
  );
}
