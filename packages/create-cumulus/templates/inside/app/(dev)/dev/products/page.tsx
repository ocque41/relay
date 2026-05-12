import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { and, eq, gt, sql } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { signup_jobs, tenant_providers } from '@/src/server/db/schema';
import AddProductForm from './AddProductForm';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Row } from '@/app/components/Row';

export default async function DevProductsPage() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  if (session.activeWorkspace.kind !== 'tenant') redirect('/dev');
  const tenantId = session.activeWorkspace.tenantId;

  const products = await db
    .select()
    .from(tenant_providers)
    .where(eq(tenant_providers.tenant_id, tenantId));

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const summaries = await Promise.all(
    products.map(async (p) => {
      const [total] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(signup_jobs)
        .where(eq(signup_jobs.provider_slug, p.slug));
      const [week] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(signup_jobs)
        .where(and(eq(signup_jobs.provider_slug, p.slug), gt(signup_jobs.created_at, weekAgo)));
      return { p, total: Number(total?.count ?? 0), week: Number(week?.count ?? 0) };
    }),
  );

  return (
    <>
      <header className="head">
        <div>
          <Kicker>02 — Products</Kicker>
          <H1>
            Webhooks
            <br />
            for agent signup.
          </H1>
        </div>
        <div className="headmeta">
          <b>{products.length}</b> registered
        </div>
      </header>

      <Row label="How this works">
        Each product is a webhook Relay will dispatch agent-signup calls to.
      </Row>

      <Row label="Register new">
        <AddProductForm />
      </Row>

      {summaries.length === 0 ? (
        <Row label="Registered">None yet.</Row>
      ) : (
        summaries.map(({ p, total, week }) => (
          <Row key={p.id} label={p.slug}>
            <Link
              href={`/dev/products/${p.slug}`}
              style={{
                borderBottom: '1px solid var(--color-ink)',
                paddingBottom: 1,
                fontWeight: 500,
              }}
            >
              {p.display_name}
            </Link>
            <div
              style={{
                marginTop: 4,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--color-ink-3)',
                letterSpacing: '0.04em',
                wordBreak: 'break-all',
              }}
            >
              → {p.signup_webhook_url}
            </div>
            <div
              style={{
                marginTop: 8,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--color-ink-3)',
                letterSpacing: '0.04em',
              }}
            >
              {week} this week · {total} total
            </div>
          </Row>
        ))
      )}
    </>
  );
}
