import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { and, desc, eq } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { signup_jobs, tenant_providers } from '@/src/server/db/schema';
import RotateSecretButton from './RotateSecretButton';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Stat, Stats } from '@/app/components/Stat';
import { Row, RowMono } from '@/app/components/Row';

export default async function DevProductDetail({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  if (session.activeWorkspace.kind !== 'tenant') redirect('/dev');
  const tenantId = session.activeWorkspace.tenantId;

  const [p] = await db
    .select()
    .from(tenant_providers)
    .where(and(eq(tenant_providers.slug, slug), eq(tenant_providers.tenant_id, tenantId)))
    .limit(1);
  if (!p) notFound();

  const recent = await db
    .select({
      id: signup_jobs.id,
      status: signup_jobs.status,
      created_at: signup_jobs.created_at,
      error: signup_jobs.error,
    })
    .from(signup_jobs)
    .where(eq(signup_jobs.provider_slug, slug))
    .orderBy(desc(signup_jobs.created_at))
    .limit(25);

  return (
    <>
      <header className="head">
        <div>
          <Kicker>
            <Link href="/dev/products">02 — Products</Link> / {p.slug}
          </Kicker>
          <H1>{p.display_name}</H1>
        </div>
        <div className="headmeta">
          <b>{p.verification_mode}</b>
          <br />
          {p.created_at ? new Date(p.created_at).toISOString().slice(0, 10) : '—'}
        </div>
      </header>

      <Stats>
        <Stat label="Verification" value={p.verification_mode} />
        <Stat label="Slug" value={p.slug} />
        <Stat
          label="Created"
          value={p.created_at ? new Date(p.created_at).toISOString().slice(0, 10) : '—'}
        />
      </Stats>

      <RowMono label="Signup URL">
        <span className="addr">{p.signup_webhook_url}</span>
      </RowMono>

      <RowMono label="Teardown URL">
        <span className="addr">{p.teardown_webhook_url ?? '—'}</span>
      </RowMono>

      <Row label="Webhook secret">
        Rotating the secret invalidates the previous value immediately. Update{' '}
        <code
          style={{
            padding: '1px 4px',
            background: 'var(--color-wash)',
            borderRadius: 5.5,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
          }}
        >
          RELAY_WEBHOOK_SECRET
        </code>{' '}
        in your deployed integrator before rotating.
        <div style={{ marginTop: 14 }}>
          <RotateSecretButton slug={p.slug} />
        </div>
      </Row>

      <Row label="Recent signups">
        {recent.length === 0 ? (
          <>None yet.</>
        ) : (
          recent.map((r) => (
            <div key={r.id} style={{ marginBottom: 14 }}>
              <span
                style={{
                  background: 'var(--color-ink)',
                  color: 'var(--color-paper)',
                  padding: '2px 8px',
                  borderRadius: 5.5,
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.04em',
                }}
              >
                {r.status}
              </span>
              <span
                style={{
                  marginLeft: 12,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--color-ink-3)',
                  letterSpacing: '0.04em',
                }}
              >
                {r.created_at
                  ? new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')
                  : ''}
              </span>
              {r.error && (
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
                  {r.error}
                </pre>
              )}
            </div>
          ))
        )}
      </Row>
    </>
  );
}
