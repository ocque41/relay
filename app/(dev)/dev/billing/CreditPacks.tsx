'use client';

import { useState } from 'react';

export type CreditPackId = 'builder' | 'starter' | 'growth' | 'scale';

interface PackProp {
  id: CreditPackId;
  /** Plan this pack is sized for (display only). */
  plan: string;
  /** Total actions in the pack. */
  actions: number;
  /** Pre-tax USD cents. */
  amountCents: number;
}

const PACKS: PackProp[] = [
  { id: 'builder', plan: 'Builder', actions: 500, amountCents: 2000 },
  { id: 'starter', plan: 'Starter', actions: 5000, amountCents: 8000 },
  { id: 'growth', plan: 'Growth', actions: 25000, amountCents: 40000 },
  { id: 'scale', plan: 'Scale', actions: 100000, amountCents: 80000 },
];

/**
 * Render a row of credit-pack cards for the active tenant. Clicking a
 * card hits POST /v1/dev/billing/credits/checkout and redirects to
 * Stripe Checkout (mode=payment).
 *
 * Optional `currentPlan` prop highlights the pack whose sizing matches
 * the tenant's active plan; the others stay available because credits
 * remain valid even after a plan change.
 */
export default function CreditPacks({ currentPlan }: { currentPlan: string | null }) {
  const [busy, setBusy] = useState<CreditPackId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function buy(pack: CreditPackId) {
    setBusy(pack);
    setError(null);
    try {
      const res = await fetch('/v1/dev/billing/credits/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ pack }),
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
    <section
      aria-label="Credit packs"
      style={{
        marginTop: 16,
        padding: 16,
        border: '1px solid var(--color-hair)',
        borderRadius: 12,
      }}
    >
      <header style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 18 }}>Need more headroom this period?</h3>
        <p style={{ margin: '4px 0 0', fontSize: 14, opacity: 0.8 }}>
          Buy a one-shot credit pack — priced 20% below your overage rate.
          Credits live 12 months and consume FIFO after your plan’s monthly
          quota, before any overage queues. Failed actions auto-refund.
        </p>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
        }}
      >
        {PACKS.map((p) => {
          const matchesCurrent = currentPlan === p.id;
          return (
            <article
              key={p.id}
              style={{
                padding: 12,
                border: matchesCurrent
                  ? '2px solid var(--color-accent, #1f6f43)'
                  : '1px solid var(--color-hair)',
                borderRadius: 10,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div style={{ fontSize: 13, opacity: 0.7 }}>{p.plan} pack</div>
              <div style={{ fontSize: 22, fontWeight: 600 }}>
                ${(p.amountCents / 100).toLocaleString('en-US')}
                <small style={{ marginLeft: 6, fontSize: 13, opacity: 0.8 }}>
                  · {p.actions.toLocaleString('en-US')} actions
                </small>
              </div>
              <div style={{ fontSize: 12, opacity: 0.65 }}>
                ${(p.amountCents / p.actions / 100).toFixed(3)} / action
              </div>
              <button
                type="button"
                onClick={() => buy(p.id)}
                disabled={busy !== null}
                style={{
                  marginTop: 6,
                  padding: '6px 10px',
                  cursor: busy ? 'wait' : 'pointer',
                  background: matchesCurrent
                    ? 'var(--color-accent, #1f6f43)'
                    : 'var(--color-ink)',
                  color: 'var(--color-paper, white)',
                  border: 'none',
                  borderRadius: 8,
                  fontFamily: 'inherit',
                  fontSize: 13,
                }}
              >
                {busy === p.id ? 'Opening Stripe…' : `Buy ${p.actions.toLocaleString()} credits`}
              </button>
            </article>
          );
        })}
      </div>

      {error && (
        <div
          style={{
            marginTop: 10,
            padding: '6px 10px',
            color: 'var(--color-paper, white)',
            background: 'var(--color-danger, #b00020)',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}
    </section>
  );
}
