import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { passkeys } from '@/src/server/db/schema';
import AddPasskey from '@/app/dashboard/security/AddPasskey';
import { removePasskeyAction } from '@/app/dashboard/security/actions';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Row } from '@/app/components/Row';

export default async function MySecurityPage() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');

  const rows = await db
    .select({
      id: passkeys.id,
      name: passkeys.name,
      created_at: passkeys.created_at,
      last_used_at: passkeys.last_used_at,
    })
    .from(passkeys)
    .where(eq(passkeys.user_id, session.userId))
    .orderBy(desc(passkeys.created_at));

  return (
    <>
      <header className="head">
        <div>
          <Kicker>09 — Security</Kicker>
          <H1>
            Passkeys,
            <br />
            one per device.
          </H1>
        </div>
        <div className="headmeta">
          <b>{rows.length}</b> active
        </div>
      </header>

      <Row label="How this works">
        Passkeys let you sign in without email OTP. Register a passkey on any
        device you trust.
      </Row>

      <Row label="Register">
        <AddPasskey />
      </Row>

      {rows.length === 0 ? (
        <Row label="Active">No passkeys registered yet.</Row>
      ) : (
        rows.map((p) => (
          <Row key={p.id} label={p.name ?? '(unnamed)'}>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--color-ink-3)',
                letterSpacing: '0.04em',
              }}
            >
              {p.created_at && <>added {p.created_at.toISOString().slice(0, 10)}</>}
              {p.last_used_at
                ? <> · last used {p.last_used_at.toISOString().slice(0, 10)}</>
                : <> · never used</>}
            </div>
            <form
              action={async () => {
                'use server';
                await removePasskeyAction(p.id);
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
