import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import {
  accounts,
  agents,
  magic_links,
  signup_jobs,
  users,
} from '@/src/server/db/schema';
import { resolveActiveUserWorkspace } from '@/src/server/user-workspaces';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Stat, Stats } from '@/app/components/Stat';
import { Row, RowMono } from '@/app/components/Row';
import { MonoVal } from '@/app/components/MonoVal';
import { createDeveloperWorkspaceAction } from '@/app/workspace-actions';

export default async function UserOverview({
  searchParams,
}: {
  searchParams: Promise<{ no_tenant?: string }>;
}) {
  const { no_tenant } = await searchParams;
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');

  const catchallDomain = process.env.CATCHALL_DOMAIN ?? 'mail.example.com';

  const [u] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  const ws = await resolveActiveUserWorkspace(session.userId);

  const [accountRows, agentRows, magicRows, recentSignups] = await Promise.all([
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.user_id, session.userId),
          eq(accounts.user_workspace_id, ws.id),
        ),
      ),
    db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.user_id, session.userId),
          eq(agents.user_workspace_id, ws.id),
          isNull(agents.revoked_at),
        ),
      ),
    db
      .select({ id: magic_links.id })
      .from(magic_links)
      .where(
        and(
          eq(magic_links.user_id, session.userId),
          eq(magic_links.user_workspace_id, ws.id),
          isNull(magic_links.claimed_at),
          gt(magic_links.expires_at, new Date()),
        ),
      ),
    db
      .select({
        id: signup_jobs.id,
        status: signup_jobs.status,
        provider_slug: signup_jobs.provider_slug,
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
      .limit(5),
  ]);

  const inboxAddress = ws.inbox_alias ? `${ws.inbox_alias}@${catchallDomain}` : null;

  return (
    <>
      <header className="head">
        <div>
          <Kicker>01 — Overview</Kicker>
          <H1>
            Your
            <br />
            Relay data.
          </H1>
        </div>
        <div className="headmeta">
          <b>{ws.name}</b>
          <br />
          {u?.email ?? session.email}
          {inboxAddress && (
            <>
              <br />
              {inboxAddress}
            </>
          )}
        </div>
      </header>

      {no_tenant && (
        <Row label="No dev workspace">
          You don't have a developer workspace yet. A developer workspace
          represents an app you want agents to sign users up for — it gets
          its own billing, products (tenant providers), audit log, and team.
          <form action={createDeveloperWorkspaceAction} style={{ marginTop: 12 }}>
            <button
              type="submit"
              style={{
                padding: '8px 14px',
                background: 'var(--color-ink)',
                color: 'var(--color-paper)',
                border: 0,
                borderRadius: 5.5,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                cursor: 'pointer',
              }}
            >
              Become a developer →
            </button>
          </form>
        </Row>
      )}

      <Stats>
        <Stat label="Accounts" value={accountRows.length} sub="Created on your behalf" />
        <Stat label="Active agents" value={agentRows.length} sub="Currently running" />
        <Stat label="Share links" value={magicRows.length} sub="Live right now" />
      </Stats>

      {inboxAddress && (
        <RowMono label="Agent inbox">
          <MonoVal value={inboxAddress} />
        </RowMono>
      )}

      <Row label="Recent signups">
        {recentSignups.length === 0 ? (
          <>
            No signups yet. Agents route new account confirmations here — they'll
            appear the moment one lands.
            <br />
            <Link href="/me/signups">View all signups →</Link>
          </>
        ) : (
          <>
            {recentSignups.map((s) => (
              <div key={s.id} style={{ marginBottom: 14 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                  {s.provider_slug ?? '—'}
                </span>
                <span style={{ color: 'var(--color-ink-3)', marginLeft: 10, fontSize: 12 }}>
                  {s.status}
                </span>
                <span
                  style={{
                    color: 'var(--color-ink-3)',
                    marginLeft: 10,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                  }}
                >
                  {s.created_at
                    ? new Date(s.created_at).toISOString().slice(0, 16).replace('T', ' ')
                    : ''}
                </span>
              </div>
            ))}
            <Link href="/me/signups">View all signups →</Link>
          </>
        )}
      </Row>
    </>
  );
}
