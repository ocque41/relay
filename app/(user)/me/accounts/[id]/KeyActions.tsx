'use client';

import { useState, useTransition } from 'react';
import { mintKeyAction, rotateKeyAction } from './actions';

interface KeyRow {
  id: string;
  label: string;
  provider_key_id: string | null;
  created_at: Date | null;
  last_revealed_at: Date | null;
}

interface Props {
  accountId: string;
  initialKeys: KeyRow[];
}

const buttonPrimary: React.CSSProperties = {
  padding: '8px 14px',
  background: 'var(--color-ink)',
  color: 'var(--color-paper)',
  border: 0,
  borderRadius: 5.5,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  cursor: 'pointer',
};

const buttonGhost: React.CSSProperties = {
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
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 160,
  padding: '8px 10px',
  background: 'transparent',
  border: '1px solid var(--color-hair)',
  borderRadius: 5.5,
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--color-ink)',
};

const plaintextBox: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  border: '1px solid var(--color-ink)',
  borderRadius: 5.5,
  background: 'var(--color-wash)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  wordBreak: 'break-all',
};

export default function KeyActions({ accountId, initialKeys }: Props) {
  const [keys, setKeys] = useState<KeyRow[]>(initialKeys);
  const [justMinted, setJustMinted] = useState<{ label: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onMint(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    startTransition(async () => {
      try {
        const res = await mintKeyAction(accountId, form);
        setJustMinted({ label: res.label, key: res.key });
        setKeys((prev) => [
          {
            id: res.id,
            label: res.label,
            provider_key_id: null,
            created_at: res.created_at ? new Date(res.created_at) : null,
            last_revealed_at: null,
          },
          ...prev,
        ]);
        (e.target as HTMLFormElement).reset();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  function onRotate(keyId: string) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await rotateKeyAction(accountId, keyId);
        setJustMinted({ label: res.new_key.label, key: res.new_key.key });
        setKeys((prev) => [
          {
            id: res.new_key.id,
            label: res.new_key.label,
            provider_key_id: null,
            created_at: res.new_key.created_at ? new Date(res.new_key.created_at) : null,
            last_revealed_at: null,
          },
          ...prev.filter((k) => k.id !== keyId),
        ]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <>
      <form
        onSubmit={onMint}
        style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <input
          name="label"
          maxLength={100}
          placeholder="key label (optional)"
          style={inputStyle}
          disabled={pending}
        />
        <button type="submit" style={buttonPrimary} disabled={pending}>
          {pending ? 'Working…' : 'Mint new key'}
        </button>
      </form>

      {error && (
        <div
          style={{
            marginTop: 10,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'crimson',
          }}
        >
          {error}
        </div>
      )}

      {justMinted && (
        <div style={plaintextBox}>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--color-ink-3)',
              marginBottom: 8,
            }}
          >
            {justMinted.label} · copy now, it will not be shown again
          </div>
          <div>{justMinted.key}</div>
          <button
            type="button"
            style={{ ...buttonGhost, marginTop: 10 }}
            onClick={() => {
              navigator.clipboard?.writeText(justMinted.key).catch(() => {});
            }}
          >
            Copy →
          </button>
          <button
            type="button"
            style={{ ...buttonGhost, marginTop: 10, marginLeft: 18 }}
            onClick={() => setJustMinted(null)}
          >
            Dismiss →
          </button>
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        {keys.length === 0 ? (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--color-ink-3)',
            }}
          >
            No active keys.
          </div>
        ) : (
          keys.map((k) => (
            <div
              key={k.id}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 18,
                paddingTop: 12,
                paddingBottom: 12,
                borderTop: '1px solid var(--color-hair)',
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 500 }}>{k.label}</div>
                <div
                  style={{
                    marginTop: 4,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--color-ink-3)',
                    letterSpacing: '0.04em',
                  }}
                >
                  {k.provider_key_id && <>{k.provider_key_id.slice(0, 14)}… · </>}
                  {k.created_at && <>created {k.created_at.toISOString().slice(0, 10)}</>}
                </div>
              </div>
              <button
                type="button"
                style={buttonGhost}
                disabled={pending}
                onClick={() => onRotate(k.id)}
              >
                Rotate (retrieve) →
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}
