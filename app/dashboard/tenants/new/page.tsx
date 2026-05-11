import Link from 'next/link';
import { createTenantAction } from '@/app/dashboard/actions';

export default function NewTenantPage() {
  return (
    <div className="mx-auto max-w-lg">
      <Link
        href="/dashboard/tenants"
        className="text-xs font-mono uppercase tracking-widest text-gray-500 hover:text-black"
      >
        ← Tenants
      </Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">New tenant</h1>
      <p className="mt-2 text-sm text-gray-600">
        A tenant represents an app of yours that agents can sign users up for.
      </p>

      <form action={createTenantAction} className="mt-8 space-y-5">
        <label className="block">
          <span className="text-sm font-medium">Name</span>
          <input
            type="text"
            name="name"
            required
            autoFocus
            maxLength={120}
            className="mt-1 block w-full rounded-[5.5px] border border-gray-300 px-3 py-2 text-sm focus:border-black focus:outline-none"
            placeholder="Example App"
          />
          <span className="mt-1 block text-xs text-gray-500">
            A slug will be derived automatically. You can override it later.
          </span>
        </label>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-[5.5px] bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-gray-900"
          >
            Create tenant
          </button>
          <Link
            href="/dashboard/tenants"
            className="text-sm text-gray-500 hover:text-black"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
