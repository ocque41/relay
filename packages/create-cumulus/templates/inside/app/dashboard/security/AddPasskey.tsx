'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startRegistration } from '@simplewebauthn/browser';

export default function AddPasskey() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enroll(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const optsRes = await fetch('/v1/auth/webauthn/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!optsRes.ok) {
        setError(`options failed (${optsRes.status})`);
        return;
      }
      const options = await optsRes.json();
      const attestation = await startRegistration({ optionsJSON: options });
      const verifyRes = await fetch('/v1/auth/webauthn/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: attestation, name: name || undefined }),
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => ({ error: 'failed' }));
        setError(body.error ?? `verify failed (${verifyRes.status})`);
        return;
      }
      setName('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'passkey error');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={enroll} className="mt-4 flex gap-2">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={80}
        className="flex-1 rounded-[5.5px] border border-gray-300 px-3 py-2 text-sm focus:border-black focus:outline-none"
        placeholder="My MacBook · Touch ID"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-[5.5px] bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-60 hover:bg-gray-900"
      >
        {pending ? 'Registering…' : 'Add passkey'}
      </button>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </form>
  );
}
