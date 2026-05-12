import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { accounts, api_keys } from '@/src/server/db/schema';
import { resolveActiveUserWorkspace } from '@/src/server/user-workspaces';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Row } from '@/app/components/Row';

export default async function MyKeysPage() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  const ws = await resolveActiveUserWorkspace(session.userId);

  const rows = await db
    .select({
      id: api_keys.id,
      label: api_keys.label,
      account_id: api_keys.account_id,
      account_label: accounts.label,
      provider_id: accounts.provider_id,
      created_at: api_keys.created_at,
      last_revealed_at: api_keys.last_revealed_at,
    })
    .from(api_keys)
    .innerJoin(accounts, eq(accounts.id, api_keys.account_id))
    .where(
      and(
        eq(accounts.user_id, session.userId),
        eq(accounts.user_workspace_id, ws.id),
        isNull(api_keys.revoked_at),
      ),
    )
    .orderBy(desc(api_keys.created_at));

  return (
    <>
      <header className="head">
        <div>
          <Kicker>04 — Keys</Kicker>
          <H1>
            API keys,
            <br />
            bookkeeping only.
          </H1>
        </div>
        <div className="headmeta">
          <b>{rows.length}</b> active
        </div>
      </header>

      <Row label="How this works">
        Relay does <strong>not</strong> store your third-party API keys. Only a
        bookkeeping row is kept (label, provider-side id, timestamps) so the key
        can be rotated or revoked. Ask your agent for a fresh key when you need
        one.
      </Row>

      {rows.length === 0 ? (
        <Row label="Status">No keys yet.</Row>
      ) : (
        rows.map((k) => (
          <Row key={k.id} label={k.provider_id}>
            <div style={{ fontWeight: 500 }}>{k.label}</div>
            <div
              style={{
                marginTop: 4,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--color-ink-3)',
                letterSpacing: '0.04em',
              }}
            >
              {k.account_label}
              {k.created_at && <> · created {new Date(k.created_at).toISOString().slice(0, 10)}</>}
              {k.last_revealed_at && (
                <> · revealed {new Date(k.last_revealed_at).toISOString().slice(0, 10)}</>
              )}
            </div>
          </Row>
        ))
      )}
    </>
  );
}
