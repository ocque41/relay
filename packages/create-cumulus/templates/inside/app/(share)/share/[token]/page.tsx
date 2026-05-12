/**
 * /share/[token] — session-less, single-use, read-only summary.
 *
 * Token format: mls_<base64url(32 bytes)>. We hash it and look up magic_links.
 * On first successful render we stamp `claimed_at` and increment `used_count`.
 * Max-use exceeded → "already used" message. Expired → "link expired".
 */
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { db } from '@/src/server/db/index';
import {
  accounts,
  magic_links,
  signup_jobs,
} from '@/src/server/db/schema';
import { hashToken } from '@/src/server/crypto';
import { Kicker } from '@/app/components/Kicker';

function page(children: React.ReactNode) {
  return (
    <main>
      <Kicker>Relay — shared summary</Kicker>
      <div style={{ marginTop: 24 }}>{children}</div>
      <div
        style={{
          marginTop: 96,
          paddingTop: 24,
          borderTop: '1px solid var(--color-hair)',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--color-ink-3)',
          letterSpacing: '0.04em',
          lineHeight: 1.6,
        }}
      >
        This link is read-only and session-less. Relay does not associate any
        account with the viewer of this page.
      </div>
    </main>
  );
}

function H(props: { children: React.ReactNode }) {
  return (
    <h1
      style={{
        fontFamily: 'var(--font-display)',
        fontWeight: 300,
        fontSize: 40,
        lineHeight: 0.95,
        letterSpacing: '-0.035em',
        margin: 0,
      }}
    >
      {props.children}
    </h1>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 40,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.2em',
        textTransform: 'uppercase',
        color: 'var(--color-ink-3)',
        marginBottom: 14,
      }}
    >
      {children}
    </div>
  );
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const tokenHash = hashToken(token);

  const [link] = await db
    .select()
    .from(magic_links)
    .where(eq(magic_links.token_hash, tokenHash))
    .limit(1);

  if (!link) {
    return page(
      <>
        <H>Invalid link</H>
        <p style={{ marginTop: 20, fontSize: 14, color: 'var(--color-ink-2)' }}>
          This link is not recognized. It may have been revoked or never existed.
        </p>
      </>,
    );
  }

  if (link.expires_at.getTime() < Date.now()) {
    return page(
      <>
        <H>Link expired</H>
        <p style={{ marginTop: 20, fontSize: 14, color: 'var(--color-ink-2)' }}>
          This link has expired. Ask for a new one.
        </p>
      </>,
    );
  }

  if (link.used_count >= link.max_uses) {
    return page(
      <>
        <H>Link already used</H>
        <p style={{ marginTop: 20, fontSize: 14, color: 'var(--color-ink-2)' }}>
          This link has been claimed. Ask for a new one.
        </p>
      </>,
    );
  }

  const now = new Date();
  await db
    .update(magic_links)
    .set({
      claimed_at: link.claimed_at ?? now,
      used_count: link.used_count + 1,
    })
    .where(eq(magic_links.id, link.id));

  const userId = link.user_id;
  // Share links are workspace-scoped. A link minted in workspace A must never
  // leak workspace B's data. Legacy links without a workspace id fall back to
  // showing the user's whole account set so old URLs keep working.
  const linkWs = link.user_workspace_id ?? null;

  const accountRows = await db
    .select({
      provider_id: accounts.provider_id,
      label: accounts.label,
      email_alias: accounts.email_alias,
      created_at: accounts.created_at,
    })
    .from(accounts)
    .where(
      linkWs
        ? and(
            eq(accounts.user_id, userId),
            eq(accounts.user_workspace_id, linkWs),
          )
        : eq(accounts.user_id, userId),
    )
    .orderBy(desc(accounts.created_at));

  const recentSignups = await db
    .select({
      id: signup_jobs.id,
      status: signup_jobs.status,
      provider_slug: signup_jobs.provider_slug,
      created_at: signup_jobs.created_at,
    })
    .from(signup_jobs)
    .where(
      linkWs
        ? and(
            eq(signup_jobs.user_id, userId),
            or(
              eq(signup_jobs.user_workspace_id, linkWs),
              isNull(signup_jobs.user_workspace_id),
            ),
          )
        : eq(signup_jobs.user_id, userId),
    )
    .orderBy(desc(signup_jobs.created_at))
    .limit(10);

  return page(
    <>
      <H>Your Relay summary</H>
      <p
        style={{
          marginTop: 16,
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          letterSpacing: '0.04em',
          color: 'var(--color-ink-3)',
        }}
      >
        {accountRows.length} account{accountRows.length === 1 ? '' : 's'} ·{' '}
        {recentSignups.length} recent signup{recentSignups.length === 1 ? '' : 's'}
      </p>

      <Label>Accounts</Label>
      {accountRows.length === 0 ? (
        <p style={{ fontSize: 14, color: 'var(--color-ink-2)' }}>None yet.</p>
      ) : (
        accountRows.map((a, i) => (
          <div
            key={i}
            style={{
              padding: '12px 0',
              borderBottom: '1px solid var(--color-hair-soft)',
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
            }}
          >
            <span style={{ color: 'var(--color-ink-3)', fontSize: 10, letterSpacing: '0.2em', textTransform: 'uppercase' }}>
              {a.provider_id}
            </span>
            <div style={{ marginTop: 4 }}>{a.label}</div>
            {a.email_alias && (
              <div style={{ marginTop: 2, color: 'var(--color-ink-3)', fontSize: 11 }}>
                {a.email_alias}
              </div>
            )}
            <div style={{ marginTop: 4, color: 'var(--color-ink-3)', fontSize: 11 }}>
              {a.created_at ? new Date(a.created_at).toISOString().slice(0, 10) : ''}
            </div>
          </div>
        ))
      )}

      <Label>Recent signups</Label>
      {recentSignups.length === 0 ? (
        <p style={{ fontSize: 14, color: 'var(--color-ink-2)' }}>None yet.</p>
      ) : (
        recentSignups.map((s) => (
          <div
            key={s.id}
            style={{
              padding: '12px 0',
              borderBottom: '1px solid var(--color-hair-soft)',
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              display: 'flex',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <span>
              {s.provider_slug ?? '—'}
              <span style={{ color: 'var(--color-ink-3)', marginLeft: 10 }}>{s.status}</span>
            </span>
            <span style={{ color: 'var(--color-ink-3)', fontSize: 11 }}>
              {s.created_at ? new Date(s.created_at).toISOString().slice(0, 10) : ''}
            </span>
          </div>
        ))
      )}
    </>,
  );
}
