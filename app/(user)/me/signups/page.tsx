import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { signup_jobs, tenants } from '@/src/server/db/schema';
import { resolveActiveUserWorkspace } from '@/src/server/user-workspaces';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Row } from '@/app/components/Row';

export default async function MySignupsPage() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  const ws = await resolveActiveUserWorkspace(session.userId);

  const rows = await db
    .select({
      id: signup_jobs.id,
      status: signup_jobs.status,
      provider_slug: signup_jobs.provider_slug,
      tenant_id: signup_jobs.tenant_id,
      account_id: signup_jobs.account_id,
      error: signup_jobs.error,
      created_at: signup_jobs.created_at,
    })
    .from(signup_jobs)
    .where(
      and(
        eq(signup_jobs.user_id, session.userId),
        eq(signup_jobs.user_workspace_id, ws.id),
      ),
    )
    .orderBy(desc(signup_jobs.created_at))
    .limit(200);

  const tenantIds = [...new Set(rows.map((r) => r.tenant_id).filter((x): x is string => !!x))];
  const tenantRows = tenantIds.length
    ? await db
        .select({ id: tenants.id, name: tenants.name })
        .from(tenants)
        .where(inArray(tenants.id, tenantIds))
    : [];
  const tenantName = new Map(tenantRows.map((t) => [t.id, t.name] as const));

  return (
    <>
      <header className="head">
        <div>
          <Kicker>03 — Signups</Kicker>
          <H1>
            Every signup,
            <br />
            every agent.
          </H1>
        </div>
        <div className="headmeta">
          <b>{rows.length}</b> in last 200
        </div>
      </header>

      {rows.length === 0 ? (
        <Row label="Status">No signups yet.</Row>
      ) : (
        rows.map((r) => (
          <Row
            key={r.id}
            label={
              r.created_at
                ? new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')
                : '—'
            }
          >
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 14,
                color: 'var(--color-ink)',
              }}
            >
              {r.provider_slug ?? '—'}
              {r.tenant_id && (
                <span style={{ color: 'var(--color-ink-3)', marginLeft: 10 }}>
                  via {tenantName.get(r.tenant_id) ?? '—'}
                </span>
              )}
            </div>
            <div
              style={{
                marginTop: 6,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--color-ink-3)',
                letterSpacing: '0.04em',
              }}
            >
              {r.status}
              {r.account_id && <> · acct {r.account_id.slice(0, 8)}…</>}
            </div>
            {r.error && (
              <pre
                style={{
                  marginTop: 10,
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
                {r.error}
              </pre>
            )}
          </Row>
        ))
      )}
    </>
  );
}
