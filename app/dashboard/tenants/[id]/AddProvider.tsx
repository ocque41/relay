'use client';

import { useState } from 'react';
import { createTenantProviderAction } from '@/app/dashboard/actions';

export default function AddProvider({ tenantId }: { tenantId: string }) {
  const [justCreated, setJustCreated] = useState<
    { secret: string; slug: string } | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const form = new FormData(e.currentTarget);
      const res = await createTenantProviderAction(tenantId, form);
      setJustCreated(res);
      (e.target as HTMLFormElement).reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-[5.5px] border border-gray-200 p-5">
      <h3 className="text-sm font-semibold">Register a provider</h3>
      <p className="mt-1 text-sm text-gray-600">
        Agents will call your <code>signup_webhook_url</code> with an
        HMAC-signed POST when starting a signup.
      </p>

      {justCreated && (
        <div className="mt-4 rounded-[5.5px] bg-amber-50 border border-amber-200 p-4">
          <div className="text-sm font-semibold text-amber-900">
            Provider <code>{justCreated.slug}</code> created.
          </div>
          <div className="mt-2 text-xs text-amber-900">
            Save this webhook secret — it will not be shown again:
          </div>
          <pre className="mt-2 overflow-x-auto rounded border border-amber-300 bg-white px-3 py-2 text-xs font-mono">
            {justCreated.secret}
          </pre>
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-4 space-y-3">
        <label className="block">
          <span className="text-xs font-medium text-gray-700">Slug</span>
          <input
            name="slug"
            required
            pattern="[a-z0-9-]+"
            maxLength={60}
            className="mt-1 block w-full rounded-[5.5px] border border-gray-300 px-3 py-2 text-sm font-mono focus:border-black focus:outline-none"
            placeholder="exampleapp"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">Display name</span>
          <input
            name="display_name"
            required
            maxLength={120}
            className="mt-1 block w-full rounded-[5.5px] border border-gray-300 px-3 py-2 text-sm focus:border-black focus:outline-none"
            placeholder="Example App"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">
            Signup webhook URL
          </span>
          <input
            name="signup_webhook_url"
            type="url"
            required
            className="mt-1 block w-full rounded-[5.5px] border border-gray-300 px-3 py-2 text-sm font-mono focus:border-black focus:outline-none"
            placeholder="https://exampleapp.com/api/agent-signup"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">
            Teardown webhook URL (optional)
          </span>
          <input
            name="teardown_webhook_url"
            type="url"
            className="mt-1 block w-full rounded-[5.5px] border border-gray-300 px-3 py-2 text-sm font-mono focus:border-black focus:outline-none"
            placeholder="(defaults to the signup URL)"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">
            Description (shown on listings)
          </span>
          <input
            name="description"
            maxLength={200}
            className="mt-1 block w-full rounded-[5.5px] border border-gray-300 px-3 py-2 text-sm focus:border-black focus:outline-none"
            placeholder="One line on what this product does."
          />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-gray-700">Homepage URL</span>
            <input
              name="homepage"
              type="url"
              className="mt-1 block w-full rounded-[5.5px] border border-gray-300 px-3 py-2 text-sm font-mono focus:border-black focus:outline-none"
              placeholder="https://exampleapp.com"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-700">Docs URL</span>
            <input
              name="docs_url"
              type="url"
              className="mt-1 block w-full rounded-[5.5px] border border-gray-300 px-3 py-2 text-sm font-mono focus:border-black focus:outline-none"
              placeholder="https://exampleapp.com/docs"
            />
          </label>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-gray-700">
              npm package (optional)
            </span>
            <input
              name="npm_package"
              className="mt-1 block w-full rounded-[5.5px] border border-gray-300 px-3 py-2 text-sm font-mono focus:border-black focus:outline-none"
              placeholder="@exampleapp/sdk"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-700">
              Categories (comma-separated)
            </span>
            <input
              name="categories"
              className="mt-1 block w-full rounded-[5.5px] border border-gray-300 px-3 py-2 text-sm font-mono focus:border-black focus:outline-none"
              placeholder="database, hosting"
            />
          </label>
        </div>
        {error && (
          <p className="text-sm text-red-700">{error}</p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="rounded-[5.5px] bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-60 hover:bg-gray-900"
        >
          {pending ? 'Creating…' : 'Register provider'}
        </button>
      </form>
    </div>
  );
}
