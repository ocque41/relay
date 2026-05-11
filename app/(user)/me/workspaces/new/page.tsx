import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { createUserWorkspaceFromForm } from '../actions';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Row } from '@/app/components/Row';

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  background: 'transparent',
  border: '1px solid var(--color-hair)',
  borderRadius: 5.5,
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
} as const;

export default async function NewWorkspacePage() {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');

  return (
    <>
      <header className="head">
        <div>
          <Kicker>New personal workspace</Kicker>
          <H1>
            Create a
            <br />
            workspace.
          </H1>
        </div>
        <div className="headmeta">
          <Link href="/me/workspaces">← Back</Link>
        </div>
      </header>

      <Row label="Why a new workspace?">
        A new workspace starts empty — fresh set of accounts, fresh API keys,
        fresh inbox alias, fresh agent tokens. Use it to separate projects,
        clients, or personal experiments from your default space.
      </Row>

      <form action={createUserWorkspaceFromForm} style={{ display: 'grid', gap: 20, maxWidth: 480 }}>
        <Row label="Name">
          <input
            type="text"
            name="name"
            required
            maxLength={80}
            autoFocus
            placeholder="e.g. Acme prototype"
            style={inputStyle}
          />
          <div style={{ fontSize: 12, color: 'var(--color-ink-3)', marginTop: 6 }}>
            What you&apos;ll see in the workspace switcher.
          </div>
        </Row>

        <Row label="Slug (optional)">
          <input
            type="text"
            name="slug"
            pattern="[a-z0-9-]+"
            maxLength={40}
            placeholder="acme-prototype"
            style={inputStyle}
          />
          <div style={{ fontSize: 12, color: 'var(--color-ink-3)', marginTop: 6 }}>
            Used in URLs and API calls. Only you see your own slugs — leave
            blank to auto-derive from the name.
          </div>
        </Row>

        <Row label="">
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
            <input type="checkbox" name="make_active" defaultChecked />
            <span>Make this my active workspace</span>
          </label>
        </Row>

        <Row label="">
          <button
            type="submit"
            style={{
              alignSelf: 'flex-start',
              padding: '10px 18px',
              background: 'var(--color-ink)',
              color: 'var(--color-paper)',
              border: 0,
              borderRadius: 5.5,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            Create workspace
          </button>
        </Row>
      </form>
    </>
  );
}
