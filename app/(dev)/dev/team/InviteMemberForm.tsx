'use client';

import { useState } from 'react';

export default function InviteMemberForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(null);
    const fd = new FormData(e.currentTarget);
    const body = {
      email: String(fd.get('email') ?? ''),
      role: String(fd.get('role') ?? 'viewer'),
    };
    try {
      const res = await fetch('/v1/dev/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `${res.status} ${res.statusText}`);
      }
      setSuccess(`${body.email} added as ${body.role}. Refresh to see the list.`);
      (e.target as HTMLFormElement).reset();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 grid gap-3">
      <label className="block text-sm">
        <span className="block text-gray-700">Email</span>
        <input
          name="email"
          required
          type="email"
          placeholder="teammate@example.com"
          className="mt-1 w-full rounded-[5.5px] border border-gray-300 px-3 py-2 text-sm"
        />
      </label>
      <label className="block text-sm">
        <span className="block text-gray-700">Role</span>
        <select
          name="role"
          defaultValue="viewer"
          className="mt-1 w-full rounded-[5.5px] border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="viewer">viewer (read-only)</option>
          <option value="admin">admin (can register products)</option>
          <option value="member">member (legacy)</option>
        </select>
      </label>
      <button
        type="submit"
        disabled={busy}
        className="rounded-[5.5px] bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-50"
      >
        {busy ? 'Adding…' : 'Add member'}
      </button>
      {error && (
        <div className="rounded-[5.5px] border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-[5.5px] border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          {success}
        </div>
      )}
    </form>
  );
}
