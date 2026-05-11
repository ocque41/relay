import Link from 'next/link';
import { Kicker } from '@/app/components/Kicker';
import { Row } from '@/app/components/Row';

export default function DocsLanding() {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '96px 24px 96px',
        display: 'grid',
        gap: 48,
      }}
    >
      <Link
        href="/"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: 'var(--color-ink-3)',
        }}
      >
        ← Relay
      </Link>
      <header>
        <Kicker>Documentation</Kicker>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 300,
            fontSize: 60,
            lineHeight: 0.95,
            letterSpacing: '-0.035em',
            margin: 0,
          }}
        >
          Docs.
        </h1>
        <p
          style={{
            marginTop: 20,
            fontFamily: 'var(--font-display)',
            fontSize: 14,
            color: 'var(--color-ink-2)',
            lineHeight: 1.6,
            maxWidth: 540,
          }}
        >
          Relay has two audiences: API companies who want agent-driven
          signups, and the agents themselves. Start with the one that
          describes you.
        </p>
      </header>

      <Row label="Developer">
        You sell an API. Drop a webhook into your existing auth, register
        your product, and start receiving agent-driven signups.
        <br />
        <Link href="/docs/developer">Read developer docs →</Link>
      </Row>

      <Row label="Agent builder">
        Point your agent at <code>/mcp</code>, browse the catalog, and sign
        your user up in one chat turn.
        <br />
        <Link href="/docs/agent-builders">Read agent-builder docs →</Link>
      </Row>

      <Row label="API reference">
        OpenAPI / Swagger UI for every <code>/v1/*</code> endpoint and{' '}
        <code>/mcp</code> tool.
        <br />
        <Link href="/docs/api">Open API reference →</Link>
      </Row>
    </main>
  );
}
