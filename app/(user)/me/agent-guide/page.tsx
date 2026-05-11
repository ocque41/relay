import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import { db } from '@/src/server/db/index';
import { users } from '@/src/server/db/schema';
import AgentGuideEditor from './AgentGuideEditor';
import { Kicker } from '@/app/components/Kicker';
import { H1 } from '@/app/components/H1';
import { Row } from '@/app/components/Row';

export default async function AgentGuidePage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { saved, error } = await searchParams;
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');

  const [row] = await db
    .select({
      agent_guide: users.agent_guide,
      agent_guide_updated_at: users.agent_guide_updated_at,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  const content = row?.agent_guide ?? '';
  const updatedAt = row?.agent_guide_updated_at
    ? row.agent_guide_updated_at.toISOString()
    : null;

  return (
    <>
      <header className="head">
        <div>
          <Kicker>08 — Agent guide</Kicker>
          <H1>
            What your
            <br />
            agents read first.
          </H1>
        </div>
        <div className="headmeta">
          <b>{content ? `${new TextEncoder().encode(content).byteLength.toLocaleString()}b` : 'empty'}</b>
        </div>
      </header>

      <Row label="How this works">
        This file is sent to your AI agents at the start of every session. Put
        your preferences, defaults, and context here — e.g. <em>"When I ask you
        to create a Vercel project, default the label to{' '}
        <code
          style={{
            padding: '1px 4px',
            background: 'var(--color-wash)',
            borderRadius: 5.5,
          }}
        >
          cumulush-&lt;timestamp&gt;
        </code>
        ."</em>{' '}
        Agents fetch it via <code>GET /v1/agent-guide</code> and propose edits
        in chat before calling <code>PUT</code> — they never overwrite silently.
      </Row>

      {saved && (
        <Row label="Saved">
          Guide updated. Your agents will see the new version on their next
          session.
        </Row>
      )}
      {error === 'too_large' && (
        <Row label="Error">
          Guide exceeds 64 KiB. Trim it and save again.
        </Row>
      )}

      <Row label="Editor">
        <AgentGuideEditor initialContent={content} updatedAt={updatedAt} />
      </Row>
    </>
  );
}
