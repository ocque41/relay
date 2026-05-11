'use client';

import { useState } from 'react';

/**
 * Client form for registering a tenant provider. Submits to /v1/dev/products
 * so all mutations flow through the namespaced API and stay auditable. The
 * plaintext webhook secret is displayed ONCE, then the user must copy it.
 */
export default function AddProductForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ slug: string; value: string } | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const body = {
      slug: String(fd.get('slug') ?? ''),
      display_name: String(fd.get('display_name') ?? ''),
      signup_webhook_url: String(fd.get('signup_webhook_url') ?? ''),
      verification_mode: (fd.get('verification_mode') as string) || 'relay_confirm_link',
    };
    try {
      const res = await fetch('/v1/dev/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `${res.status} ${res.statusText}`);
      }
      const j = (await res.json()) as { slug: string; webhook_secret: string };
      setSecret({ slug: j.slug, value: j.webhook_secret });
      (e.target as HTMLFormElement).reset();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form onSubmit={onSubmit} className="mt-4 grid gap-3">
        <label className="block text-sm">
          <span className="block text-gray-700">Slug</span>
          <input
            name="slug"
            required
            pattern="[a-z0-9-]+"
            placeholder="my-product"
            className="mt-1 w-full rounded-[5.5px] border border-gray-300 px-3 py-2 font-mono text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="block text-gray-700">Display name</span>
          <input
            name="display_name"
            required
            placeholder="My Product"
            className="mt-1 w-full rounded-[5.5px] border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="block text-gray-700">Signup webhook URL</span>
          <input
            name="signup_webhook_url"
            required
            type="url"
            placeholder="https://example.com/api/agent-signup"
            className="mt-1 w-full rounded-[5.5px] border border-gray-300 px-3 py-2 font-mono text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="block text-gray-700">Verification mode</span>
          <select
            name="verification_mode"
            defaultValue="relay_confirm_link"
            className="mt-1 w-full rounded-[5.5px] border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="none">none — dispatch immediately</option>
            <option value="relay_confirm_link">relay_confirm_link — Relay emails the user a confirmation link</option>
            <option value="integrator_email">integrator_email — your service emails the user's Relay alias</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busy}
          className="mt-2 rounded-[5.5px] bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-50"
        >
          {busy ? 'Registering…' : 'Register product'}
        </button>
        {error && (
          <div className="rounded-[5.5px] border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </div>
        )}
      </form>

      {secret && (
        <div className="mt-4 rounded-[5.5px] border border-indigo-200 bg-indigo-50 p-4">
          <div className="text-xs font-mono uppercase tracking-widest text-indigo-900">
            Webhook secret — copy now, it will NOT be shown again
          </div>
          <div className="mt-2 text-xs text-indigo-900">
            slug: <code className="font-mono">{secret.slug}</code>
          </div>
          <pre className="mt-2 overflow-x-auto rounded bg-white px-3 py-2 font-mono text-sm text-indigo-900">
            {secret.value}
          </pre>
        </div>
      )}
    </>
  );
}
