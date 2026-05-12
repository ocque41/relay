import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import {
  tenant_feature_flags,
  tenant_subscriptions,
  tenants,
} from '@/src/server/db/schema';
import {
  deleteWorkspaceAction,
  updateTenantNameAction,
  toggleFeatureFlagAction,
} from './actions';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Row } from '@/app/components/Row';

const AVAILABLE_FLAGS = [
  { flag: 'per_product_rate_limits', label: 'Per-product rate limits' },
  { flag: 'webhook_retries', label: 'Webhook retries with backoff' },
  { flag: 'audit_log_export', label: 'CSV export of audit log' },
] as const;

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  background: 'transparent',
  border: '1px solid var(--color-hair)',
  borderRadius: 5.5,
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
} as const;

type DeleteErrorBanner = {
  kind: 'not_owner' | 'name_mismatch' | 'active_subscription' | 'not_found';
  subscriptionStatus?: string;
};

export default async function DevSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  if (session.activeWorkspace.kind !== 'tenant') redirect('/dev');
  const tenantId = session.activeWorkspace.tenantId;

  const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!t) redirect('/me');
  const isOwner = t.owner_user_id === session.userId;

  const params = (await searchParams) ?? {};
  const rawDeleteErr = Array.isArray(params.delete_error)
    ? params.delete_error[0]
    : params.delete_error;
  const rawSubStatus = Array.isArray(params.sub) ? params.sub[0] : params.sub;
  const deleteError: DeleteErrorBanner | null =
    rawDeleteErr === 'not_owner' ||
    rawDeleteErr === 'name_mismatch' ||
    rawDeleteErr === 'active_subscription' ||
    rawDeleteErr === 'not_found'
      ? {
          kind: rawDeleteErr,
          subscriptionStatus: rawSubStatus,
        }
      : null;

  const flags = await db
    .select()
    .from(tenant_feature_flags)
    .where(eq(tenant_feature_flags.tenant_id, tenantId));
  const enabled = new Set(flags.map((f) => f.flag));

  // Look up the most recent subscription so the Danger zone can block the
  // delete button (and tell the owner why) when billing is still live.
  const [sub] = await db
    .select({ status: tenant_subscriptions.status })
    .from(tenant_subscriptions)
    .where(eq(tenant_subscriptions.tenant_id, tenantId))
    .orderBy(desc(tenant_subscriptions.created_at))
    .limit(1);
  const subscriptionBlocksDelete =
    !!sub &&
    (sub.status === 'trialing' ||
      sub.status === 'active' ||
      sub.status === 'past_due');

  return (
    <>
      <header className="head">
        <div>
          <Kicker>06 — Settings</Kicker>
          <H1>
            Tenant
            <br />
            configuration.
          </H1>
        </div>
        <div className="headmeta">
          {isOwner ? <b>You are the owner.</b> : <>Read-only.</>}
        </div>
      </header>

      <Row label="Name">
        <form action={updateTenantNameAction} style={{ display: 'grid', gap: 10, maxWidth: 420 }}>
          <input name="name" defaultValue={t.name} required disabled={!isOwner} style={inputStyle} />
          <button
            type="submit"
            disabled={!isOwner}
            style={{
              alignSelf: 'flex-start',
              padding: '8px 14px',
              background: 'var(--color-ink)',
              color: 'var(--color-paper)',
              border: 0,
              borderRadius: 5.5,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              cursor: isOwner ? 'pointer' : 'not-allowed',
              opacity: isOwner ? 1 : 0.4,
            }}
          >
            Save
          </button>
        </form>
      </Row>

      <Row label="Slug">
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 14,
            color: 'var(--color-ink)',
          }}
        >
          /{t.slug}
        </span>
        <div
          style={{
            marginTop: 6,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--color-ink-3)',
          }}
        >
          Read-only.
        </div>
      </Row>

      {AVAILABLE_FLAGS.map((f) => {
        const on = enabled.has(f.flag);
        return (
          <Row key={f.flag} label={f.flag}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
              <div>
                <div style={{ fontWeight: 500 }}>{f.label}</div>
              </div>
              <form action={toggleFeatureFlagAction.bind(null, f.flag, on)}>
                <button
                  type="submit"
                  style={{
                    padding: '6px 14px',
                    background: on ? 'var(--color-ink)' : 'transparent',
                    color: on ? 'var(--color-paper)' : 'var(--color-ink)',
                    border: '1px solid var(--color-ink)',
                    borderRadius: 5.5,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    cursor: 'pointer',
                  }}
                >
                  {on ? 'On' : 'Off'}
                </button>
              </form>
            </div>
          </Row>
        );
      })}

      {isOwner ? (
        <Row label="Danger zone">
          <div
            style={{
              border: '1px solid #c03030',
              borderRadius: 5.5,
              padding: 16,
              display: 'grid',
              gap: 12,
            }}
          >
            {deleteError ? (
              <div
                style={{
                  padding: '10px 12px',
                  background: '#fff5f5',
                  border: '1px solid #c03030',
                  borderRadius: 5.5,
                  fontSize: 13,
                  color: '#742020',
                }}
              >
                {deleteError.kind === 'name_mismatch'
                  ? 'The name you typed did not match — workspace not deleted.'
                  : deleteError.kind === 'not_owner'
                    ? 'Only the workspace owner can delete it.'
                    : deleteError.kind === 'active_subscription'
                      ? `Billing is still live (${deleteError.subscriptionStatus ?? 'active'}). Cancel it first.`
                      : 'Workspace not found (already deleted?).'}
              </div>
            ) : null}
            <div>
              <div style={{ fontWeight: 500, color: '#c03030' }}>
                Delete this workspace
              </div>
              <div style={{ fontSize: 13, color: 'var(--color-ink-2)', marginTop: 4 }}>
                Permanently removes the workspace and everything scoped to it:
                team members, registered products, feature flags, integrator
                keys, and subscription history. Account rows and signup history
                your end-users own are kept but lose their link to this
                workspace. This action cannot be undone.
              </div>
            </div>

            {subscriptionBlocksDelete ? (
              <div
                style={{
                  padding: '10px 12px',
                  background: '#fff5f5',
                  border: '1px solid #c03030',
                  borderRadius: 5.5,
                  fontSize: 13,
                  color: '#742020',
                }}
              >
                Billing is still live (
                <code style={{ fontFamily: 'var(--font-mono)' }}>
                  {sub!.status}
                </code>
                ). <Link href="/dev/billing">Cancel your subscription</Link>
                {' '}first, then return here.
              </div>
            ) : (
              <form
                action={deleteWorkspaceAction}
                style={{ display: 'grid', gap: 10 }}
              >
                <label style={{ fontSize: 13, color: 'var(--color-ink-2)' }}>
                  Type{' '}
                  <b style={{ fontFamily: 'var(--font-mono)' }}>{t.name}</b>{' '}
                  to confirm:
                </label>
                <input
                  name="confirm_name"
                  required
                  autoComplete="off"
                  style={inputStyle}
                  placeholder={t.name}
                />
                <button
                  type="submit"
                  style={{
                    alignSelf: 'flex-start',
                    padding: '8px 14px',
                    background: '#c03030',
                    color: '#fff',
                    border: 0,
                    borderRadius: 5.5,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    cursor: 'pointer',
                  }}
                >
                  Delete workspace
                </button>
              </form>
            )}
          </div>
        </Row>
      ) : null}
    </>
  );
}
