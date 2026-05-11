/**
 * /dev/billing — tenant subscription + action-quota plans.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import {
  plan_catalog,
  tenant_quota_state,
  tenant_subscriptions,
} from '@/src/server/db/schema';
import { totalCreditsRemaining } from '@/src/server/billing/credits';
import PlansLadder from './PlansLadder';
import CreditPacks from './CreditPacks';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Stat, Stats } from '@/app/components/Stat';
import { Row } from '@/app/components/Row';

type StatusBanner = 'success' | 'cancel' | null;

function Banner({ status }: { status: StatusBanner }) {
  if (!status) return null;
  const msg =
    status === 'success'
      ? 'Subscription created. Stripe will deliver a webhook within a few seconds that updates the row below.'
      : 'Checkout canceled. No subscription was created.';
  return <div className="plans-banner">{msg}</div>;
}

function QuotaBar({ remaining, total }: { remaining: number; total: number }) {
  if (total <= 0) return null;
  const used = Math.max(total - remaining, 0);
  const pct = Math.min(100, Math.round((used / total) * 100));
  const warn = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : 'ok';
  return (
    <div className="plans-quota">
      <div className="plans-quota-track">
        <div
          className="plans-quota-fill"
          data-level={warn}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="plans-quota-label">
        {used.toLocaleString()} / {total.toLocaleString()} actions used
      </div>
    </div>
  );
}

const MATRIX_GROUPS: Array<{
  title: string;
  rows: Array<[string, string, string, string, string, string, string]>;
}> = [
  {
    title: 'Quota',
    rows: [
      ['Included actions / mo', '100 total', '1,000', '10,000', '50,000', '300,000', 'Custom'],
      ['Overage rate', '—', '$0.05', '$0.02', '$0.02', '$0.01', 'Custom'],
      ['Failed-action refund', '✓', '✓', '✓', '✓', '✓', '✓'],
      ['Trial length', '60 days', '—', '—', '—', '—', '—'],
    ],
  },
  {
    title: 'Support',
    rows: [
      ['Support channel', 'Community', 'Email', 'Priority email', 'Priority email', 'Priority email', 'Dedicated CSM'],
      ['Dedicated CSM', '—', '—', '—', '—', '—', '✓'],
    ],
  },
  {
    title: 'Reliability',
    rows: [
      ['Uptime SLA', '—', '—', '—', '99.5%', '99.9%', '99.95%'],
      ['Benchmark probe', '—', '—', '—', '—', '✓', '✓'],
      ['Status-page incidents', 'Public', 'Public', 'Public', 'Public', 'Public', 'Private room'],
    ],
  },
  {
    title: 'Security & compliance',
    rows: [
      ['Audit log retention', '—', '30 days', '7 days', '90 days', '180 days', 'Unlimited'],
      ['SSO / SAML', '—', '—', '—', '—', 'On request', '✓'],
      ['Data residency', '—', '—', '—', '—', 'On request', '✓'],
      ['SOC 2 report', '—', 'On request', 'On request', '✓', '✓', '✓'],
      ['HIPAA BAA', '—', '—', '—', 'On request', 'On request', '✓'],
      ['VPC / private deploy', '—', '—', '—', '—', '—', '✓'],
    ],
  },
];

const FAQS: Array<{ q: string; a: string; open?: boolean }> = [
  {
    q: 'How does overage billing work?',
    open: true,
    a: 'Every action past your included quota queues a per-action invoice item at the plan rate. Items flush monthly via a Stripe invoice item tied to the same subscription, so you see one bill per period.',
  },
  {
    q: 'When does my quota refresh?',
    a: "Quota resets at the start of every Stripe billing cycle — the 'Period ends' date above. Changing plans mid-period resets the counter to the new plan's included allowance.",
  },
  {
    q: 'What counts as a billable action?',
    a: "Signups, API key reveals, key rotations, and account deletes each count as one action. Read-only operations — listing accounts, fetching status, browsing the catalog — are always free. Failed actions automatically refund the quota slot.",
  },
  {
    q: 'Can I downgrade mid-period?',
    a: 'Yes. Pick the lower tier and Stripe Checkout will prorate the difference on the next invoice. Downgrades take effect at the end of the current period; you keep the current plan\'s included quota until then.',
  },
];

export default async function DevBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  if (session.activeWorkspace.kind !== 'tenant') redirect('/dev');

  const tenantId = session.activeWorkspace.tenantId;
  const [row] = await db
    .select()
    .from(tenant_subscriptions)
    .where(eq(tenant_subscriptions.tenant_id, tenantId))
    .orderBy(desc(tenant_subscriptions.created_at))
    .limit(1);

  const [quotaRow] = await db
    .select()
    .from(tenant_quota_state)
    .where(eq(tenant_quota_state.tenant_id, tenantId))
    .limit(1);

  const planId = row?.plan ?? 'founders';
  const [planRow] = await db
    .select()
    .from(plan_catalog)
    .where(eq(plan_catalog.id, planId))
    .limit(1);

  const creditsRemaining = await totalCreditsRemaining(tenantId);

  const sp = await searchParams;
  const banner: StatusBanner =
    sp.status === 'success' ? 'success' : sp.status === 'cancel' ? 'cancel' : null;

  const status = row?.status ?? null;
  const plan = row?.plan ?? null;
  const billingInterval = row?.billing_interval ?? 'monthly';
  const periodEnd = row?.current_period_end ? new Date(row.current_period_end) : null;
  const trialEndsAt = row?.trial_ends_at ? new Date(row.trial_ends_at) : null;
  const canceledAt = row?.canceled_at ? new Date(row.canceled_at) : null;
  const hasCustomer = Boolean(row?.stripe_customer_id);

  const includedTotal = planRow?.included_actions ?? 0;
  const includedRemaining = quotaRow?.included_remaining ?? 0;
  const overageCount = quotaRow?.overage_count ?? 0;
  const overagePriceCents = planRow?.overage_price_cents ?? 0;
  const overageSpendCents = overageCount * overagePriceCents;
  // Show credit-pack CTA when the tenant has burned ≥ 90% of their plan
  // pool, OR if they already hold credits.
  const lowOnQuota =
    includedTotal > 0 && includedRemaining <= Math.floor(includedTotal * 0.1);
  const showCredits = lowOnQuota || creditsRemaining > 0;
  const intervalLabel =
    billingInterval === 'yearly' ? 'Yearly' : 'Monthly';

  return (
    <div className="plans-screen">
      <header className="head">
        <div>
          <Kicker>05 — Billing</Kicker>
          <H1>
            Action
            <br />
            quota.
          </H1>
          <p className="plans-lede">
            Integrators pay; end-users are free. Every plan ships with a monthly
            action quota covering signups, key reveals, rotations, and deletes;
            anything above bills at the plan&apos;s per-action overage rate on
            your next Stripe invoice. Failed actions refund the quota slot
            automatically.
          </p>
        </div>
        <div className="headmeta">
          <b>{plan ? plan[0]!.toUpperCase() + plan.slice(1) : 'No plan'}</b>
          <br />
          {status ?? 'no subscription'}
          {plan && (
            <>
              <br />
              <small style={{ opacity: 0.7 }}>{intervalLabel} billing</small>
            </>
          )}
        </div>
      </header>

      {banner && (
        <Row label="Status">
          <Banner status={banner} />
        </Row>
      )}

      <Stats>
        <Stat
          label="Included remaining"
          value={
            includedTotal === -1
              ? 'Unlimited'
              : `${includedRemaining.toLocaleString()} / ${includedTotal.toLocaleString()}`
          }
        />
        <Stat
          label="Credits remaining"
          value={creditsRemaining > 0 ? creditsRemaining.toLocaleString() : '—'}
        />
        <Stat
          label="Overage this period"
          value={
            overageCount === 0
              ? '—'
              : `${overageCount} × $${(overagePriceCents / 100).toFixed(2)}`
          }
        />
        <Stat
          label="Overage spend"
          value={`$${(overageSpendCents / 100).toFixed(2)}`}
        />
      </Stats>

      {includedTotal > 0 && (
        <Row label="Utilization">
          <QuotaBar remaining={includedRemaining} total={includedTotal} />
        </Row>
      )}

      <Stats>
        <Stat
          label="Period ends"
          value={periodEnd ? periodEnd.toISOString().slice(0, 10) : '—'}
        />
        <Stat
          label="Trial ends"
          value={trialEndsAt ? trialEndsAt.toISOString().slice(0, 10) : '—'}
        />
        <Stat
          label="Canceled"
          value={canceledAt ? canceledAt.toISOString().slice(0, 10) : '—'}
        />
      </Stats>

      <PlansLadder currentPlan={plan} hasCustomer={hasCustomer} />

      {showCredits && plan && plan !== 'founders' && plan !== 'enterprise' && (
        <CreditPacks currentPlan={plan} />
      )}

      <section className="plans-matrix" aria-label="Feature matrix">
        <h2>Everything, compared.</h2>
        <div className="plans-matrix-scroll">
          <table>
            <thead>
              <tr>
                <th>Feature</th>
                <th>Founders</th>
                <th>Builder</th>
                <th>Starter</th>
                <th>Growth</th>
                <th>Scale</th>
                <th>Enterprise</th>
              </tr>
            </thead>
            <tbody>
              {MATRIX_GROUPS.flatMap((g) => [
                <tr key={`group-${g.title}`} className="group">
                  <td colSpan={7}>{g.title}</td>
                </tr>,
                ...g.rows.map(([feature, ...cells]) => (
                  <tr key={`${g.title}-${feature}`}>
                    <td>{feature}</td>
                    {cells.map((cell, idx) => (
                      <td
                        key={idx}
                        className={cell === '—' ? 'dash' : 'check'}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
      </section>

      <section className="plans-faq" aria-label="Frequently asked">
        {FAQS.map((f) => (
          <details key={f.q} open={f.open ?? false}>
            <summary>{f.q}</summary>
            <p>{f.a}</p>
          </details>
        ))}
      </section>

      <footer className="plans-foot">
        <div>
          All prices in <b>USD</b> · excludes local tax
        </div>
      </footer>
    </div>
  );
}
