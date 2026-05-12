'use client';

import { useState } from 'react';
import { mintAgentTokenAction } from '@/app/dashboard/actions';

export default function TokenMinter() {
  const [justMinted, setJustMinted] = useState<
    { token: string; label: string; expiresAt: string | null } | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [expiry, setExpiry] = useState<'30' | '90' | '365' | 'never'>('30');
  const [confirmNever, setConfirmNever] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const form = new FormData(e.currentTarget);
      const res = await mintAgentTokenAction(form);
      setJustMinted(res);
      (e.target as HTMLFormElement).reset();
      setExpiry('30');
      setConfirmNever(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-[5.5px] border border-gray-200 p-5">
      <h3 className="text-sm font-semibold">Mint a new agent token</h3>
      <p className="mt-1 text-sm text-gray-600">
        Hand this to an MCP client, CLI, or curl to act as you. Tokens rotate
        after their expiry so a leaked token stops working on its own.
      </p>

      {justMinted && (
        <div className="mt-4 rounded-[5.5px] bg-amber-50 border border-amber-200 p-4">
          <div className="text-sm font-semibold text-amber-900">
            Token <code>{justMinted.label}</code> created.
          </div>
          <div className="mt-1 text-xs text-amber-900">
            {justMinted.expiresAt
              ? `Expires ${new Date(justMinted.expiresAt).toISOString().slice(0, 10)}.`
              : 'This token NEVER EXPIRES. Guard it carefully.'}
          </div>
          <div className="mt-2 text-xs text-amber-900">
            Save this token — it will not be shown again:
          </div>
          <pre className="mt-2 overflow-x-auto rounded border border-amber-300 bg-white px-3 py-2 text-xs font-mono break-all">
            {justMinted.token}
          </pre>
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-4 space-y-3">
        <div className="flex gap-2">
          <input
            name="label"
            required
            maxLength={100}
            className="flex-1 rounded-[5.5px] border border-gray-300 px-3 py-2 text-sm focus:border-black focus:outline-none"
            placeholder="My MacBook · Claude Desktop"
          />
          <select
            name="expiry"
            value={expiry}
            onChange={(e) =>
              setExpiry(e.target.value as '30' | '90' | '365' | 'never')
            }
            className="rounded-[5.5px] border border-gray-300 px-2 py-2 text-sm focus:border-black focus:outline-none"
            aria-label="Token expiry"
          >
            <option value="30">30 days (default)</option>
            <option value="90">90 days</option>
            <option value="365">1 year</option>
            <option value="never">Never</option>
          </select>
          <button
            type="submit"
            disabled={pending || (expiry === 'never' && !confirmNever)}
            className="rounded-[5.5px] bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-60 hover:bg-gray-900"
          >
            {pending ? 'Minting…' : 'Mint'}
          </button>
        </div>
        {expiry === 'never' && (
          <label className="flex items-start gap-2 rounded-[5.5px] border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
            <input
              type="checkbox"
              name="confirm_never"
              checked={confirmNever}
              onChange={(e) => setConfirmNever(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5"
            />
            <span>
              I understand this token will NEVER expire on its own. If it leaks,
              I must revoke it manually from this dashboard.
            </span>
          </label>
        )}
      </form>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
