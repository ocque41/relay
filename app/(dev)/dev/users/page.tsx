import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, desc, eq, sql } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { signup_jobs, users } from '@/src/server/db/schema';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Row } from '@/app/components/Row';

export default async function DevUsersPage() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  if (session.activeWorkspace.kind !== 'tenant') redirect('/dev');
  const tenantId = session.activeWorkspace.tenantId;

  const grouped = await db
    .select({
      user_id: signup_jobs.user_id,
      email: users.email,
      signups: sql<number>`count(${signup_jobs.id})::int`,
      last_signup_at: sql<Date | null>`max(${signup_jobs.created_at})`,
    })
    .from(signup_jobs)
    .innerJoin(users, eq(users.id, signup_jobs.user_id))
    .where(eq(signup_jobs.tenant_id, tenantId))
    .groupBy(signup_jobs.user_id, users.email);

  const withLatest = await Promise.all(
    grouped.map(async (r) => {
      if (!r.user_id) {
        return {
          ...r,
          latest: null as { provider_slug: string | null; status: string } | null,
        };
      }
      const [latest] = await db
        .select({
          provider_slug: signup_jobs.provider_slug,
          status: signup_jobs.status,
        })
        .from(signup_jobs)
        .where(
          and(
            eq(signup_jobs.tenant_id, tenantId),
            eq(signup_jobs.user_id, r.user_id),
          ),
        )
        .orderBy(desc(signup_jobs.created_at))
        .limit(1);
      return { ...r, latest: latest ?? null };
    }),
  );

  return (
    <>
      <header className="head">
        <div>
          <Kicker>03 — Users</Kicker>
          <H1>
            End users,
            <br />
            via this tenant.
          </H1>
        </div>
        <div className="headmeta">
          <b>{withLatest.length}</b> total
        </div>
      </header>

      {withLatest.length === 0 ? (
        <Row label="Status">No signups yet.</Row>
      ) : (
        withLatest.map((u) => (
          <Row key={u.user_id ?? 'anon'} label={u.email}>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--color-ink-3)',
                letterSpacing: '0.04em',
              }}
            >
              {u.signups} signup{u.signups === 1 ? '' : 's'}
              {u.latest && (
                <> · last: {u.latest.provider_slug ?? '—'} · {u.latest.status}</>
              )}
              {u.last_signup_at && (
                <>
                  {' '}·{' '}
                  {new Date(u.last_signup_at).toISOString().slice(0, 16).replace('T', ' ')}
                </>
              )}
            </div>
          </Row>
        ))
      )}
    </>
  );
}
