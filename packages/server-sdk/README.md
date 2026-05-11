# @cumulus/server

Server SDK for **Relay** — agent-driven signup for any app. Drop in a webhook, let your users onboard through their AI.

```bash
npm install @cumulus/server
```

## 60-second integration

```ts
// your backend — Next.js App Router
import { relay } from '@cumulus/server';

export const POST = relay.webhook({
  secret: process.env.RELAY_WEBHOOK_SECRET!,
  onSignup: async ({ email, input }) => {
    const user = await myAuth.createUser({ email, name: input.name });
    const apiKey = await myAuth.issueApiKey(user.id);
    return { accountId: user.id, apiKey };
  },
  onTeardown: async ({ account_id }) => {
    await myAuth.deleteUser(account_id);
  },
});
```

That's it. Register at https://relay.cumulush.com, paste the endpoint URL + secret into Relay, and AI agents can now sign your users up for your app.

## What you get

| Callback | Triggered when | Return |
|---|---|---|
| `onSignup` *(required)* | An agent initiates a signup for your app | `{ accountId, apiKey }` |
| `onCreateApiKey` *(optional)* | User/agent asks for an additional API key | `{ key, providerKeyId? }` |
| `onRevokeApiKey` *(optional)* | An existing key is revoked | *void* |
| `onTeardown` *(optional)* | Account is deleted from Relay | *void* |

## Framework support

The handler is a standard `(Request) => Promise<Response>`. Works with:

- **Next.js App Router**: `export const POST = relay.webhook({ … })`
- **Hono**: `app.post('/agent-signup', (c) => handler(c.req.raw))`
- **Bun**: `Bun.serve({ fetch: handler })`
- **Deno / Cloudflare Workers / Vercel Functions**: all Web-Standard runtimes
- **Node / Express**: wrap with a tiny adapter (see below)

### Node / Express adapter

```ts
import express from 'express';
const app = express();
app.use(express.raw({ type: 'application/json' })); // raw body for HMAC verification

app.post('/agent-signup', async (req, res) => {
  const relayHandler = relay.webhook({ secret: …, onSignup: … });
  const webReq = new Request(`http://x${req.url}`, {
    method: 'POST',
    headers: req.headers as HeadersInit,
    body: req.body,
  });
  const webRes = await relayHandler(webReq);
  res.status(webRes.status);
  webRes.headers.forEach((v, k) => res.setHeader(k, v));
  res.send(Buffer.from(await webRes.arrayBuffer()));
});
```

## Signature verification

Every incoming request has an `X-Relay-Signature: sha256=<hex>` header — an HMAC-SHA256 of the raw body using your shared secret. The SDK verifies this with a timing-safe comparison before invoking your callback. A bad signature returns 401 without ever calling your handler.

## Payload schemas

```ts
interface SignupPayload {
  kind: 'signup';
  signupId: string;                       // Relay's signup_jobs.id
  email: string;                          // user's email (or Relay-hosted alias)
  input: Record<string, unknown>;         // per your inputSchema
  provider_slug: string;                  // your registered slug
}
// … plus CreateApiKeyPayload, RevokeApiKeyPayload, TeardownPayload
```

All types are exported — `import type { SignupPayload } from '@cumulus/server'`.

## Testing locally

Relay sends real HTTP calls. To test locally, use a tunnel (ngrok, Cloudflare Tunnel) and point your Relay provider config at the tunnel URL.

## License

MIT.
