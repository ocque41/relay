'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { startAuthentication } from '@simplewebauthn/browser';

const inputStyle = {
  display: 'block',
  width: '100%',
  padding: '10px 14px',
  background: 'transparent',
  border: '1px solid var(--color-hair)',
  borderRadius: 5.5,
  fontFamily: 'var(--font-mono)',
  fontSize: 14,
  color: 'var(--color-ink)',
  outline: 'none',
  transition: 'border-color 150ms',
} as const;

const codeInputStyle = {
  ...inputStyle,
  textAlign: 'center' as const,
  fontSize: 24,
  letterSpacing: '0.5em',
  padding: '14px',
};

const primaryBtn = {
  display: 'block',
  width: '100%',
  padding: '12px 20px',
  background: 'var(--color-ink)',
  color: 'var(--color-paper)',
  border: 0,
  borderRadius: 5.5,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.1em',
  textTransform: 'uppercase' as const,
  cursor: 'pointer',
} as const;

const secondaryBtn = {
  ...primaryBtn,
  background: 'transparent',
  color: 'var(--color-ink)',
  border: '1px solid var(--color-ink)',
} as const;

const fieldLabel = {
  display: 'block',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.2em',
  textTransform: 'uppercase' as const,
  color: 'var(--color-ink-3)',
  marginBottom: 6,
} as const;

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signInWithPasskey() {
    setError(null);
    setLoading(true);
    try {
      const optsRes = await fetch('/v1/auth/webauthn/login/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(email ? { email } : {}),
      });
      if (!optsRes.ok) {
        setError(`options failed (${optsRes.status})`);
        return;
      }
      const options = await optsRes.json();
      const assertion = await startAuthentication({ optionsJSON: options });
      const verifyRes = await fetch('/v1/auth/webauthn/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(email ? { email, response: assertion } : { response: assertion }),
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => ({ error: 'failed' }));
        setError(body.error ?? `verify failed (${verifyRes.status})`);
        return;
      }
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'passkey error');
    } finally {
      setLoading(false);
    }
  }

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/v1/auth/email/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'failed' }));
        setError(body.error ?? `failed (${res.status})`);
        return;
      }
      setStep('code');
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/v1/auth/email/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'failed' }));
        setError(body.error ?? `failed (${res.status})`);
        return;
      }
      router.push('/dashboard');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '96px 24px 96px' }}>
      <Link
        href="/"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: 'var(--color-ink-3)',
        }}
      >
        ← Relay
      </Link>
      <h1
        style={{
          marginTop: 48,
          fontFamily: 'var(--font-display)',
          fontWeight: 300,
          fontSize: 40,
          lineHeight: 0.95,
          letterSpacing: '-0.035em',
        }}
      >
        {step === 'email' ? 'Sign in.' : 'Check your email.'}
      </h1>
      <p
        style={{
          marginTop: 16,
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          letterSpacing: '0.04em',
          color: 'var(--color-ink-3)',
        }}
      >
        {step === 'email'
          ? 'We will send you a 6-digit code.'
          : `We sent a 6-digit code to ${email}.`}
      </p>

      {step === 'email' ? (
        <form onSubmit={sendCode} style={{ marginTop: 40, display: 'grid', gap: 16 }}>
          <label>
            <span style={fieldLabel}>Email</span>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={inputStyle}
              placeholder="you@example.com"
            />
          </label>
          <button type="submit" disabled={loading} style={primaryBtn}>
            {loading ? 'Sending…' : 'Send code'}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '12px 0' }}>
            <div style={{ flex: 1, height: 1, background: 'var(--color-hair)' }} />
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: 'var(--color-ink-3)',
              }}
            >
              or
            </span>
            <div style={{ flex: 1, height: 1, background: 'var(--color-hair)' }} />
          </div>
          <button
            type="button"
            onClick={signInWithPasskey}
            disabled={loading}
            style={secondaryBtn}
          >
            Sign in with passkey
          </button>
        </form>
      ) : (
        <form onSubmit={verifyCode} style={{ marginTop: 40, display: 'grid', gap: 16 }}>
          <label>
            <span style={fieldLabel}>6-digit code</span>
            <input
              type="text"
              required
              autoFocus
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              style={codeInputStyle}
              placeholder="000000"
            />
          </label>
          <button
            type="submit"
            disabled={loading || code.length !== 6}
            style={{ ...primaryBtn, opacity: loading || code.length !== 6 ? 0.5 : 1 }}
          >
            {loading ? 'Verifying…' : 'Continue'}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep('email');
              setCode('');
            }}
            style={{
              ...secondaryBtn,
              border: 0,
              color: 'var(--color-ink-3)',
            }}
          >
            ← Use a different email
          </button>
        </form>
      )}

      {error && (
        <p
          style={{
            marginTop: 20,
            padding: '10px 14px',
            background: 'var(--color-ink)',
            color: 'var(--color-paper)',
            borderRadius: 5.5,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            letterSpacing: '0.04em',
          }}
        >
          {error}
        </p>
      )}
    </main>
  );
}
