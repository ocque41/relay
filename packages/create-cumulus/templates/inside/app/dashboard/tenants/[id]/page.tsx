import { and, eq } from 'drizzle-orm';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { tenants, tenant_providers } from '@/src/server/db/schema';
import { deleteTenantProviderAction } from '@/app/dashboard/actions';
import AddProvider from './AddProvider';

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');

  const tRows = await db
    .select()
    .from(tenants)
    .where(and(eq(tenants.id, id), eq(tenants.owner_user_id, session.userId)))
    .limit(1);
  const tenant = tRows[0];
  if (!tenant) notFound();

  const providers = await db
    .select()
    .from(tenant_providers)
    .where(eq(tenant_providers.tenant_id, id));

  return (
    <div>
      <Link
        href="/dashboard/tenants"
        className="text-xs font-mono uppercase tracking-widest text-gray-500 hover:text-black"
      >
        ← Tenants
      </Link>
      <div className="mt-3 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{tenant.name}</h1>
          <div className="mt-1 text-sm font-mono text-gray-500">
            /{tenant.slug}
          </div>
        </div>
      </div>

      <section className="mt-10">
        <h2 className="text-sm font-mono uppercase tracking-widest text-gray-500">
          Providers
        </h2>
        {providers.length === 0 ? (
          <p className="mt-3 text-sm text-gray-600">
            No providers yet. Register one below to make this tenant callable
            from <code>POST /v1/signups</code> and <code>/mcp</code>.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-gray-200 rounded-[5.5px] border border-gray-200">
            {providers.map((p) => (
              <li
                key={p.id}
                className="flex items-start justify-between gap-4 px-4 py-4"
              >
                <div className="min-w-0">
                  <div className="font-medium">
                    {p.display_name}{' '}
                    <code className="ml-1 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono">
                      {p.slug}
                    </code>
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-gray-500">
                    → {p.signup_webhook_url}
                  </div>
                </div>
                <form
                  action={async () => {
                    'use server';
                    await deleteTenantProviderAction(id, p.id);
                  }}
                >
                  <button
                    type="submit"
                    className="text-xs text-red-700 hover:underline"
                  >
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10 max-w-xl">
        <AddProvider tenantId={id} />
      </section>
    </div>
  );
}
