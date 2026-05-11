/**
 * /v1/cron/* — scheduled maintenance endpoints triggered by Vercel Crons
 * (schedule declared in vercel.ts). Each endpoint is idempotent.
 *
 * GC targets (delete rows past their TTL):
 *   - email_otps               (used_at NOT NULL OR older than 24h)
 *   - webauthn_challenges       (expires_at < now)
 *   - sessions                 (expires_at < now)
 *   - cli_auth_codes           (expires_at < now OR picked_up_at > 5 min ago)
 *   - signup_confirmations     (older than 24h AND confirmed_at NOT NULL; expired rows kept for a grace period then deleted)
 *
 * Auth: Vercel's cron dispatcher sends `Authorization: Bearer <CRON_SECRET>`.
 * If CRON_SECRET is unset, the endpoint is open (acceptable — it only
 * performs idempotent deletes of expired rows and doesn't leak anything).
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db/index';
import {
  cli_auth_codes,
  email_otps,
  magic_links,
  scale_benchmark_samples,
  sessions,
  signup_confirmations,
  signup_jobs,
  stripe_pending_invoice_items,
  tenant_plan_features,
  tenants,
  webauthn_challenges,
} from '../db/schema';
import { signAttestation } from '../auth/attest';
import { stripe } from '../billing/stripe';
import { eq } from 'drizzle-orm';

const app = new OpenAPIHono();

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/cron/gc',
    tags: ['cron'],
    summary: 'Garbage-collect expired ephemeral rows',
    responses: {
      200: {
        description: 'Counts of deleted rows per table.',
        content: {
          'application/json': {
            schema: z.object({
              email_otps: z.number(),
              webauthn_challenges: z.number(),
              sessions: z.number(),
              cli_auth_codes: z.number(),
              signup_confirmations: z.number(),
              magic_links: z.number(),
              pending_credentials_scrubbed: z.number(),
            }),
          },
        },
      },
      401: { description: 'Bad cron secret.', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const expected = process.env.CRON_SECRET;
    if (expected) {
      const auth = c.req.header('authorization');
      if (auth !== `Bearer ${expected}`) {
        return c.json({ error: 'unauthorized' }, 401);
      }
    }

    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [otps, challenges, sess, cli, confirms, magic, scrubbed] = await Promise.all([
      db
        .delete(email_otps)
        .where(or(isNotNull(email_otps.used_at), lt(email_otps.expires_at, dayAgo)))
        .returning({ id: email_otps.id }),
      db
        .delete(webauthn_challenges)
        .where(lt(webauthn_challenges.expires_at, now))
        .returning({ id: webauthn_challenges.id }),
      db
        .delete(sessions)
        .where(lt(sessions.expires_at, now))
        .returning({ jti: sessions.jti }),
      db
        .delete(cli_auth_codes)
        .where(
          or(
            lt(cli_auth_codes.expires_at, now),
            and(
              isNotNull(cli_auth_codes.picked_up_at),
              lt(cli_auth_codes.picked_up_at, new Date(now.getTime() - 5 * 60 * 1000)),
            ),
          ),
        )
        .returning({ id: cli_auth_codes.id }),
      db
        .delete(signup_confirmations)
        .where(lt(signup_confirmations.expires_at, dayAgo))
        .returning({ id: signup_confirmations.id }),
      // magic_links: delete anything past its expiry; claimed single-use rows
      // live briefly so the share page can display "already used" before
      // being pruned.
      db
        .delete(magic_links)
        .where(lt(magic_links.expires_at, now))
        .returning({ id: magic_links.id }),
      // Safety net for the zero-retention API key policy: if an agent minted a
      // key via the signup workflow but never polled GET /v1/signups/:id to
      // pick it up, scrub pending_credentials_enc after 24h so the encrypted
      // bytes don't linger in the database.
      db
        .update(signup_jobs)
        .set({ pending_credentials_enc: null, credentials_delivered_at: now })
        .where(
          and(
            isNotNull(signup_jobs.pending_credentials_enc),
            isNull(signup_jobs.credentials_delivered_at),
            lt(signup_jobs.updated_at, dayAgo),
          ),
        )
        .returning({ id: signup_jobs.id }),
    ]);

    return c.json(
      {
        email_otps: otps.length,
        webauthn_challenges: challenges.length,
        sessions: sess.length,
        cli_auth_codes: cli.length,
        signup_confirmations: confirms.length,
        magic_links: magic.length,
        pending_credentials_scrubbed: scrubbed.length,
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// /v1/cron/flush-overage — push queued per-signup overage charges to Stripe
//
// Walks stripe_pending_invoice_items WHERE flushed_at IS NULL, creates one
// Stripe invoice item per row via the Subscription's customer, and stamps
// flushed_at. Idempotent: `metadata.signup_job_id` is set on the Stripe side
// so Stripe de-duplicates retries. Runs at the top of each month; individual
// overage items stay pending at most ~31 days, bounded by the plan's billing
// period.
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/cron/flush-overage',
    tags: ['cron'],
    summary: 'Push queued signup overage charges to Stripe invoice items',
    responses: {
      200: {
        description: 'Counts of rows flushed + skipped.',
        content: {
          'application/json': {
            schema: z.object({
              flushed: z.number(),
              skipped: z.number(),
            }),
          },
        },
      },
      401: { description: 'Bad cron secret.', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const expected = process.env.CRON_SECRET;
    if (expected) {
      const auth = c.req.header('authorization');
      if (auth !== `Bearer ${expected}`) {
        return c.json({ error: 'unauthorized' }, 401);
      }
    }

    const pending = await db
      .select()
      .from(stripe_pending_invoice_items)
      .where(isNull(stripe_pending_invoice_items.flushed_at));

    let flushed = 0;
    let skipped = 0;

    for (const row of pending) {
      if (!row.stripe_subscription_id) {
        // No subscription on file (shouldn't happen for a Stripe-bound tenant).
        // Skip so ops can investigate rather than silently drop the charge.
        skipped++;
        continue;
      }
      try {
        const s = stripe();
        const sub = await s.subscriptions.retrieve(row.stripe_subscription_id);
        const customerId =
          typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;
        if (!customerId) {
          skipped++;
          continue;
        }
        await s.invoiceItems.create(
          {
            customer: customerId,
            subscription: row.stripe_subscription_id,
            amount: row.amount_cents,
            currency: 'usd',
            description: 'Relay signup overage',
            metadata: {
              signup_job_id: row.signup_job_id,
              tenant_id: row.tenant_id,
            },
          },
          {
            // Stripe idempotency key tied to our row id.
            idempotencyKey: `relay-overage-${row.id}`,
          },
        );
        await db
          .update(stripe_pending_invoice_items)
          .set({ flushed_at: new Date() })
          .where(eq(stripe_pending_invoice_items.id, row.id));
        flushed++;
      } catch (err) {
        console.error('[cron.flush-overage] failed for row', row.id, err);
        skipped++;
      }
    }

    return c.json({ flushed, skipped }, 200);
  },
);

// ---------------------------------------------------------------------------
// /v1/cron/scale-benchmark — Scale-plan performance SLA sampler.
//
// Pricing v2: every Scale tenant carries a P95 latency SLA. This probe runs
// every 5 min for each tenant with tenant_plan_features.features.scale_e2e_
// benchmark=true, measures Relay-internal latencies that Relay owns
// (tenant row lookup + JWT signing), and records each stage for the
// /dev/analytics dashboard. Auto-credit logic lives in the dashboard
// (flags when P95 > 3 s over the last 24 h).
//
// We intentionally don't probe the integrator's endpoint here — that's
// outside Relay's SLA. Full-loop monitoring is a separate external tool.
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/cron/scale-benchmark',
    tags: ['cron'],
    summary: 'Sample Relay-internal latencies for every Scale tenant',
    responses: {
      200: {
        description: 'Sample counts per stage.',
        content: {
          'application/json': {
            schema: z.object({
              tenants_probed: z.number(),
              samples_written: z.number(),
            }),
          },
        },
      },
      401: { description: 'Bad cron secret.', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const expected = process.env.CRON_SECRET;
    if (expected) {
      const auth = c.req.header('authorization');
      if (auth !== `Bearer ${expected}`) {
        return c.json({ error: 'unauthorized' }, 401);
      }
    }

    const scaleTenants = await db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        features: tenant_plan_features.features,
      })
      .from(tenants)
      .innerJoin(
        tenant_plan_features,
        eq(tenant_plan_features.tenant_id, tenants.id),
      );

    const samples: Array<typeof scale_benchmark_samples.$inferInsert> = [];
    let probed = 0;

    for (const t of scaleTenants) {
      const features = (t.features as Record<string, unknown>) ?? {};
      if (features.scale_e2e_benchmark !== true) continue;
      probed++;

      // Stage 1: tenant row lookup
      const dbStart = Date.now();
      try {
        await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, t.id)).limit(1);
        samples.push({
          tenant_id: t.id,
          stage: 'db_lookup',
          latency_ms: Date.now() - dbStart,
          ok: true,
        });
      } catch (err) {
        samples.push({
          tenant_id: t.id,
          stage: 'db_lookup',
          latency_ms: Date.now() - dbStart,
          ok: false,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }

      // Stage 2: attestation signing (synthetic payload)
      const signStart = Date.now();
      try {
        await signAttestation({
          tenantId: t.id,
          externalUserId: '00000000-0000-0000-0000-000000000000',
          relayUserId: '00000000-0000-0000-0000-000000000000',
          email: 'probe@relay.cumulush.com',
          actor: 'agent',
        });
        samples.push({
          tenant_id: t.id,
          stage: 'attest_sign',
          latency_ms: Date.now() - signStart,
          ok: true,
        });
      } catch (err) {
        samples.push({
          tenant_id: t.id,
          stage: 'attest_sign',
          latency_ms: Date.now() - signStart,
          ok: false,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    if (samples.length > 0) {
      await db.insert(scale_benchmark_samples).values(samples);
    }

    return c.json(
      { tenants_probed: probed, samples_written: samples.length },
      200,
    );
  },
);

export default app;
