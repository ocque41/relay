import Link from 'next/link';
import { H1 } from '@/app/components/H1';
import { Kicker } from '@/app/components/Kicker';
import { Row, RowMono } from '@/app/components/Row';
import { MonoVal } from '@/app/components/MonoVal';

export default function AgentAuthStarterPage() {
  return (
    <main className="main">
      <header className="head">
        <div>
          <Kicker>01 — Agent auth</Kicker>
          <H1>
            Relay-ready
            <br />
            authentication.
          </H1>
        </div>
        <div className="headmeta">
          <b>__COMPANY_NAME__</b>
          <br />
          __AGENT_AUTH_MODE__
        </div>
      </header>

      <Row label="Discovery">
        Agents start by reading the Relay discovery document.
        <br />
        <Link href="/.well-known/relay.json">Open /.well-known/relay.json →</Link>
      </Row>

      <RowMono label="Login">
        <MonoVal value="POST /api/relay-login" />
      </RowMono>

      <RowMono label="Signup webhook">
        <MonoVal value="POST /api/agent-signup" />
      </RowMono>

      <RowMono label="Actions webhook">
        <MonoVal value="POST /api/actions" />
      </RowMono>
    </main>
  );
}
