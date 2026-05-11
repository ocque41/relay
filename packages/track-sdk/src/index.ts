/**
 * @cumulus/track — fire-and-forget activation tracker.
 *
 * Drop one line into your key-validation middleware:
 *
 *   import { createRelayTracker } from '@cumulus/track';
 *   const relay = createRelayTracker({
 *     secretId: process.env.RELAY_TRACKING_SECRET_ID!,
 *     secretValue: process.env.RELAY_TRACKING_SECRET!,
 *   });
 *   // …in your middleware, after you have validated the API key…
 *   relay.track({
 *     signupId: req.relaySignupId,    // your column linking the key to a Relay signup
 *     idempotencyKey: `${req.relaySignupId}:first-call`,
 *   });
 *
 * Properties:
 *   • Always async, never blocks the integrator's hot path.
 *   • Never throws synchronously. All errors swallowed; opt-in via onError.
 *   • Retries up to 3 times with exponential backoff, then drops.
 *   • HMAC-SHA256-signs each request with secretValue.
 *   • Idempotent: server dedupes on (tenant, idempotency_key).
 */
import { createHmac } from 'node:crypto';

export type RelayTrackerOptions = {
  /** public_id portion of the secret pair issued by Relay. */
  secretId: string;
  /** secret_value portion of the secret pair issued by Relay. */
  secretValue: string;
  /** Relay base URL. Defaults to https://relay.cumulush.com. */
  endpoint?: string;
  /** Max retry attempts (excluding the initial try). Default 3. */
  maxRetries?: number;
  /** Optional error sink. Called with any final-failure error. */
  onError?: (err: Error) => void;
};

export type ActivationEvent = {
  signupId: string;
  /** Defaults to 'authenticated_api_call_succeeded'. */
  eventName?: string;
  /** ISO-8601. Defaults to "now". */
  occurredAt?: string;
  /** Required. Server dedupes on (tenant, idempotency_key). */
  idempotencyKey: string;
  /** Optional integrator-side identifier for the user. */
  externalUserId?: string | null;
  /** Optional UUID of the integrator's API key row. */
  providerKeyId?: string | null;
  /** Optional normalized fields. Do NOT pass raw request payloads. */
  metadata?: Record<string, unknown>;
};

const DEFAULT_ENDPOINT = 'https://relay.cumulush.com';
const DEFAULT_MAX_RETRIES = 3;

export type RelayTracker = {
  track: (event: ActivationEvent) => Promise<void>;
};

export function createRelayTracker(opts: RelayTrackerOptions): RelayTracker {
  if (!opts.secretId || !opts.secretValue) {
    throw new Error('@cumulus/track: secretId and secretValue are required');
  }
  const endpoint = (opts.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const onError = opts.onError ?? (() => undefined);

  async function send(event: ActivationEvent): Promise<void> {
    const occurredAt = event.occurredAt ?? new Date().toISOString();
    const body = JSON.stringify({
      signup_id: event.signupId,
      event_name: event.eventName ?? 'authenticated_api_call_succeeded',
      occurred_at: occurredAt,
      idempotency_key: event.idempotencyKey,
      external_user_id: event.externalUserId ?? undefined,
      provider_key_id: event.providerKeyId ?? undefined,
      metadata: event.metadata,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', opts.secretValue)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    let attempt = 0;
    let lastErr: Error | null = null;
    while (attempt <= maxRetries) {
      try {
        const res = await fetch(`${endpoint}/v1/activations`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-relay-secret-id': opts.secretId,
            'x-relay-timestamp': timestamp,
            'x-relay-signature': signature,
          },
          body,
        });
        if (res.ok) return;
        if (res.status === 401 || res.status === 400) {
          // 4xx: not retryable.
          lastErr = new Error(`relay-track: ${res.status} ${await res.text().catch(() => '')}`);
          break;
        }
        lastErr = new Error(`relay-track: ${res.status}`);
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
      attempt += 1;
      if (attempt <= maxRetries) {
        const backoffMs = Math.min(2000, 100 * Math.pow(2, attempt - 1));
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    if (lastErr) onError(lastErr);
  }

  return {
    track(event) {
      // Fire-and-forget: never throws synchronously, never returns a rejected
      // promise to the caller's hot path.
      const p = send(event).catch((err) =>
        onError(err instanceof Error ? err : new Error(String(err))),
      );
      // Return the promise so callers who *want* to await can; integrators
      // following the recommended pattern simply ignore it.
      return p;
    },
  };
}

export default createRelayTracker;
