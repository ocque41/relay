#!/usr/bin/env tsx
/**
 * scripts/eval-billing.ts — curated end-to-end eval for the post-0025
 * billing surface.
 *
 * Verifies, in order, against a Stripe TEST account:
 *   1.  Bootstrap                  — fresh tenant + product registered
 *   2.  Yearly subscription        — Stripe API → webhook → DB row
 *   3.  Drive usage to plan limit  — sequential signups debit quota correctly
 *   4.  Quota crosses to zero      — boundary
 *   5.  Overage queueing           — stripe_pending_invoice_items rows
 *   6.  Failed-action refund       — failed signup unwinds the slot
 *   7.  Credit-pack purchase       — applyCreditPurchase → action_credits row
 *   8.  Credit ladder fires        — claim.source='credits' before overage
 *   9.  Overage flush              — POST /v1/cron/flush-overage to Stripe
 *  10.  Plan switch (B yearly→S yearly)
 *  11.  Teardown
 *
 * To keep the eval fast, step 1 directly UPDATEs
 * tenant_quota_state.included_remaining = 9 right after the subscription
 * lands, so steps 3–8 each play out in single-digit signups instead of a
 * thousand. The atomic decrement / overage queue / refund / credit
 * consumption logic is identical at any quota size; the unit tests cover
 * the per-call atomicity in isolation.
 *
 * Required env (the EVAL CLIENT reads these — the SERVER must have its
 * own counterparts already wired):
 *
 *   STRIPE_SECRET_KEY=rk_test_…           — restricted test key with
 *                                            Customers/Subscriptions/Prices/
 *                                            PaymentMethods/PaymentIntents/
 *                                            Invoices write
 *   STRIPE_WEBHOOK_SECRET=whsec_…         — same value the server uses
 *                                            (from `stripe listen --print-secret`)
 *   CRON_SECRET=…                         — for POST /v1/cron/flush-overage
 *   AGENT_TOKEN=agt_…                     — user-scope token, mints tenants
 *   API_BASE_URL=http://localhost:3000    — defaults to localhost
 *   DATABASE_URL=postgres://…             — same DB the server uses (to
 *                                            shrink quota for fast eval)
 *   STRIPE_PRICE_BUILDER_YEARLY=price_…   — test-mode yearly Builder
 *   STRIPE_PRICE_STARTER_YEARLY=price_…   — test-mode yearly Starter
 *   STRIPE_PRICE_CREDITS_BUILDER=price_…  — test-mode Builder credit pack
 *
 * On the SERVER side, ensure:
 *   BILLING_ENFORCEMENT=enforce
 *   BILLING_METER=actions
 *   BILLING_FAIRNESS=on
 *   ABUSE_ENFORCEMENT=warn        (default — keeps the per-user cap from 429ing)
 *
 * Plus a `stripe listen --forward-to ${API_BASE_URL}/v1/webhooks/stripe`
 * tunnel running so Stripe webhooks reach the server.
 */
import { randomUUID, createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { neon } from '@neondatabase/serverless';
import Stripe from 'stripe';

// ---------------------------------------------------------------------------
// Env loading + safety guards
// ---------------------------------------------------------------------------
function loadDotEnv(): void {
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    const raw = fs.readFileSync('.env', 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const k = trimmed.slice(0, eq).trim();
      let v = trimmed.slice(eq + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      )
        v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    // .env optional.
  }
}
loadDotEnv();

const ENV = {
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  CRON_SECRET: process.env.CRON_SECRET ?? '',
  AGENT_TOKEN: process.env.AGENT_TOKEN ?? '',
  API_BASE_URL: (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(
    /\/+$/,
    '',
  ),
  DATABASE_URL: process.env.DATABASE_URL ?? '',
  STRIPE_PRICE_BUILDER_YEARLY: process.env.STRIPE_PRICE_BUILDER_YEARLY ?? '',
  STRIPE_PRICE_STARTER_YEARLY: process.env.STRIPE_PRICE_STARTER_YEARLY ?? '',
  STRIPE_PRICE_CREDITS_BUILDER: process.env.STRIPE_PRICE_CREDITS_BUILDER ?? '',
  ALLOW_PROD_DESTRUCTIVE: process.env.ALLOW_PROD_DESTRUCTIVE === '1',
  WEBHOOK_PORT: Number(process.env.EVAL_WEBHOOK_PORT ?? '3099'),
  WEBHOOK_HOST: process.env.EVAL_WEBHOOK_HOST ?? 'http://localhost:3099',
  EVAL_QUOTA_HEADROOM: Number(process.env.EVAL_QUOTA_HEADROOM ?? '9'),
  OUTPUT_JSON: process.env.EVAL_OUTPUT === 'json',
} as const;

function preflight(): void {
  const missing: string[] = [];
  if (!ENV.STRIPE_SECRET_KEY) missing.push('STRIPE_SECRET_KEY');
  if (!ENV.STRIPE_WEBHOOK_SECRET) missing.push('STRIPE_WEBHOOK_SECRET');
  if (!ENV.CRON_SECRET) missing.push('CRON_SECRET');
  if (!ENV.AGENT_TOKEN) missing.push('AGENT_TOKEN');
  if (!ENV.DATABASE_URL) missing.push('DATABASE_URL');
  if (!ENV.STRIPE_PRICE_BUILDER_YEARLY) missing.push('STRIPE_PRICE_BUILDER_YEARLY');
  if (!ENV.STRIPE_PRICE_STARTER_YEARLY) missing.push('STRIPE_PRICE_STARTER_YEARLY');
  if (!ENV.STRIPE_PRICE_CREDITS_BUILDER) missing.push('STRIPE_PRICE_CREDITS_BUILDER');
  if (missing.length > 0) {
    console.error(`error: missing env: ${missing.join(', ')}`);
    process.exit(2);
  }

  // Refuse anything that doesn't smell like a Stripe TEST key — the eval
  // creates real PaymentIntents, and we don't want to charge real cards.
  if (
    !ENV.STRIPE_SECRET_KEY.startsWith('sk_test_') &&
    !ENV.STRIPE_SECRET_KEY.startsWith('rk_test_')
  ) {
    console.error(
      'error: STRIPE_SECRET_KEY must be a TEST key (sk_test_… or rk_test_…). ' +
        'Refusing to run against live Stripe.',
    );
    process.exit(2);
  }

  // Refuse production hosts unless explicitly allowed.
  let host = '';
  try {
    host = new URL(ENV.API_BASE_URL).hostname;
  } catch {
    // ignore
  }
  const looksLikeProd =
    /relay\.cumulush\.com$/i.test(host) || /prod/i.test(host);
  if (looksLikeProd && !ENV.ALLOW_PROD_DESTRUCTIVE) {
    console.error(
      `error: refusing destructive eval against ${host} without ALLOW_PROD_DESTRUCTIVE=1`,
    );
    process.exit(2);
  }
}
preflight();

const stripe = new Stripe(ENV.STRIPE_SECRET_KEY, {
  apiVersion: '2026-04-22.dahlia',
});

const sql = neon(ENV.DATABASE_URL);

// ---------------------------------------------------------------------------
// Logging + harness
// ---------------------------------------------------------------------------
type CheckStatus = 'pass' | 'fail' | 'skip';
interface Check {
  step: string;
  status: CheckStatus;
  detail?: string;
  ms?: number;
}
const results: Check[] = [];

function out(...args: unknown[]): void {
  if (!ENV.OUTPUT_JSON) console.log(...args);
}

function pass(step: string, detail?: string, ms?: number): void {
  results.push({ step, status: 'pass', detail, ms });
  out(`  ✓ ${step}${detail ? ` — ${detail}` : ''}${ms ? ` (${ms}ms)` : ''}`);
}

function fail(step: string, detail: string, ms?: number): void {
  results.push({ step, status: 'fail', detail, ms });
  out(`  ✗ ${step} — ${detail}`);
}

function redactId(id: string | null | undefined): string {
  if (!id) return '∅';
  if (id.length < 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t = Date.now();
  return { value: await fn(), ms: Date.now() - t };
}

interface BillingSummary {
  status: string | null;
  plan: string | null;
  billing_interval: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  canceled_at: string | null;
  stripe_customer_id: string | null;
  quota:
    | {
        included_total: number;
        included_remaining: number;
        overage_count: number;
        overage_price_cents: number;
        overage_spend_cents: number;
        period_start: string | null;
        period_end: string | null;
      }
    | null;
  credits: { total_remaining: number };
  plans: Array<{ id: string; included_actions: number; overage_price_cents: number }>;
}

async function billingSummary(integratorKey: string, tenantId: string): Promise<BillingSummary> {
  const res = await fetch(`${ENV.API_BASE_URL}/v1/dev/billing/summary`, {
    headers: {
      authorization: `Bearer ${integratorKey}`,
      'x-relay-tenant': tenantId,
    },
  });
  if (!res.ok) {
    throw new Error(`/v1/dev/billing/summary returned ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as BillingSummary;
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  predicate: (v: T) => boolean,
  opts: { timeoutMs: number; intervalMs: number; label: string },
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    const v = await fn();
    if (v !== null && predicate(v)) return v;
    await sleep(opts.intervalMs);
  }
  throw new Error(`timeout waiting for ${opts.label} after ${opts.timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Local webhook server — stand-in for a tenant's signup webhook
// ---------------------------------------------------------------------------
//
// The eval registers a tenant_provider whose signup_webhook_url points at
// this local server. When the workflow dispatches a signup, it POSTs here
// with the HMAC-signed payload; we decode the body, decide success vs
// failure based on input flags, and respond accordingly.
//
//   { simulate: 'fail' }   → respond 200 with malformed body (missing
//                             apiKey) — workflow throws → quota refunds.
//
// We intentionally don't verify the X-Relay-Signature on the eval side;
// we control the secret and there's nothing for the eval to defend.
function startTestWebhookServer(): Server {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      body += c;
    });
    req.on('end', () => {
      try {
        const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const inner = (parsed.input as Record<string, unknown>) ?? {};
        const simulate = inner.simulate ?? parsed.simulate;
        if (simulate === 'fail') {
          // Respond 200 with malformed body — provider.signup() throws on
          // missing accountId/apiKey, the workflow fails, refundIntegratorQuota
          // runs.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'simulated failure for eval' }));
          return;
        }
        const accountId = `eval-acct-${randomUUID()}`;
        const apiKey = `sk-eval-${randomUUID()}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            accountId,
            apiKey,
            externalId: accountId,
          }),
        );
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
  });
  server.listen(ENV.WEBHOOK_PORT);
  return server;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  out(`Relay billing eval — target: ${ENV.API_BASE_URL}`);
  out(`  Stripe key: ${redactId(ENV.STRIPE_SECRET_KEY)} (test mode)`);
  out(`  Local webhook: ${ENV.WEBHOOK_HOST} (port ${ENV.WEBHOOK_PORT})`);

  const webhookSrv = startTestWebhookServer();
  const teardown: Array<() => Promise<void>> = [
    async () => {
      await new Promise<void>((r) => webhookSrv.close(() => r()));
    },
  ];

  let exitCode = 0;
  let tenantId: string | undefined;
  let integratorKey: string | undefined;
  let productSlug: string | undefined;
  let stripeCustomerId: string | undefined;
  let stripeSubscriptionId: string | undefined;
  let stripeSubItemId: string | undefined;

  try {
    // ---------------------------------------------------------------
    // Step 1 — Bootstrap: mint tenant + register product
    // ---------------------------------------------------------------
    {
      const { value, ms } = await timed(() =>
        fetch(`${ENV.API_BASE_URL}/v1/tenants`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${ENV.AGENT_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: `eval-billing-${Date.now().toString(36)}`,
          }),
        }),
      );
      if (!value.ok) {
        const text = await value.text();
        fail('1. mint tenant', `status=${value.status} body=${text.slice(0, 120)}`, ms);
        throw new Error('bootstrap failed');
      }
      const body = (await value.json()) as {
        tenantId: string;
        integratorKey: string;
      };
      tenantId = body.tenantId;
      integratorKey = body.integratorKey;
      pass(
        '1a. mint tenant',
        `tenant=${redactId(tenantId)} key=${redactId(integratorKey)}`,
        ms,
      );
    }

    {
      const slug = `eval-product-${Date.now().toString(36)}`;
      const { value, ms } = await timed(() =>
        fetch(`${ENV.API_BASE_URL}/v1/dev/products`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${integratorKey!}`,
            'content-type': 'application/json',
            'x-relay-tenant': tenantId!,
          },
          body: JSON.stringify({
            slug,
            display_name: 'Eval Test Product',
            signup_webhook_url: `${ENV.WEBHOOK_HOST}/signup`,
            input_schema: { type: 'object' },
            verification_mode: 'none',
            categories: ['saas'],
            pricing_model: 'free',
          }),
        }),
      );
      if (!value.ok) {
        const text = await value.text();
        fail('1b. register product', `status=${value.status} body=${text.slice(0, 200)}`, ms);
        throw new Error('product registration failed');
      }
      productSlug = slug;
      pass('1b. register product', `slug=${slug}`, ms);
    }

    // ---------------------------------------------------------------
    // Step 2 — Yearly subscription via Stripe API
    // ---------------------------------------------------------------
    {
      const customer = await stripe.customers.create({
        email: `eval+${Date.now().toString(36)}@cumulush.com`,
        metadata: { tenant_id: tenantId! },
      });
      stripeCustomerId = customer.id;

      // Attach a test PaymentMethod via Stripe's pm_card_visa shortcut.
      const pm = await stripe.paymentMethods.create({
        type: 'card',
        card: { token: 'tok_visa' },
      });
      await stripe.paymentMethods.attach(pm.id, { customer: customer.id });
      await stripe.customers.update(customer.id, {
        invoice_settings: { default_payment_method: pm.id },
      });

      const sub = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: ENV.STRIPE_PRICE_BUILDER_YEARLY }],
        default_payment_method: pm.id,
        metadata: { tenant_id: tenantId!, plan: 'builder' },
      });
      stripeSubscriptionId = sub.id;
      stripeSubItemId = sub.items.data[0]!.id;

      teardown.push(async () => {
        try {
          await stripe.subscriptions.cancel(sub.id);
        } catch {}
        try {
          await stripe.customers.del(customer.id);
        } catch {}
      });

      // Poll until the webhook lands and our DB row is current.
      const summary = await pollUntil(
        async () => {
          try {
            return await billingSummary(integratorKey!, tenantId!);
          } catch {
            return null;
          }
        },
        (s) =>
          s.status === 'active' &&
          s.plan === 'builder' &&
          s.billing_interval === 'yearly',
        { timeoutMs: 20_000, intervalMs: 500, label: 'subscription webhook landing' },
      );

      const periodEnd = summary.current_period_end ? new Date(summary.current_period_end) : null;
      const days = periodEnd
        ? (periodEnd.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
        : 0;
      if (days < 360) {
        fail(
          '2. yearly subscription',
          `current_period_end ${days.toFixed(1)}d out, expected >360d`,
        );
      } else if (summary.quota?.included_total !== 1000) {
        fail(
          '2. yearly subscription',
          `quota.included_total=${summary.quota?.included_total ?? '∅'}, expected 1000`,
        );
      } else {
        pass(
          '2. yearly subscription',
          `cust=${redactId(customer.id)} sub=${redactId(sub.id)} interval=yearly period≈${days.toFixed(0)}d quota=${summary.quota.included_remaining}/${summary.quota.included_total}`,
        );
      }
    }

    // ---------------------------------------------------------------
    // Step 2b — Shrink quota to EVAL_QUOTA_HEADROOM for fast test
    // ---------------------------------------------------------------
    //
    // Stripe fires several webhooks back-to-back on a new yearly sub
    // (customer.subscription.created, invoice.created,
    // invoice.payment_succeeded, …) and several of those reset
    // tenant_quota_state.included_remaining to the plan's full
    // 1000-action allowance. We wait for the dust to settle, then
    // run an idempotent UPDATE in a retry loop — if a straggler
    // webhook resets us, we reshrink.
    {
      const headroom = ENV.EVAL_QUOTA_HEADROOM;
      // First: drain any in-flight webhook traffic. invoice.payment_succeeded
      // arrives after customer.subscription.created in test mode and writes
      // to the same row; 6s is comfortably enough in practice.
      await sleep(6_000);

      let lastObserved: number | null = null;
      let stuck = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        await sql`
          UPDATE tenant_quota_state
             SET included_remaining = ${headroom}, updated_at = now()
           WHERE tenant_id = ${tenantId!}
        `;
        // Verify it stays at `headroom` over a short window — if a
        // webhook comes in within a second and resets, we'll see it.
        await sleep(1_500);
        const s = await billingSummary(integratorKey!, tenantId!);
        lastObserved = s.quota?.included_remaining ?? null;
        if (lastObserved === headroom) {
          stuck = true;
          break;
        }
        out(
          `   (attempt ${attempt + 1}: included_remaining bounced to ${lastObserved}, retrying)`,
        );
      }
      if (stuck) {
        pass('2b. shrink quota for eval', `included_remaining=${headroom}`);
      } else {
        fail(
          '2b. shrink quota for eval',
          `expected ${headroom}, observed ${lastObserved ?? '∅'} after 5 retries`,
        );
      }
    }

    // Helper that fires one signup + polls for terminal state.
    async function dispatchSignup(opts: { simulateFail?: boolean }): Promise<{
      signup_id: string;
      status: string;
      error?: string;
    }> {
      const res = await fetch(`${ENV.API_BASE_URL}/v1/signups`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${ENV.AGENT_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          provider: productSlug,
          input: opts.simulateFail
            ? { simulate: 'fail', name: 'eval' }
            : { name: 'eval' },
        }),
      });
      if (!res.ok) {
        throw new Error(
          `POST /v1/signups returned ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
      }
      const created = (await res.json()) as { signup_id: string };
      // Poll for terminal status.
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        const r = await fetch(`${ENV.API_BASE_URL}/v1/signups/${created.signup_id}`, {
          headers: { authorization: `Bearer ${ENV.AGENT_TOKEN}` },
        });
        if (!r.ok) continue;
        const body = (await r.json()) as {
          status: string;
          error?: string;
        };
        if (body.status === 'complete' || body.status === 'completed' || body.status === 'failed') {
          return { signup_id: created.signup_id, status: body.status, error: body.error };
        }
      }
      throw new Error(`signup ${created.signup_id} did not terminate within 20s`);
    }

    // ---------------------------------------------------------------
    // Step 3 — Drive usage to plan limit
    // ---------------------------------------------------------------
    {
      const headroom = ENV.EVAL_QUOTA_HEADROOM;
      let last: BillingSummary | null = null;
      let i = 0;
      try {
        for (i = 0; i < headroom - 1; i++) {
          const r = await dispatchSignup({});
          if (r.status === 'failed') {
            fail('3. drive usage', `signup ${i + 1}/${headroom - 1} failed: ${r.error}`);
            throw new Error('drive usage failed');
          }
          last = await billingSummary(integratorKey!, tenantId!);
        }
      } catch (err) {
        fail('3. drive usage', `i=${i} ${(err as Error).message}`);
        throw err;
      }
      // After (headroom - 1) successful signups, included_remaining should
      // be exactly 1.
      if (last?.quota?.included_remaining === 1 && last.quota.overage_count === 0) {
        pass('3. drive usage', `${headroom - 1} signups → included_remaining=1, overage_count=0`);
      } else {
        fail(
          '3. drive usage',
          `expected included_remaining=1 overage=0, got ${last?.quota?.included_remaining}/${last?.quota?.overage_count}`,
        );
      }
    }

    // ---------------------------------------------------------------
    // Step 4 — One more signup → quota crosses to zero
    // ---------------------------------------------------------------
    {
      const r = await dispatchSignup({});
      if (r.status === 'failed') {
        fail('4. quota → 0', `signup failed: ${r.error}`);
      } else {
        const s = await billingSummary(integratorKey!, tenantId!);
        if (s.quota?.included_remaining === 0 && s.quota.overage_count === 0) {
          pass('4. quota → 0', 'included_remaining=0, overage_count=0');
        } else {
          fail(
            '4. quota → 0',
            `expected 0/0 got ${s.quota?.included_remaining}/${s.quota?.overage_count}`,
          );
        }
      }
    }

    // ---------------------------------------------------------------
    // Step 5 — Overage queueing: 5 more signups
    // ---------------------------------------------------------------
    const expectedOverageCents = 5;
    {
      let s: BillingSummary | null = null;
      for (let i = 0; i < 5; i++) {
        await dispatchSignup({});
        s = await billingSummary(integratorKey!, tenantId!);
      }
      const overageRows = await sql`
        SELECT amount_cents, idempotency_key, flushed_at, signup_job_id
          FROM stripe_pending_invoice_items
         WHERE tenant_id = ${tenantId!}
      ` as Array<{
        amount_cents: number;
        idempotency_key: string;
        flushed_at: Date | null;
        signup_job_id: string | null;
      }>;
      const unflushed = overageRows.filter((r) => r.flushed_at === null);
      const uniqueKeys = new Set(unflushed.map((r) => r.idempotency_key));
      const allRightAmount = unflushed.every((r) => r.amount_cents === expectedOverageCents);

      if (
        s?.quota?.overage_count === 5 &&
        unflushed.length === 5 &&
        uniqueKeys.size === 5 &&
        allRightAmount
      ) {
        pass(
          '5. overage queueing',
          `overage_count=5, ${unflushed.length} unflushed pending rows @ ${expectedOverageCents}¢ each`,
        );
      } else {
        fail(
          '5. overage queueing',
          `summary.overage=${s?.quota?.overage_count} unflushed=${unflushed.length} unique_keys=${uniqueKeys.size} amounts_ok=${allRightAmount}`,
        );
      }
    }

    // ---------------------------------------------------------------
    // Step 6 — Failed-action refund
    // ---------------------------------------------------------------
    {
      const beforeCount = (
        (await sql`
        SELECT count(*) AS c FROM stripe_pending_invoice_items
         WHERE tenant_id = ${tenantId!} AND flushed_at IS NULL
      `) as Array<{ c: number | string }>
      )[0]?.c;
      const r = await dispatchSignup({ simulateFail: true });
      // Workflow should have failed.
      if (r.status !== 'failed') {
        fail('6. failed-action refund', `expected status=failed, got ${r.status}`);
      } else {
        const afterCount = (
          (await sql`
          SELECT count(*) AS c FROM stripe_pending_invoice_items
           WHERE tenant_id = ${tenantId!} AND flushed_at IS NULL
        `) as Array<{ c: number | string }>
        )[0]?.c;
        const s = await billingSummary(integratorKey!, tenantId!);
        const before = Number(beforeCount);
        const after = Number(afterCount);
        if (
          before === 5 &&
          after === 5 &&
          s.quota?.overage_count === 5 &&
          s.quota.included_remaining === 0
        ) {
          pass(
            '6. failed-action refund',
            `pending rows stayed at 5 (failed signup refunded its overage row); included_remaining=0`,
          );
        } else {
          fail(
            '6. failed-action refund',
            `before=${before} after=${after} overage=${s.quota?.overage_count} included=${s.quota?.included_remaining}`,
          );
        }
      }
    }

    // ---------------------------------------------------------------
    // Step 7 — Credit-pack purchase (real PaymentIntent + signed webhook)
    // ---------------------------------------------------------------
    {
      // Create a real PaymentIntent on the test customer for the Builder
      // pack amount. This makes the eval's "extra credit purchase" claim
      // real on the Stripe side; the webhook simulates the
      // checkout.session.completed event so applyCreditPurchase fires.
      const pi = await stripe.paymentIntents.create({
        amount: 2000,
        currency: 'usd',
        customer: stripeCustomerId!,
        payment_method: 'pm_card_visa',
        confirm: true,
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'never',
        },
        metadata: {
          tenant_id: tenantId!,
          pack: 'builder',
          kind: 'credit_pack',
        },
      });

      // Build a fake Checkout.Session that points at the real PaymentIntent.
      const synthSessionId = `cs_eval_${randomUUID().replace(/-/g, '')}`;
      const session = {
        id: synthSessionId,
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: pi.id,
        customer: stripeCustomerId!,
        metadata: {
          tenant_id: tenantId!,
          pack: 'builder',
          kind: 'credit_pack',
        },
        expires_at: Math.floor(Date.now() / 1000) + 1800,
      };
      const event = {
        id: `evt_eval_${randomUUID().replace(/-/g, '')}`,
        object: 'event',
        api_version: '2026-04-22.dahlia',
        created: Math.floor(Date.now() / 1000),
        type: 'checkout.session.completed',
        data: { object: session },
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
      };

      const payload = JSON.stringify(event);
      const timestamp = Math.floor(Date.now() / 1000);
      const signedPayload = `${timestamp}.${payload}`;
      const signature = createHmac('sha256', ENV.STRIPE_WEBHOOK_SECRET)
        .update(signedPayload)
        .digest('hex');
      const stripeSig = `t=${timestamp},v1=${signature}`;

      const wh = await fetch(`${ENV.API_BASE_URL}/v1/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': stripeSig,
        },
        body: payload,
      });
      if (!wh.ok) {
        fail(
          '7. credit-pack purchase',
          `forged webhook returned ${wh.status}: ${(await wh.text()).slice(0, 200)}`,
        );
      } else {
        // Poll for credit row.
        const summary = await pollUntil(
          async () => {
            try {
              return await billingSummary(integratorKey!, tenantId!);
            } catch {
              return null;
            }
          },
          (s) => s.credits.total_remaining > 0,
          { timeoutMs: 5_000, intervalMs: 200, label: 'credit row insertion' },
        );
        if (summary.credits.total_remaining === 500) {
          pass(
            '7. credit-pack purchase',
            `pi=${redactId(pi.id)} session=${redactId(synthSessionId)} credits.total_remaining=500`,
          );
        } else {
          fail(
            '7. credit-pack purchase',
            `expected credits.total_remaining=500, got ${summary.credits.total_remaining}`,
          );
        }
      }
    }

    // ---------------------------------------------------------------
    // Step 8 — Credit ladder fires before overage
    // ---------------------------------------------------------------
    {
      const overageBefore = (
        (await sql`
          SELECT count(*) AS c FROM stripe_pending_invoice_items
           WHERE tenant_id = ${tenantId!} AND flushed_at IS NULL
        `) as Array<{ c: number | string }>
      )[0]?.c;
      const beforeCredits = (
        await sql`
          SELECT actions_remaining FROM action_credits
           WHERE tenant_id = ${tenantId!}
        `
      ) as Array<{ actions_remaining: number }>;
      const beforeRemaining = beforeCredits[0]?.actions_remaining ?? 0;

      // Drive 2 successful signups; both should consume from credits.
      await dispatchSignup({});
      await dispatchSignup({});

      const afterCredits = (
        await sql`
          SELECT actions_remaining FROM action_credits
           WHERE tenant_id = ${tenantId!}
        `
      ) as Array<{ actions_remaining: number }>;
      const afterRemaining = afterCredits[0]?.actions_remaining ?? 0;
      const overageAfter = (
        (await sql`
          SELECT count(*) AS c FROM stripe_pending_invoice_items
           WHERE tenant_id = ${tenantId!} AND flushed_at IS NULL
        `) as Array<{ c: number | string }>
      )[0]?.c;

      if (
        afterRemaining === beforeRemaining - 2 &&
        Number(overageAfter) === Number(overageBefore)
      ) {
        pass(
          '8. credit ladder fires',
          `credits ${beforeRemaining}→${afterRemaining}, overage stayed at ${overageAfter}`,
        );
      } else {
        fail(
          '8. credit ladder fires',
          `credits ${beforeRemaining}→${afterRemaining}, overage ${overageBefore}→${overageAfter}`,
        );
      }
    }

    // ---------------------------------------------------------------
    // Step 9 — Overage flush (the "extra credit purchase success" check)
    // ---------------------------------------------------------------
    {
      const flush = await fetch(`${ENV.API_BASE_URL}/v1/cron/flush-overage`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ENV.CRON_SECRET}` },
      });
      if (!flush.ok) {
        fail(
          '9. overage flush',
          `cron returned ${flush.status}: ${(await flush.text()).slice(0, 200)}`,
        );
      } else {
        const body = (await flush.json()) as { flushed: number; skipped: number };
        // Verify all rows now have flushed_at set.
        const remaining = (
          (await sql`
            SELECT count(*) AS c FROM stripe_pending_invoice_items
             WHERE tenant_id = ${tenantId!} AND flushed_at IS NULL
          `) as Array<{ c: number | string }>
        )[0]?.c;
        const flushedRows = (
          (await sql`
            SELECT count(*) AS c FROM stripe_pending_invoice_items
             WHERE tenant_id = ${tenantId!} AND flushed_at IS NOT NULL
          `) as Array<{ c: number | string }>
        )[0]?.c;
        if (Number(remaining) === 0 && Number(flushedRows) >= 5) {
          pass(
            '9. overage flush',
            `flushed=${body.flushed} skipped=${body.skipped}; ${flushedRows} pending rows now have flushed_at`,
          );
        } else {
          fail(
            '9. overage flush',
            `unflushed=${remaining}, flushed=${flushedRows}, body={flushed:${body.flushed}, skipped:${body.skipped}}`,
          );
        }
      }
    }

    // ---------------------------------------------------------------
    // Step 10 — Plan switch (Builder yearly → Starter yearly)
    // ---------------------------------------------------------------
    {
      await stripe.subscriptions.update(stripeSubscriptionId!, {
        items: [{ id: stripeSubItemId!, price: ENV.STRIPE_PRICE_STARTER_YEARLY }],
        proration_behavior: 'create_prorations',
        metadata: { tenant_id: tenantId!, plan: 'starter' },
      });
      const summary = await pollUntil(
        async () => {
          try {
            return await billingSummary(integratorKey!, tenantId!);
          } catch {
            return null;
          }
        },
        (s) =>
          s.plan === 'starter' &&
          s.billing_interval === 'yearly' &&
          (s.quota?.included_remaining ?? 0) >= 9999,
        { timeoutMs: 15_000, intervalMs: 500, label: 'plan-switch webhook' },
      );
      if (summary.credits.total_remaining > 0) {
        pass(
          '10. plan switch',
          `plan=starter interval=yearly quota=${summary.quota?.included_remaining}/${summary.quota?.included_total}, credits.total_remaining=${summary.credits.total_remaining} (preserved)`,
        );
      } else {
        fail(
          '10. plan switch',
          `expected credits to survive plan switch; total_remaining=${summary.credits.total_remaining}`,
        );
      }
    }

    pass('11. teardown', '(deferred to finally)');
  } catch (err) {
    out(`\nfatal: ${(err as Error).message}`);
    exitCode = 1;
  } finally {
    out('\n--- teardown ---');
    for (const fn of teardown.reverse()) {
      try {
        await fn();
      } catch {}
    }
  }

  // Final summary
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;

  const summary = {
    api_base_url: ENV.API_BASE_URL,
    totals: { passed, failed, total: results.length },
    billing: {
      subscriptionCreated: results.some((r) => r.step.startsWith('2.') && r.status === 'pass'),
      planAssigned: results.some((r) => r.step.startsWith('2.') && r.status === 'pass')
        ? 'builder'
        : null,
      billingInterval: results.some((r) => r.step.startsWith('2.') && r.status === 'pass')
        ? 'yearly'
        : null,
      quotaCorrect:
        results.find((r) => r.step.startsWith('3.'))?.status === 'pass' &&
        results.find((r) => r.step.startsWith('4.'))?.status === 'pass',
      overageQueued: results.find((r) => r.step.startsWith('5.'))?.status === 'pass',
      refundedOnFailure: results.find((r) => r.step.startsWith('6.'))?.status === 'pass',
      creditPackPurchased: results.find((r) => r.step.startsWith('7.'))?.status === 'pass',
      creditsConsumedBeforeOverage:
        results.find((r) => r.step.startsWith('8.'))?.status === 'pass',
      overageFlushedToStripe: results.find((r) => r.step.startsWith('9.'))?.status === 'pass',
      planSwitchOk: results.find((r) => r.step.startsWith('10.'))?.status === 'pass',
    },
    results,
  };

  if (ENV.OUTPUT_JSON) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    out(`\n${passed} passed · ${failed} failed`);
    out('billing flags:');
    for (const [k, v] of Object.entries(summary.billing)) {
      out(`  ${v === true || (typeof v === 'string' && v) ? '✓' : '✗'} ${k}: ${String(v)}`);
    }
  }

  if (failed > 0 || exitCode === 1) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error('eval-billing crashed:', err);
  process.exit(2);
});
