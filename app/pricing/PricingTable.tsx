'use client';

import { useState } from 'react';
import Link from 'next/link';

interface PricingCell {
  id: string;
  name: string;
  subtitle: string;
  /** Monthly price (numeric), or null for trial/custom tiers. */
  monthlyAmount: number | null;
  /** Yearly price at 17% off — null for tiers that don't offer yearly. */
  yearlyAmount: number | null;
  /** Static fallback amount for trial/custom tiers (e.g., '0' or 'Custom'). */
  staticAmount?: string;
  /** Static fallback unit (e.g., 'trial' for Founders). */
  staticUnit?: string;
  blurb: string;
  bullets: string[];
  action: { label: string; href: string; external?: boolean };
  aside: { text: string; emphasis?: string };
  pop?: boolean;
  badge?: string;
}

const CELLS: PricingCell[] = [
  {
    id: 'founders',
    name: 'Founders',
    subtitle: 'trial',
    monthlyAmount: null,
    yearlyAmount: null,
    staticAmount: '0',
    staticUnit: 'trial',
    blurb: 'Spin up an integrator tenant and try it for free.',
    bullets: ['100 actions', '60-day cap', 'No card required', 'Community support'],
    action: { label: 'Start trial →', href: '/login?next=/dev/billing' },
    aside: { text: 'No card.', emphasis: 'Drop off at 100 actions or 60 days.' },
  },
  {
    id: 'builder',
    name: 'Builder',
    subtitle: 'solo devs',
    monthlyAmount: 49,
    yearlyAmount: 490,
    blurb: 'Solo developers and side projects shipping real products.',
    bullets: [
      '1,000 actions / month',
      '$0.05 per overage action',
      'Email support',
      '30-day audit log',
    ],
    action: { label: 'Subscribe →', href: '/login?next=/dev/billing' },
    aside: { text: 'Cancel anytime.', emphasis: 'Prorated to the hour.' },
  },
  {
    id: 'starter',
    name: 'Starter',
    subtitle: 'small teams',
    monthlyAmount: 199,
    yearlyAmount: 1910,
    blurb: 'Small teams shipping a real product — the most picked tier.',
    bullets: [
      '10,000 actions / month',
      '$0.02 per overage action',
      'Priority email support',
      '7-day audit log retention',
    ],
    action: { label: 'Subscribe →', href: '/login?next=/dev/billing' },
    aside: { text: 'Fits most teams.', emphasis: 'Upgrade when you cross 8k.' },
    pop: true,
    badge: 'Most picked',
  },
  {
    id: 'growth',
    name: 'Growth',
    subtitle: 'scaling',
    monthlyAmount: 999,
    yearlyAmount: 8990,
    blurb: 'Scaling tenants with steady volume and predictable burn.',
    bullets: [
      '50,000 actions / month',
      '$0.02 per overage action',
      'Priority support',
      '90-day audit log retention',
    ],
    action: { label: 'Subscribe →', href: '/login?next=/dev/billing' },
    aside: { text: '99.5% uptime SLA.', emphasis: 'Status room included.' },
  },
  {
    id: 'scale',
    name: 'Scale',
    subtitle: 'benchmark + SLA',
    monthlyAmount: 2999,
    yearlyAmount: 24820,
    blurb: 'Production-grade SLA, benchmark probe, priority support.',
    bullets: [
      '300,000 actions / month',
      '$0.01 per overage action',
      '99.9% uptime SLA',
      'Scale benchmark probe',
    ],
    action: { label: 'Subscribe →', href: '/login?next=/dev/billing' },
    aside: { text: 'Priority support.', emphasis: 'Scale-specific SLA.' },
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    subtitle: 'security-led orgs',
    monthlyAmount: null,
    yearlyAmount: null,
    staticAmount: 'Custom',
    blurb: 'VPC deploys, custom BAAs, volume pricing, dedicated CSM.',
    bullets: [
      'SSO / SAML + SCIM',
      'Data residency + BAA',
      '99.95% uptime SLA',
      'Dedicated CSM',
    ],
    action: {
      label: 'Contact sales →',
      href: 'mailto:sales@cumulush.com?subject=Relay%20Enterprise%20inquiry',
      external: true,
    },
    aside: { text: 'SOC 2, HIPAA BAAs.', emphasis: 'Reply same day.' },
  },
];

type Interval = 'monthly' | 'yearly';

function formatAmount(n: number): string {
  return n.toLocaleString('en-US');
}

export default function PricingTable() {
  const [interval, setInterval] = useState<Interval>('monthly');

  return (
    <>
      <div className="bill-wrap">
        <div className="bill-note">Plans — pay per billable action</div>
        <div className="bill-note-right" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span>USD</span>
          <span
            role="tablist"
            aria-label="Billing interval"
            style={{
              display: 'inline-flex',
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
              Yearly
              <small style={{ marginLeft: 6, opacity: 0.85 }}>save up to 31%</small>
            </button>
          </span>
        </div>
      </div>

      <section className="offer" aria-label="Plan tiers">
        {CELLS.map((p) => {
          // Resolve the displayed price for this interval.
          let amountText: string;
          let unitText: string | undefined;
          let savingsText: string | null = null;
          let showCurr = true;

          if (p.staticAmount === 'Custom') {
            amountText = 'Custom';
            unitText = undefined;
            showCurr = false;
          } else if (p.id === 'founders') {
            amountText = p.staticAmount ?? '0';
            unitText = p.staticUnit;
          } else if (interval === 'yearly' && p.yearlyAmount !== null && p.monthlyAmount !== null) {
            amountText = formatAmount(p.yearlyAmount);
            unitText = '/ yr';
            const annualised = p.monthlyAmount * 12;
            const saved = annualised - p.yearlyAmount;
            savingsText = `Save $${formatAmount(saved)}`;
          } else if (p.monthlyAmount !== null) {
            amountText = formatAmount(p.monthlyAmount);
            unitText = '/ mo';
          } else {
            amountText = p.staticAmount ?? '0';
            unitText = p.staticUnit;
          }

          return (
            <article
              key={p.id}
              className="cell"
              data-pop={p.pop ? 'true' : undefined}
            >
              {p.badge && <span className="badge">{p.badge}</span>}
              <div className="name">
                {p.name}
                <small>{p.subtitle}</small>
              </div>
              <div className="price">
                {showCurr && <span className="curr">$</span>}
                <span>{amountText}</span>
                {unitText && <small>{unitText}</small>}
              </div>
              {savingsText && (
                <div
                  className="savings-pill"
                  style={{
                    display: 'inline-block',
                    marginTop: -8,
                    marginBottom: 12,
                    padding: '2px 8px',
                    fontSize: 12,
                    borderRadius: 999,
                    background: 'var(--color-accent, #1f6f43)',
                    color: 'var(--color-paper, white)',
                  }}
                >
                  {savingsText}
                </div>
              )}
              <p className="blurb">{p.blurb}</p>
              <ul className="bullets">
                {p.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              {p.action.external ? (
                <a href={p.action.href} className="action">
                  <span>{p.action.label.replace(' →', '')}</span>
                  <span>→</span>
                </a>
              ) : (
                <Link href={p.action.href} className="action">
                  <span>{p.action.label.replace(' →', '')}</span>
                  <span>→</span>
                </Link>
              )}
              <div className="aside">
                {p.aside.text} {p.aside.emphasis && <b>{p.aside.emphasis}</b>}
              </div>
            </article>
          );
        })}
      </section>
    </>
  );
}
