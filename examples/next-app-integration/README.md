# Relay — Next.js example integration

A minimal Next.js App Router app that accepts agent-driven signups via Relay.

## 60-second setup

```bash
# 1. Clone + install
npm install
npm install ../../packages/server-sdk

# 2. Register with Relay (at https://relay.cumulush.com/dashboard/tenants/new)
#    - Slug: exampleapp
#    - Display name: Example App
#    - Signup webhook URL: https://your-domain.com/api/agent-signup
#    - Copy the generated webhook_secret

# 3. Put the secret in .env.local
echo 'RELAY_WEBHOOK_SECRET=<paste here>' >> .env.local

# 4. Run
npm run dev

# 5. Try it: ask an AI agent with MCP set up:
#    "Sign me up for exampleapp using Relay"
```

## What this example shows

The entire integration is one route file: [`app/api/agent-signup/route.ts`](app/api/agent-signup/route.ts).

The handler:
- verifies Relay's HMAC signature automatically,
- dispatches by `body.kind` (`signup` | `create_api_key` | `revoke_api_key` | `teardown`),
- lets you implement whichever callbacks your app needs.

Your existing login flow is completely untouched. Relay sits alongside it as an agent-only on-ramp.

## Files

```
app/
├── layout.tsx                 # boring Next.js shell
├── page.tsx                   # landing page pointing to the handler
└── api/
    └── agent-signup/
        └── route.ts           # THE WHOLE INTEGRATION
lib/
└── user-db.ts                 # stub in-memory user DB — swap for your real one
.env.example
```

See [`app/api/agent-signup/route.ts`](app/api/agent-signup/route.ts) for the actual integration code.
