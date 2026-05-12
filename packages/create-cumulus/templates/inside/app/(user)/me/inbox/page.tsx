import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, desc, eq } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { email_messages } from '@/src/server/db/schema';
import { resolveActiveUserWorkspace } from '@/src/server/user-workspaces';
import {
  extractVerificationCode,
  extractVerificationLink,
} from '@/src/server/email/parse';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Row, RowMono } from '@/app/components/Row';
import { MonoVal } from '@/app/components/MonoVal';

export default async function UserInboxPage() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  const ws = await resolveActiveUserWorkspace(session.userId);

  const catchallDomain = process.env.CATCHALL_DOMAIN ?? 'mail.example.com';
  const inboxAddress = ws.inbox_alias ? `${ws.inbox_alias}@${catchallDomain}` : null;

  const rows = await db
    .select({
      id: email_messages.id,
      to: email_messages.to_address,
      from: email_messages.from_address,
      subject: email_messages.subject,
      body_text: email_messages.body_text,
      received_at: email_messages.received_at,
    })
    .from(email_messages)
    .where(
      and(
        eq(email_messages.user_id, session.userId),
        eq(email_messages.user_workspace_id, ws.id),
      ),
    )
    .orderBy(desc(email_messages.received_at))
    .limit(50);

  return (
    <>
      <header className="head">
        <div>
          <Kicker>05 — Inbox</Kicker>
          <H1>
            Agent-readable
            <br />
            email.
          </H1>
        </div>
        <div className="headmeta">
          <b>{rows.length}</b> messages
        </div>
      </header>

      {inboxAddress ? (
        <RowMono label="Your alias">
          <MonoVal value={inboxAddress} />
        </RowMono>
      ) : (
        <Row label="Your alias">
          No alias assigned yet. This will appear after your next login.
        </Row>
      )}

      <Row label="How this works">
        An agent-readable email address owned by Relay. Agents acting on your
        behalf use this address for third-party signups and read the
        verification emails that arrive here.
      </Row>

      {rows.length === 0 ? (
        <Row label="Messages">No messages yet.</Row>
      ) : (
        rows.map((m) => {
          const link = m.body_text ? extractVerificationLink(m.body_text) : null;
          const code = m.body_text ? extractVerificationCode(m.body_text) : null;
          return (
            <Row
              key={m.id}
              label={
                m.received_at
                  ? new Date(m.received_at).toISOString().slice(0, 16).replace('T', ' ')
                  : '—'
              }
            >
              <div style={{ fontWeight: 500 }}>{m.subject || '(no subject)'}</div>
              <div
                style={{
                  marginTop: 4,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--color-ink-3)',
                  letterSpacing: '0.04em',
                }}
              >
                from {m.from} · to {m.to}
              </div>
              {(link || code) && (
                <div
                  style={{
                    marginTop: 10,
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 12,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                  }}
                >
                  {code && (
                    <span
                      style={{
                        padding: '4px 8px',
                        background: 'var(--color-ink)',
                        color: 'var(--color-paper)',
                        borderRadius: 5.5,
                        letterSpacing: '0.04em',
                      }}
                    >
                      code: {code}
                    </span>
                  )}
                  {link && (
                    <a
                      href={link}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        padding: '4px 8px',
                        background: 'var(--color-wash)',
                        border: '1px solid var(--color-hair)',
                        borderRadius: 5.5,
                      }}
                    >
                      {link.slice(0, 60)}
                      {link.length > 60 ? '…' : ''}
                    </a>
                  )}
                </div>
              )}
              {m.body_text && (
                <details style={{ marginTop: 10 }}>
                  <summary
                    style={{
                      cursor: 'pointer',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: 'var(--color-ink-3)',
                      letterSpacing: '0.04em',
                    }}
                  >
                    view body
                  </summary>
                  <pre
                    style={{
                      marginTop: 10,
                      padding: 10,
                      background: 'var(--color-wash)',
                      border: '1px solid var(--color-hair)',
                      borderRadius: 5.5,
                      fontSize: 11,
                      whiteSpace: 'pre-wrap',
                      overflowX: 'auto',
                    }}
                  >
                    {m.body_text}
                  </pre>
                </details>
              )}
            </Row>
          );
        })
      )}
    </>
  );
}
