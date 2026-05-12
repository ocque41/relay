'use client';

import { useState } from 'react';

export default function RotateSecretButton({ slug }: { slug: string }) {
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function rotate() {
    if (!confirm(`Rotate the secret for "${slug}"? Your integrator must update RELAY_WEBHOOK_SECRET immediately.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/v1/dev/products/${encodeURIComponent(slug)}/rotate`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `${res.status} ${res.statusText}`);
      }
      const j = (await res.json()) as { webhook_secret: string };
      setSecret(j.webhook_secret);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <button
        onClick={rotate}
        disabled={busy}
        className="rounded-[5.5px] border border-gray-300 bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
      >
        {busy ? 'Rotating…' : 'Rotate secret'}
      </button>
      {secret && (
        <div className="mt-4 rounded-[5.5px] border border-indigo-200 bg-indigo-50 p-4">
          <div className="text-xs font-mono uppercase tracking-widest text-indigo-900">
            New secret — copy now, it will NOT be shown again
          </div>
          <pre className="mt-2 overflow-x-auto rounded bg-white px-3 py-2 font-mono text-sm text-indigo-900">
            {secret}
          </pre>
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-[5.5px] border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}
    </div>
  );
}
