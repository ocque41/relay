'use client';
import { useState } from 'react';

const button = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '14px 24px',
  background: 'var(--color-ink)',
  color: 'var(--color-paper)',
  border: '1px solid var(--color-ink)',
  borderRadius: 6,
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  letterSpacing: '0.1em',
  textTransform: 'uppercase' as const,
  cursor: 'pointer',
} as const;

const inputStyle = {
  display: 'block',
  width: '100%',
  padding: '12px 14px',
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  border: '1px solid var(--color-rule)',
  borderRadius: 5,
  marginBottom: 12,
  background: 'var(--color-paper)',
  color: 'var(--color-ink)',
} as const;

export function ReserveSprintButton() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [tenantSlug, setTenantSlug] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/v1/checkout/founding-partner-sprint', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prospect_email: email,
          prospect_name: name || undefined,
          tenant_slug: tenantSlug || undefined,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `error ${res.status}`);
        return;
      }
      const j = (await res.json()) as { url: string };
      window.location.href = j.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button type="button" style={button} onClick={() => setOpen(true)}>
        Reserve a sprint — $2,500 →
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      style={{
        maxWidth: 480,
        marginTop: 8,
        padding: 24,
        border: '1px solid var(--color-rule)',
        borderRadius: 8,
        background: 'var(--color-paper)',
      }}
    >
      <input
        type="email"
        placeholder="you@yourcompany.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        style={inputStyle}
      />
      <input
        type="text"
        placeholder="Your name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={inputStyle}
      />
      <input
        type="text"
        placeholder="Tenant slug, if you've already signed up (optional)"
        value={tenantSlug}
        onChange={(e) => setTenantSlug(e.target.value)}
        style={inputStyle}
      />
      <button type="submit" style={button} disabled={loading}>
        {loading ? 'Connecting to Stripe…' : 'Continue to checkout →'}
      </button>
      {error && (
        <div
          style={{
            marginTop: 12,
            color: 'var(--color-warn, #b00)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}
    </form>
  );
}
