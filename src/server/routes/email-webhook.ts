import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { resumeHook } from 'workflow/api';
import { db } from '../db/index';
import {
  signup_jobs,
  email_messages,
  users,
  user_workspaces,
  accounts,
} from '../db/schema';
import { parseEmailAlias } from '../email/parse';
import type { InboundEmail } from '../providers/types';

const app = new Hono();

interface EmailWebhookPayload {
  to: string;
  from: string;
  subject: string;
  bodyText: string;
  headers: Record<string, string>;
}

/**
 * Route a normalized inbound email to the right destination: either
 * (a) a suspended signup_jobs workflow awaiting email, or
 * (b) a user's agent inbox (inbox_alias), or
 * (c) unmatched — stored for operator inspection.
 */
async function processInboundEmail(payload: EmailWebhookPayload) {
  const localPart = (payload.to.split('@')[0] ?? '').toLowerCase();
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  let matchedSignupId: string | null = null;
  let matchedUserId: string | null = null;
  let matchedUserWorkspaceId: string | null = null;

  const signupAlias = parseEmailAlias(payload.to);
  if (signupAlias && uuidRe.test(signupAlias)) {
    const [job] = await db
      .select({
        id: signup_jobs.id,
        status: signup_jobs.status,
        account_id: signup_jobs.account_id,
        user_id: signup_jobs.user_id,
        user_workspace_id: signup_jobs.user_workspace_id,
      })
      .from(signup_jobs)
      .where(eq(signup_jobs.id, signupAlias))
      .limit(1);
    if (job) {
      matchedSignupId = job.id;
      matchedUserId = job.user_id ?? null;
      matchedUserWorkspaceId = job.user_workspace_id ?? null;
      if (job.account_id) {
        const [acc] = await db
          .select({ email_alias: accounts.email_alias })
          .from(accounts)
          .where(eq(accounts.id, job.account_id))
          .limit(1);
        void acc;
      }
    }
  }

  // Per-workspace inbox alias is the primary resolver. Each user workspace
  // owns its own inbox_alias, so matching here stamps both user_id and
  // user_workspace_id in one read.
  if (!matchedSignupId && localPart) {
    const [ws] = await db
      .select({
        id: user_workspaces.id,
        user_id: user_workspaces.user_id,
      })
      .from(user_workspaces)
      .where(eq(user_workspaces.inbox_alias, localPart))
      .limit(1);
    if (ws) {
      matchedUserId = ws.user_id;
      matchedUserWorkspaceId = ws.id;
    }
  }

  // Legacy fallback: `users.inbox_alias` still resolves for users who signed
  // up before workspace aliases and haven't been backfilled, or for aliases minted by
  // older code paths. Resolves only user_id; leaves user_workspace_id null.
  if (!matchedSignupId && !matchedUserId && localPart) {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.inbox_alias, localPart))
      .limit(1);
    if (user) matchedUserId = user.id;
  }

  await db.insert(email_messages).values({
    to_address: payload.to,
    from_address: payload.from,
    subject: payload.subject,
    body_text: payload.bodyText,
    headers: payload.headers,
    matched_signup_id: matchedSignupId,
    user_id: matchedUserId,
    user_workspace_id: matchedUserWorkspaceId,
  });

  const emailForWorkflow: InboundEmail = {
    to: payload.to,
    from: payload.from,
    subject: payload.subject,
    bodyText: payload.bodyText,
    headers: payload.headers,
  };

  if (matchedSignupId) {
    const [job] = await db
      .select({ status: signup_jobs.status })
      .from(signup_jobs)
      .where(eq(signup_jobs.id, matchedSignupId))
      .limit(1);
    if (job?.status === 'awaiting_email') {
      try {
        await resumeHook<InboundEmail>(matchedSignupId, emailForWorkflow);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { received: true, matched: true, signup_id: matchedSignupId, resume_error: msg };
      }
      return { received: true, matched: true, signup_id: matchedSignupId };
    }
    return { received: true, matched: true, signup_id: matchedSignupId, queued: true };
  }

  if (matchedUserId) {
    return { received: true, matched: true, user_id: matchedUserId };
  }

  return { received: true, matched: false };
}

/**
 * Shared SendGrid Inbound Parse handler.
 *
 * Body: multipart/form-data per
 *   https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/setting-up-the-inbound-parse-webhook
 * Auth: query-param shared secret (`?secret=...`). SendGrid does not sign the
 * request body, so this is the enforcement we have. `EMAIL_SENDGRID_SECRET`
 * must be set in production.
 */
async function handleSendgridInbound(c: import('hono').Context) {
  const expectedSecret = process.env.EMAIL_SENDGRID_SECRET;
  if (!expectedSecret) {
    return c.json({ error: 'server_misconfigured' }, 500);
  }
  const provided = c.req.query('secret') ?? '';
  if (provided !== expectedSecret) {
    return c.json({ error: 'invalid_secret' }, 401);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'invalid_payload' }, 400);
  }

  const envelopeRaw = typeof form.get('envelope') === 'string' ? (form.get('envelope') as string) : '';
  let envelopeTo = '';
  let envelopeFrom = '';
  if (envelopeRaw) {
    try {
      const env = JSON.parse(envelopeRaw) as { to?: string[] | string; from?: string };
      envelopeTo = Array.isArray(env.to) ? (env.to[0] ?? '') : (env.to ?? '');
      envelopeFrom = env.from ?? '';
    } catch {
      // leave empty
    }
  }

  const toHeader = typeof form.get('to') === 'string' ? (form.get('to') as string) : '';
  const fromHeader = typeof form.get('from') === 'string' ? (form.get('from') as string) : '';
  const subject = typeof form.get('subject') === 'string' ? (form.get('subject') as string) : '';
  const text = typeof form.get('text') === 'string' ? (form.get('text') as string) : '';
  const headersRaw = typeof form.get('headers') === 'string' ? (form.get('headers') as string) : '';

  const to = envelopeTo || toHeader;
  const from = envelopeFrom || fromHeader;

  if (!to || !from) {
    return c.json({ error: 'invalid_payload' }, 400);
  }

  const headers: Record<string, string> = {};
  if (headersRaw) {
    for (const line of headersRaw.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key) headers[key.toLowerCase()] = value;
      }
    }
  }

  const result = await processInboundEmail({
    to,
    from,
    subject,
    bodyText: text,
    headers,
  });

  return c.json(result);
}

/**
 * Primary inbound email webhook. SendGrid Inbound Parse posts here:
 *   POST /v1/webhooks/email?secret=$EMAIL_SENDGRID_SECRET
 *
 * See docs/inbound-email-setup.md for DNS + SendGrid configuration.
 */
app.post('/v1/webhooks/email', handleSendgridInbound);

/**
 * Backward-compatible alias that matches the SendGrid "Destination URL" some
 * existing configurations point at. Identical semantics.
 */
app.post('/v1/webhooks/email/sendgrid', handleSendgridInbound);

export default app;
