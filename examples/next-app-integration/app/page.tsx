export default function Page() {
  return (
    <main>
      <h1 style={{ fontSize: 32, marginBottom: 8 }}>Example App</h1>
      <p style={{ color: '#444', lineHeight: 1.6 }}>
        A minimal Next.js app showing how to accept agent-driven signups via{' '}
        <a href="https://relay.cumulush.com" style={{ color: '#4f46e5' }}>
          Relay
        </a>
        . The whole integration is one file:{' '}
        <code>app/api/agent-signup/route.ts</code>.
      </p>

      <h2 style={{ marginTop: 32, fontSize: 18 }}>Try it</h2>
      <ol style={{ color: '#444', lineHeight: 1.8 }}>
        <li>
          Register this app at{' '}
          <code>relay.cumulush.com/dashboard/tenants/new</code> with signup URL{' '}
          <code>{'https://<your-domain>/api/agent-signup'}</code>.
        </li>
        <li>
          Put the generated secret in <code>.env.local</code> as{' '}
          <code>RELAY_WEBHOOK_SECRET</code>.
        </li>
        <li>
          Tell an MCP-aware agent (Claude Desktop, Cursor, Windsurf):
          <pre
            style={{
              background: '#f4f4f5',
              padding: 12,
              borderRadius: 6,
              fontSize: 13,
              marginTop: 8,
            }}
          >
            Add the MCP server at https://relay.cumulush.com/mcp, then say: "sign
            me up for example-app"
          </pre>
        </li>
      </ol>

      <h2 style={{ marginTop: 32, fontSize: 18 }}>What's in this repo</h2>
      <pre
        style={{
          background: '#f4f4f5',
          padding: 16,
          borderRadius: 6,
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >{`app/
  layout.tsx
  page.tsx                      ← you are here
  api/
    agent-signup/
      route.ts                  ← the ENTIRE integration
lib/
  user-db.ts                    ← stub in-memory DB (replace with yours)`}</pre>

      <p style={{ color: '#888', fontSize: 13, marginTop: 32 }}>
        Your existing login + user model stay untouched. Relay sits beside them
        as an agent-only on-ramp.
      </p>
    </main>
  );
}
