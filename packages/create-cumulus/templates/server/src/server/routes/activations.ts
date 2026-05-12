/**
 * POST /v1/activations — integrator-reported activation events.
 *
 * Authentication: HMAC-signed by the integrator using a per-tenant
 * tracking secret minted via scripts/seed-tracking-secret.ts. The secret
 * is *low-privilege*: it cannot mint API keys, read accounts, or call any
 * other route. It can ONLY write activation events.
 *
 * Required headers:
 *   X-Relay-Secret-Id: <public_id>
 *   X-Relay-Timestamp: <unix_seconds>
 *   X-Relay-Signature: hex(HMAC_SHA256(secret_value, `${timestamp}.${body}`))
 *
 * Body (application/json):
 *   {
 *     "signup_id":        "<uuid>",                  // required
 *     "event_name":       "authenticated_api_call_succeeded", // optional, default
 *     "occurred_at":      "ISO-8601",                // required
 *     "idempotency_key":  "<string>",                // required, unique per (tenant, key)
 *     "external_user_id": "<string?>",               // optional
 *     "provider_key_id":  "<uuid?>",                 // optional
 *     "metadata":         { ... normalized fields }  // optional
 *   }
 *
 * Mounted via raw `app.post()` (not OpenAPIHono.openapi) because the
 * HMAC verifies the *exact* raw bytes of the body — any zod-openapi
 * re-serialization would invalidate the signature. The shape is still
 * documented for agents via app/docs/api/activations.md and the
 * @cumulus/track SDK.
 *
 * Response: always 202 (best-effort). Internal failures log to Sentry
 * and still return 202 — the integrator's hot path must never block on
 * Relay being healthy.
 *
 * Idempotency: duplicate (tenant, idempotency_key) pairs return 202
 * with `{ duplicate: true }` and do not insert a second row.
 *
 * is_24h / is_7d are computed at write time against
 * signup_jobs.handoff_at (the genuine handoff timestamp). Rows where
 * handoff_at is null record both flags as false.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '../db/index';
import { activations, signup_jobs, tenant_tracking_secrets } from '../db/schema';
import type { AppEnv } from '../auth';
import { logger } from '../logger';
import { Sentry } from '../sentry';

const router = new OpenAPIHono<AppEnv>();

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SIGNATURE_FRESHNESS_SEC = 5 * 60;

const ActivationBody = z.object({
  signup_id: z.string().uuid(),
  event_name: z
    .string()
    .max(80)
    .optional()
    .default('authenticated_api_call_succeeded'),
  occurred_at: z.string().datetime({ offset: true }),
  idempotency_key: z.string().min(1).max(255),
  external_user_id: z.string().max(255).nullish(),
  provider_key_id: z.string().uuid().nullish(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function verifyHmac(secretValue: string, payload: string, expectedHex: string): boolean {
  const expected = createHmac('sha256', secretValue).update(payload).digest('hex');
  if (expected.length !== expectedHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(expectedHex, 'hex'));
  } catch {
    return false;
  }
}

router.post('/v1/activations', async (c) => {
  const secretId = c.req.header('X-Relay-Secret-Id');
  const timestamp = c.req.header('X-Relay-Timestamp');
  const signature = c.req.header('X-Relay-Signature');

  if (!secretId || !timestamp || !signature) {
    return c.json({ error: 'missing_signature_headers' }, 400);
  }

  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) {
    return c.json({ error: 'invalid_timestamp' }, 400);
  }
  const skewSec = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (skewSec > SIGNATURE_FRESHNESS_SEC) {
    return c.json({ error: 'timestamp_outside_window' }, 400);
  }

  const rawBody = await c.req.raw.clone().text();

  const now = new Date();
  const [secret] = await db
    .select()
    .from(tenant_tracking_secrets)
    .where(
      and(
        eq(tenant_tracking_secrets.public_id, secretId),
        or(
          isNull(tenant_tracking_secrets.revoked_at),
          gt(tenant_tracking_secrets.revoked_at, now),
        ),
      ),
    )
    .limit(1);

  if (!secret) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  if (secret.grace_until && secret.grace_until.getTime() < now.getTime()) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const payload = `${timestamp}.${rawBody}`;
  if (!verifyHmac(secret.secret_value, payload, signature)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  let parsed: z.infer<typeof ActivationBody>;
  try {
    parsed = ActivationBody.parse(JSON.parse(rawBody));
  } catch {
    return c.json({ error: 'invalid_body' }, 400);
  }

  const tenantId = secret.tenant_id;
  let isWithin24h = false;
  let isWithin7d = false;
  let accountId: string | null = null;

  try {
    const [job] = await db
      .select()
      .from(signup_jobs)
      .where(eq(signup_jobs.id, parsed.signup_id))
      .limit(1);

    if (!job) {
      logger.warn(
        { tenantId, signup_id: parsed.signup_id },
        'activation_unknown_signup',
      );
      return c.json({ received: true }, 202);
    }
    if (job.tenant_id && job.tenant_id !== tenantId) {
      logger.warn(
        { tenantId, signup_id: parsed.signup_id, owner: job.tenant_id },
        'activation_cross_tenant',
      );
      return c.json({ received: true }, 202);
    }

    accountId = job.account_id ?? null;

    if (job.handoff_at) {
      const elapsedMs =
        new Date(parsed.occurred_at).getTime() - job.handoff_at.getTime();
      isWithin24h = elapsedMs >= 0 && elapsedMs <= TWENTY_FOUR_HOURS_MS;
      isWithin7d = elapsedMs >= 0 && elapsedMs <= SEVEN_DAYS_MS;
    }

    const inserted = await db
      .insert(activations)
      .values({
        tenant_id: tenantId,
        signup_id: parsed.signup_id,
        account_id: accountId,
        external_user_id: parsed.external_user_id ?? null,
        provider_key_id: parsed.provider_key_id ?? null,
        event_name: parsed.event_name,
        occurred_at: new Date(parsed.occurred_at),
        idempotency_key: parsed.idempotency_key,
        metadata_redacted: parsed.metadata ?? {},
        is_24h: isWithin24h,
        is_7d: isWithin7d,
      })
      .onConflictDoNothing({
        target: [activations.tenant_id, activations.idempotency_key],
      })
      .returning({ id: activations.id });

    if (inserted.length === 0) {
      return c.json({ received: true, duplicate: true }, 202);
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'activation_insert_failed',
    );
    Sentry.captureException(err);
  }

  return c.json({ received: true }, 202);
});

export default router;
