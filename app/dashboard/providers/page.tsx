import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { listProviders } from '@/src/server/providers/index';

export const metadata = {
  title: 'Providers — Relay',
  description:
    'Every signup target registered on Relay: built-in providers plus every tenant-defined product.',
};

export const dynamic = 'force-dynamic';

export default async function ProvidersCatalogPage() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');

  const providers = await listProviders();

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Providers</h1>
      <p className="mt-2 max-w-2xl text-sm text-gray-600">
        Every target Relay can sign your users up to. Built-in providers are
        maintained by Relay; tenant providers are custom signup webhooks
        registered by integrators.
      </p>

      {providers.length === 0 ? (
        <p className="mt-10 text-sm text-gray-600">No providers registered.</p>
      ) : (
        <ul className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2">
          {providers.map((p) => (
            <li
              key={`${p.kind}:${p.id}`}
              className="rounded-[5.5px] border border-gray-200 p-5 hover:border-gray-400 transition"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-semibold truncate">
                      {p.displayName}
                    </h2>
                    <span className="rounded-full border border-gray-300 px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest text-gray-600">
                      {p.kind}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs font-mono text-gray-500">
                    {p.id}
                  </div>
                </div>
              </div>

              {p.description && (
                <p className="mt-3 text-sm text-gray-700">{p.description}</p>
              )}

              {p.categories.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {p.categories.map((c) => (
                    <span
                      key={c}
                      className="rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-mono text-gray-600"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-4 flex flex-wrap gap-3 text-xs">
                {p.homepage && (
                  <a
                    href={p.homepage}
                    target="_blank"
                    rel="noreferrer"
                    className="text-gray-600 underline hover:text-black"
                  >
                    homepage ↗
                  </a>
                )}
                {p.docsUrl && (
                  <a
                    href={p.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-gray-600 underline hover:text-black"
                  >
                    docs ↗
                  </a>
                )}
                {p.npmPackage && (
                  <a
                    href={`https://www.npmjs.com/package/${p.npmPackage}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-gray-600 underline hover:text-black"
                  >
                    npm:{p.npmPackage} ↗
                  </a>
                )}
              </div>

              <div className="mt-5 flex items-center justify-between border-t border-gray-100 pt-4">
                <Link
                  href={`/me/signups?provider=${encodeURIComponent(p.id)}`}
                  className="inline-flex items-center rounded-[5.5px] bg-black px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-900"
                >
                  Sign up →
                </Link>
                {p.needsEmailVerification && (
                  <span className="text-[11px] font-mono text-gray-500">
                    email-verif required
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
