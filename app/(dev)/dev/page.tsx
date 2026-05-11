import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { and, countDistinct, eq, gt, sql } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { signup_jobs, tenants } from '@/src/server/db/schema';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Stat, Stats } from '@/app/components/Stat';
import { Row } from '@/app/components/Row';

export default async function DevOverviewPage() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  if (session.activeWorkspace.kind !== 'tenant') redirect('/dev');

  const tenantId = session.activeWorkspace.tenantId;
  const [t] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!t) redirect('/me');

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [started, complete, failed, awaiting, uniq] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(signup_jobs)
      .where(and(eq(signup_jobs.tenant_id, tenantId), gt(signup_jobs.created_at, weekAgo))),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(signup_jobs)
      .where(
        and(
          eq(signup_jobs.tenant_id, tenantId),
          eq(signup_jobs.status, 'complete'),
          gt(signup_jobs.created_at, weekAgo),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(signup_jobs)
      .where(
        and(
          eq(signup_jobs.tenant_id, tenantId),
          eq(signup_jobs.status, 'failed'),
          gt(signup_jobs.created_at, weekAgo),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(signup_jobs)
      .where(
        and(eq(signup_jobs.tenant_id, tenantId), eq(signup_jobs.status, 'awaiting_email')),
      ),
    db
      .select({ count: countDistinct(signup_jobs.user_id) })
      .from(signup_jobs)
      .where(and(eq(signup_jobs.tenant_id, tenantId), gt(signup_jobs.created_at, weekAgo))),
  ]);

  const startedN = Number(started[0]?.count ?? 0);
  const completeN = Number(complete[0]?.count ?? 0);
  const failedN = Number(failed[0]?.count ?? 0);
  const awaitingN = Number(awaiting[0]?.count ?? 0);
  const uniqN = Number(uniq[0]?.count ?? 0);
  const successRate = startedN === 0 ? null : Math.round((completeN / startedN) * 100);

  return (
    <>
      <header className="head">
        <div>
          <Kicker>01 — Overview</Kicker>
          <H1>{t.name}.</H1>
        </div>
        <div className="headmeta">
          <b>Last 7 days</b>
          <br />
          /{t.slug}
        </div>
      </header>

      <Stats>
        <Stat label="Started" value={startedN} sub="Signups this week" />
        <Stat label="Complete" value={completeN} sub={successRate === null ? '—' : `${successRate}% rate`} />
        <Stat label="Failed" value={failedN} sub="This week" />
      </Stats>

      <Stats>
        <Stat label="Awaiting email" value={awaitingN} sub="All-time, not yet verified" />
        <Stat label="Unique users" value={uniqN} sub="This week" />
        <Stat label="Success rate" value={successRate === null ? '—' : `${successRate}%`} />
      </Stats>

      <Row label="Quick links">
        <Link href="/dev/analytics">Open the analytics dashboard →</Link>
        <br />
        <Link href="/dev/products">Register a new product →</Link>
        <br />
        <Link href="/dev/users">View end-users who signed up →</Link>
        <br />
        <Link href="/dev/audit-log">Browse the audit log →</Link>
      </Row>
    </>
  );
}
