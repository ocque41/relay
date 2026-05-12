'use client';

import { useState } from 'react';

type Plan = 'founders' | 'builder' | 'starter' | 'growth' | 'scale';
type Interval = 'monthly' | 'yearly';

interface PlanCell {
  id: Plan | 'enterprise';
  name: string;
  subtitle: string;
  /** Numeric monthly price; null for trial/custom tiers. */
  monthlyAmount: number | null;
  /** Numeric yearly price (17% off); null when no yearly variant. */
  yearlyAmount: number | null;
  /** Static price for non-numeric tiers. */
  staticAmount?: string;
  staticUnit?: string;
  blurb: string;
  bullets: string[];
  pop?: boolean;
  badge?: string;
}

const PLANS: PlanCell[] = [
  {
    id: 'founders',
    name: 'Founders',
    subtitle: 'trial',
    monthlyAmount: null,
    yearlyAmount: null,
    staticAmount: '$0',
    staticUnit: 'trial',
    blurb: '100 actions OR 60 days — whichever ends first.',
    bullets: [
      '100 actions included',
      'Trial only · no overage',
      'Community support',
      'Upgrade anytime',
    ],
  },
  {
    id: 'builder',
    name: 'Builder',
    subtitle: 'solo devs',
    monthlyAmount: 49,
    yearlyAmount: 490,
    blurb: 'Solo developers and side projects shipping a real product.',
    bullets: [
      '1,000 actions / month included',
      '$0.05 per overage action',
      'Email support',
      'Audit log',
    ],
  },
  {
    id: 'starter',
    name: 'Starter',
    subtitle: 'small teams',
    monthlyAmount: 199,
    yearlyAmount: 1910,
    blurb: 'Small teams shipping a real product — the most picked tier.',
    bullets: [
      '10,000 actions / month included',
      '$0.02 per overage action',
      'Priority email, 1-day SLA',
      '7-day audit log retention',
    ],
    pop: true,
    badge: 'Most picked',
  },
  {
    id: 'growth',
    name: 'Growth',
    subtitle: 'scaling',
    monthlyAmount: 999,
    yearlyAmount: 8990,
    blurb: 'Scaling tenants with steady volume.',
    bullets: [
      '50,000 actions / month included',
      '$0.02 per overage action',
      '4-hour SLA',
      '90-day audit log retention',
    ],
  },
  {
    id: 'scale',
    name: 'Scale',
    subtitle: 'benchmark + SLA',
    monthlyAmount: 2999,
    yearlyAmount: 24820,
    blurb: '99.9% uptime SLA, benchmark probe, priority support.',
    bullets: [
      '300,000 actions / month included',
      '$0.01 per overage action',
      '99.9% uptime SLA',
      'Scale benchmark probe',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    subtitle: 'security-led orgs',
    monthlyAmount: null,
    yearlyAmount: null,
    staticAmount: 'Custom',
    blurb: 'SSO, data residency, BAAs, volume pricing.',
    bullets: [
      'Custom quota + overage',
      '99.95% uptime SLA',
      'SSO / SAML + SCIM',
      'Data residency + BAA',
    ],
  },
];

function formatAmount(n: number): string {
  return n.toLocaleString('en-US');
}

export default function PlansLadder({
  currentPlan,
  hasCustomer,
}: {
  currentPlan: string | null;
  hasCustomer: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [interval, setInterval] = useState<Interval>('monthly');

  async function subscribe(plan: Plan) {
    setBusy(plan);
    setError(null);
    try {
      const res = await fetch('/v1/dev/billing/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ plan, interval }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `${res.status} ${res.statusText}`);
      }
      const { url } = (await res.json()) as { url: string };
      window.location.href = url;
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  async function openPortal() {
    setBusy('portal');
    setError(null);
    try {
      const res = await fetch('/v1/dev/billing/portal', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `${res.status} ${res.statusText}`);
      }
      const { url } = (await res.json()) as { url: string };
      window.location.href = url;
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  return (
    <>
      <div
        role="tablist"
        aria-label="Billing interval"
        style={{
          display: 'inline-flex',
          margin: '8px 0 16px',
          border: '1px solid var(--color-hair)',
          borderRadius: 999,
          overflow: 'hidden',
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={interval === 'monthly'}
          onClick={() => setInterval('monthly')}
          style={{
            padding: '6px 14px',
            background: interval === 'monthly' ? 'var(--color-ink)' : 'transparent',
            color: interval === 'monthly' ? 'var(--color-paper)' : 'inherit',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 13,
          }}
        >
          Monthly
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={interval === 'yearly'}
          onClick={() => setInterval('yearly')}
          style={{
            padding: '6px 14px',
            background: interval === 'yearly' ? 'var(--color-ink)' : 'transparent',
            color: interval === 'yearly' ? 'var(--color-paper)' : 'inherit',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 13,
          }}
        >
          Yearly <small style={{ marginLeft: 6, opacity: 0.85 }}>save up to 31%</small>
        </button>
      </div>

      <section className="plans" aria-label="Plan tiers">
        {PLANS.map((p) => {
          const isCurrent = p.id === currentPlan;
          const isEnterprise = p.id === 'enterprise';
          const isFounders = p.id === 'founders';

          // Founders is monthly-only (free trial). Enterprise is "Custom".
          const showsYearly =
            interval === 'yearly' && p.yearlyAmount !== null && p.monthlyAmount !== null;

          let priceCurr: string | undefined = '$';
          let priceAmount: string;
          let priceUnit: string | undefined;
          let savings: string | null = null;

          if (p.staticAmount) {
            priceCurr = p.staticAmount.startsWith('$') ? undefined : '$';
            priceAmount = p.staticAmount.replace(/^\$/, '');
            priceUnit = p.staticUnit;
            if (p.staticAmount === 'Custom') priceCurr = undefined;
          } else if (showsYearly) {
            priceAmount = formatAmount(p.yearlyAmount!);
            priceUnit = '/ yr';
            savings = `Save $${formatAmount(p.monthlyAmount! * 12 - p.yearlyAmount!)}`;
          } else {
            priceAmount = formatAmount(p.monthlyAmount ?? 0);
            priceUnit = '/ mo';
          }

          const ctaLabel = isCurrent
            ? 'Current plan'
            : isEnterprise
              ? 'Contact sales'
              : busy === p.id
                ? 'Opening Stripe…'
                : isFounders
                  ? 'Start trial'
                  : interval === 'yearly'
                    ? 'Subscribe — yearly'
                    : 'Subscribe';

          const PriceBlock = (
            <div className="p-price">
              {priceCurr && <span className="curr">{priceCurr}</span>}
              <span className="val">{priceAmount}</span>
              {priceUnit && <small>{priceUnit}</small>}
            </div>
          );

          return (
            <article
              key={p.id}
              className="plan"
              data-pop={p.pop ? 'true' : undefined}
              aria-current={isCurrent ? 'true' : undefined}
            >
              {p.badge && !isCurrent && <span className="badge">{p.badge}</span>}
              {isCurrent && <span className="badge">Current</span>}
              <div className="p-name">
                {p.name}
                <small>{p.subtitle}</small>
              </div>
              {PriceBlock}
              {savings && (
                <div
                  style={{
                    fontSize: 11,
                    marginTop: -4,
                    marginBottom: 6,
                    padding: '1px 7px',
                    display: 'inline-block',
                    borderRadius: 999,
                    background: 'var(--color-accent, #1f6f43)',
                    color: 'var(--color-paper, white)',
                  }}
                >
                  {savings}
                </div>
              )}
              <p className="p-blurb">{p.blurb}</p>
              <ul className="p-feat">
                {p.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>

              {isEnterprise ? (
                <a
                  className="p-cta"
                  href="mailto:sales@cumulush.com?subject=Relay%20Enterprise%20inquiry"
                >
                  {ctaLabel}
                </a>
              ) : (
                <button
                  type="button"
                  className="p-cta"
                  onClick={() => subscribe(p.id as Plan)}
                  disabled={busy !== null || isCurrent}
                >
                  {ctaLabel}
                </button>
              )}
            </article>
          );
        })}
      </section>

      <div className="plans-portal">
        <button
          type="button"
          className="p-cta"
          onClick={openPortal}
          disabled={busy !== null || !hasCustomer}
        >
          {busy === 'portal' ? 'Opening portal…' : 'Manage subscription'}
        </button>
        {!hasCustomer && (
          <span className="plans-portal-note">
            Subscribe once to unlock the Stripe portal.
          </span>
        )}
      </div>

      {error && <div className="plans-error">{error}</div>}
    </>
  );
}
