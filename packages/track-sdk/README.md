# @cumulus/track

Tiny fire-and-forget activation tracker for Relay integrations.

## Install

```bash
npm install @cumulus/track
```

## Usage

```ts
import { createRelayTracker } from '@cumulus/track';

const relay = createRelayTracker({
  secretId: process.env.RELAY_TRACKING_SECRET_ID!,
  secretValue: process.env.RELAY_TRACKING_SECRET!,
});

// In your key-validation middleware, after you've already authenticated the request:
app.use((req, res, next) => {
  if (req.relaySignupId) {
    relay.track({
      signupId: req.relaySignupId,
      idempotencyKey: `${req.relaySignupId}:first-call`,
      externalUserId: req.userId,
    });
  }
  next();
});
```

## Properties

- Always asynchronous; never blocks your hot path.
- Never throws synchronously; pass `onError` to observe failures.
- Retries up to 3 times with exponential backoff, then drops the event.
- HMAC-SHA256 signs every request with `secretValue`.
- Idempotent on `(tenant, idempotencyKey)` — duplicate calls are no-ops on the server.

## Curl equivalent

```bash
TIMESTAMP=$(date +%s)
BODY='{"signup_id":"<uuid>","occurred_at":"<iso>","idempotency_key":"k1","event_name":"authenticated_api_call_succeeded"}'
SIG=$(printf '%s.%s' "$TIMESTAMP" "$BODY" | openssl dgst -sha256 -hmac "$RELAY_TRACKING_SECRET" | awk '{print $2}')

curl -X POST https://relay.cumulush.com/v1/activations \
  -H "content-type: application/json" \
  -H "x-relay-secret-id: $RELAY_TRACKING_SECRET_ID" \
  -H "x-relay-timestamp: $TIMESTAMP" \
  -H "x-relay-signature: $SIG" \
  -d "$BODY"
```

## License

MIT.
