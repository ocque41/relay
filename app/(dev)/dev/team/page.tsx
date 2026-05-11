import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import {
  readSessionFromToken,
  SESSION_COOKIE,
} from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { tenant_members, tenants, users } from '@/src/server/db/schema';
import InviteMemberForm from './InviteMemberForm';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Row } from '@/app/components/Row';

export default async function DevTeamPage() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  if (session.activeWorkspace.kind !== 'tenant') redirect('/dev');
  const tenantId = session.activeWorkspace.tenantId;

  const [t] = await db
    .select({ owner_user_id: tenants.owner_user_id })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!t) redirect('/me');

  const isOwner = t.owner_user_id === session.userId;

  const [ownerRow] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, t.owner_user_id))
    .limit(1);

  const members = await db
    .select({
      user_id: tenant_members.user_id,
      email: users.email,
      role: tenant_members.role,
      created_at: tenant_members.created_at,
    })
    .from(tenant_members)
    .innerJoin(users, eq(users.id, tenant_members.user_id))
    .where(eq(tenant_members.tenant_id, tenantId));

  const otherMembers = members.filter((m) => m.user_id !== t.owner_user_id);

  return (
    <>
      <header className="head">
        <div>
          <Kicker>04 — Team</Kicker>
          <H1>
            Members
            <br />
            of this tenant.
          </H1>
        </div>
        <div className="headmeta">
          <b>{1 + otherMembers.length}</b> total
          <br />
          {isOwner ? 'You are the owner.' : 'Only the owner can invite.'}
        </div>
      </header>

      {isOwner && (
        <Row label="Invite">
          <InviteMemberForm />
        </Row>
      )}

      {ownerRow && (
        <Row label="Owner">
          {ownerRow.email}
        </Row>
      )}

      {otherMembers.length === 0 ? (
        <Row label="Members">No other members.</Row>
      ) : (
        otherMembers.map((m) => (
          <Row key={m.user_id} label={m.role}>
            <div>{m.email}</div>
            {isOwner && (
              <form
                action={async () => {
                  'use server';
                  const jar = await cookies();
                  const s = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
                  if (!s || s.activeWorkspace.kind !== 'tenant') return;
                  await db
                    .delete(tenant_members)
                    .where(
                      and(
                        eq(tenant_members.tenant_id, s.activeWorkspace.tenantId),
                        eq(tenant_members.user_id, m.user_id),
                      ),
                    );
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
                  Remove →
                </button>
              </form>
            )}
          </Row>
        ))
      )}
    </>
  );
}
