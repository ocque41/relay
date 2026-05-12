import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { cli_auth_codes, users } from '@/src/server/db/schema';
import { approveCliDeviceCodeAction } from './actions';

export default async function CliAuthPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) {
    redirect(`/login?next=/cli-auth/${encodeURIComponent(code)}`);
  }

  const [row] = await db
    .select()
    .from(cli_auth_codes)
    .where(eq(cli_auth_codes.device_code, code))
    .limit(1);

  if (!row) {
    return (
      <main className="mx-auto max-w-md px-6 py-24">
        <h1 className="text-2xl font-semibold">Unknown device code</h1>
        <p className="mt-3 text-sm text-gray-600">
          This login link is invalid. Run <code>relay login</code> again to
          start a new session.
        </p>
      </main>
    );
  }

  const expired = row.expires_at.getTime() < Date.now();
  const alreadyApproved = !!row.approved_at;

  const [u] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (expired) {
    return (
      <main className="mx-auto max-w-md px-6 py-24">
        <h1 className="text-2xl font-semibold">Login link expired</h1>
        <p className="mt-3 text-sm text-gray-600">
          Each CLI login link is valid for 10 minutes. Run{' '}
          <code>relay login</code> again to start a new session.
        </p>
      </main>
    );
  }

  if (alreadyApproved) {
    return (
      <main className="mx-auto max-w-md px-6 py-24">
        <h1 className="text-2xl font-semibold">Already approved</h1>
        <p className="mt-3 text-sm text-gray-600">
          This device is authorized. You can close this window and return to
          your terminal.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-6 py-24">
      <Link
        href="/"
        className="text-xs font-mono uppercase tracking-widest text-gray-500 hover:text-black"
      >
        ← Relay
      </Link>
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">
        Authorize a CLI device
      </h1>
      <p className="mt-3 text-sm text-gray-600">
        You're signed in as <strong>{u?.email ?? session.email}</strong>. Approving
        this request creates a new agent token scoped to your account and hands
        it to the waiting CLI process.
      </p>
      <p className="mt-3 text-xs text-gray-500">
        Only approve if you just ran <code>relay login</code> on this
        computer. Don't paste this URL into any other device.
      </p>

      <form
        action={async (formData: FormData) => {
          'use server';
          const rawExpiry = String(formData.get('expiry') ?? '30') as
            | '30'
            | '90'
            | '365'
            | 'never';
          const confirmNever = formData.get('confirm_never') === 'on';
          await approveCliDeviceCodeAction(code, rawExpiry, confirmNever);
        }}
        className="mt-8 space-y-4"
      >
        <fieldset className="rounded-[5.5px] border border-gray-200 p-4">
          <legend className="px-2 text-xs font-semibold uppercase tracking-wide text-gray-600">
            Token lifetime
          </legend>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="expiry" value="30" defaultChecked />
              <span>30 days (recommended default)</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="expiry" value="90" />
              <span>90 days</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="expiry" value="365" />
              <span>1 year</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="expiry" value="never" />
              <span>Never expires (advanced)</span>
            </label>
          </div>
          <label className="mt-4 flex items-start gap-2 rounded-[5.5px] border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
            <input
              type="checkbox"
              name="confirm_never"
              className="mt-0.5 h-3.5 w-3.5"
            />
            <span>
              Only tick this if you chose <strong>Never expires</strong>. Without
              it, a "Never" selection falls back to the 30-day default. A
              non-expiring token must be revoked manually from the dashboard if
              it leaks.
            </span>
          </label>
        </fieldset>
        <div className="flex gap-3">
          <button
            type="submit"
            className="flex-1 rounded-[5.5px] bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-gray-900"
          >
            Authorize this device
          </button>
          <Link
            href="/dashboard"
            className="inline-flex items-center rounded-[5.5px] border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium hover:bg-gray-50"
          >
            Cancel
          </Link>
        </div>
      </form>

      <p className="mt-6 rounded-[5.5px] border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-600 break-all">
        device code: {code}
      </p>
    </main>
  );
}
