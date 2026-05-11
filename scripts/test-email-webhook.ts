/**
 * Smoke-test for the SendGrid Inbound Parse webhook.
 *
 * Simulates SendGrid POSTing an inbound email as multipart/form-data to
 *   POST http://localhost:3000/v1/webhooks/email?secret=<EMAIL_SENDGRID_SECRET>
 *
 * Usage:
 *   # start the server
 *   npm run dev
 *
 *   # in a second shell:
 *   npx tsx scripts/test-email-webhook.ts                # uses a random UUID
 *   SIGNUP_ID=<uuid> npx tsx scripts/test-email-webhook.ts  # target a real job
 *
 * Pass an existing `signup_jobs.id` via `SIGNUP_ID` to exercise the full
 * `matched: true` branch (the job must have `status = 'awaiting_email'`).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// -----------------------------------------------------------------------------
// Load .env manually — tsx does not auto-load dotenv, and this script must run
// without depending on the project's runtime.
// -----------------------------------------------------------------------------
function loadDotEnv(path: string): void {
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // .env is optional for this script
  }
}

loadDotEnv(resolve(process.cwd(), '.env'));

const EMAIL_SENDGRID_SECRET = process.env.EMAIL_SENDGRID_SECRET;
if (!EMAIL_SENDGRID_SECRET) {
  console.error('ERROR: EMAIL_SENDGRID_SECRET is not set (checked .env and process.env).');
  process.exit(1);
}

const CATCHALL_DOMAIN = process.env.CATCHALL_DOMAIN ?? 'inbox.cumulush.com';
const SIGNUP_ID = process.env.SIGNUP_ID ?? randomUUID();
const BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000';

const toAddress = `signup-${SIGNUP_ID}@${CATCHALL_DOMAIN}`;
const fromAddress = 'noreply@example.com';
const subject = 'Verify your email';
const bodyText =
  'Hello!\n\nClick here to verify: https://example.com/verify?token=abc123\n\nOr use code 482913.\n\nThanks.';

/** Build a multipart/form-data payload that mirrors SendGrid Inbound Parse. */
function buildForm(): FormData {
  const form = new FormData();
  form.set('to', toAddress);
  form.set('from', fromAddress);
  form.set('subject', subject);
  form.set('text', bodyText);
  form.set('headers', 'Message-ID: <test-email-webhook@example.com>\nX-Test: yes');
  form.set(
    'envelope',
    JSON.stringify({ to: [toAddress], from: fromAddress }),
  );
  return form;
}

const endpointOk = `${BASE_URL}/v1/webhooks/email?secret=${encodeURIComponent(EMAIL_SENDGRID_SECRET)}`;
const endpointBad = `${BASE_URL}/v1/webhooks/email?secret=nope-${randomUUID()}`;

console.log('POST', endpointOk);
console.log('To:  ', toAddress);
console.log('');

async function main() {
  // 1. Valid secret
  const res = await fetch(endpointOk, { method: 'POST', body: buildForm() });
  const text = await res.text();
  console.log('--- Valid secret ---');
  console.log('status:', res.status);
  console.log('body:  ', text);
  console.log('');

  // 2. Invalid secret — must 401
  const badRes = await fetch(endpointBad, { method: 'POST', body: buildForm() });
  const badText = await badRes.text();
  console.log('--- Invalid secret ---');
  console.log('status:', badRes.status);
  console.log('body:  ', badText);

  if (badRes.status !== 401) {
    console.error('\nFAIL: invalid secret should return 401');
    process.exit(1);
  }
  if (res.status !== 200) {
    console.error('\nFAIL: valid secret should return 200');
    process.exit(1);
  }

  console.log('\nOK: webhook accepted valid secret and rejected invalid one.');
}

main().catch((err) => {
  console.error('Request failed:', err);
  process.exit(1);
});
