import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, desc, eq, gt } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { magic_links } from '@/src/server/db/schema';
import { resolveActiveUserWorkspace } from '@/src/server/user-workspaces';
import { mintShareLinkAction, revokeShareLinkAction } from './actions';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Row, RowMono } from '@/app/components/Row';
import { MonoVal } from '@/app/components/MonoVal';

export default async function SharePage({
  searchParams,
}: {
  searchParams: Promise<{ minted?: string; expires?: string }>;
}) {
  const { minted, expires } = await searchParams;
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  const ws = await resolveActiveUserWorkspace(session.userId);

  const rows = await db
    .select({
      id: magic_links.id,
      purpose: magic_links.purpose,
      expires_at: magic_links.expires_at,
      claimed_at: magic_links.claimed_at,
      max_uses: magic_links.max_uses,
      used_count: magic_links.used_count,
      created_at: magic_links.created_at,
    })
    .from(magic_links)
    .where(
      and(
        eq(magic_links.user_id, session.userId),
        eq(magic_links.user_workspace_id, ws.id),
        gt(magic_links.expires_at, new Date()),
      ),
    )
    .orderBy(desc(magic_links.created_at));

  const inputStyle = {
    width: 80,
    padding: '6px 10px',
    background: 'transparent',
    border: '1px solid var(--color-hair)',
    borderRadius: 5.5,
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
  } as const;

  return (
    <>
      <header className="head">
        <div>
          <Kicker>07 — Share</Kicker>
          <H1>
            Read-only
            <br />
            share links.
          </H1>
        </div>
        <div className="headmeta">
          <b>{rows.length}</b> active
        </div>
      </header>

      <Row label="How this works">
        Mint a short-lived, read-only URL that opens a minimal summary of your
        Relay data. Useful when an agent wants to hand you a quick view while
        you're away from a computer. Single-use and 10-minute TTL by default.
      </Row>

      {minted && (
        <RowMono label="New link">
          <MonoVal value={minted} />
          {expires && (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--color-ink-3)',
                letterSpacing: '0.04em',
              }}
            >
              expires {new Date(expires).toISOString().replace('T', ' ').slice(0, 16)} UTC
            </span>
          )}
        </RowMono>
      )}

      <Row label="Mint link">
        <form
          action={mintShareLinkAction}
          style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: 'var(--color-ink-3)',
              }}
            >
              TTL (min)
            </span>
            <input type="number" name="ttl_minutes" min={1} max={60} defaultValue={10} style={inputStyle} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: 'var(--color-ink-3)',
              }}
            >
              Max uses
            </span>
            <input type="number" name="max_uses" min={1} max={10} defaultValue={1} style={inputStyle} />
          </label>
          <button
            type="submit"
            style={{
              alignSelf: 'flex-end',
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
            Mint
          </button>
        </form>
      </Row>

      {rows.length === 0 ? (
        <Row label="Active">No active links.</Row>
      ) : (
        rows.map((l) => (
          <Row key={l.id} label={l.purpose}>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--color-ink-3)',
                letterSpacing: '0.04em',
              }}
            >
              expires {new Date(l.expires_at).toISOString().replace('T', ' ').slice(0, 16)} UTC
              {' · '}uses {l.used_count}/{l.max_uses}
              {l.claimed_at && ' · claimed'}
            </div>
            <form
              action={async () => {
                'use server';
                await revokeShareLinkAction(l.id);
              }}
              style={{ marginTop: 10 }}
            >
              <button
                type="submit"
                style={{
                  appearance: 'none',
                  background: 'transparent',
                  border: 0,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: 'var(--color-ink-3)',
                  padding: 0,
                }}
              >
                Revoke →
              </button>
            </form>
          </Row>
        ))
      )}
    </>
  );
}
