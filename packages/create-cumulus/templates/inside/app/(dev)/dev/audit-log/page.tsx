import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { desc, eq, sql } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { audit_log } from '@/src/server/db/schema';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Row } from '@/app/components/Row';

const PAGE_SIZE = 50;

export default async function DevAuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page } = await searchParams;
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  if (session.activeWorkspace.kind !== 'tenant') redirect('/dev');
  const tenantId = session.activeWorkspace.tenantId;

  const pageNum = Math.max(1, parseInt(page ?? '1', 10) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;

  const entries = await db
    .select({
      id: audit_log.id,
      agent_id: audit_log.agent_id,
      action: audit_log.action,
      target: audit_log.target,
      metadata: audit_log.metadata,
      created_at: audit_log.created_at,
    })
    .from(audit_log)
    .where(eq(audit_log.tenant_id, tenantId))
    .orderBy(desc(audit_log.created_at))
    .limit(PAGE_SIZE)
    .offset(offset);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(audit_log)
    .where(eq(audit_log.tenant_id, tenantId));

  const total = Number(count ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <header className="head">
        <div>
          <Kicker>07 — Audit log</Kicker>
          <H1>
            Every mutation,
            <br />
            in this tenant.
          </H1>
        </div>
        <div className="headmeta">
          <b>{total}</b> entries
          <br />
          page {pageNum} of {totalPages}
        </div>
      </header>

      {entries.length === 0 ? (
        <Row label="Status">No entries yet.</Row>
      ) : (
        entries.map((e) => (
          <Row
            key={e.id}
            label={
              e.created_at
                ? new Date(e.created_at).toISOString().replace('T', ' ').slice(0, 19)
                : '—'
            }
          >
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                color: 'var(--color-ink)',
              }}
            >
              <span
                style={{
                  background: 'var(--color-ink)',
                  color: 'var(--color-paper)',
                  padding: '2px 8px',
                  borderRadius: 5.5,
                  fontSize: 11,
                  letterSpacing: '0.04em',
                }}
              >
                {e.action}
              </span>
              {e.target && (
                <span style={{ marginLeft: 12, color: 'var(--color-ink-2)' }}>
                  → {e.target}
                </span>
              )}
            </div>
            {e.metadata &&
            typeof e.metadata === 'object' &&
            Object.keys(e.metadata as Record<string, unknown>).length > 0 ? (
              <pre
                style={{
                  marginTop: 10,
                  padding: 10,
                  background: 'var(--color-wash)',
                  border: '1px solid var(--color-hair)',
                  borderRadius: 5.5,
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  overflowX: 'auto',
                }}
              >
                {JSON.stringify(e.metadata, null, 0)}
              </pre>
            ) : null}
          </Row>
        ))
      )}

      {totalPages > 1 && (
        <Row label="Navigate">
          <nav style={{ display: 'flex', gap: 16 }}>
            {pageNum > 1 && (
              <Link href={`/dev/audit-log?page=${pageNum - 1}`}>← Prev</Link>
            )}
            {pageNum < totalPages && (
              <Link href={`/dev/audit-log?page=${pageNum + 1}`}>Next →</Link>
            )}
          </nav>
        </Row>
      )}
    </>
  );
}
