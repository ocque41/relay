/**
 * Tenant provider factory.
 *
 * Materializes a `Provider<Input, Account>` from a `tenant_providers` DB row.
 * Every provider method dispatches an HMAC-signed HTTP POST to the integrator's
 * webhook URL. The integrator's handler is the same for all operations —
 * it switches on `body.kind`:
 *
 *   { kind: "signup",          signupId, email, input, provider_slug }
 *   { kind: "create_api_key",  account_id, label }
 *   { kind: "revoke_api_key",  account_id, key_id }
 *   { kind: "teardown",        account_id }
 *
 * Signature:
 *   X-Relay-Signature: sha256=<hex-hmac-of-raw-body>
 *   X-Relay-Provider:  <slug>           (convenience — lets the integrator route)
 *
 * Response shapes:
 *   signup          → { accountId, apiKey, externalId? } or { accountId, credentials, externalId? }
 *   create_api_key  → { key, providerKeyId? }
 *   revoke_api_key  → { revoked: true }
 *   teardown        → { deleted: true }
 *
 * Email-verification (`needs_email_verification: true`) is declared in the DB
 * but not yet orchestrated by Relay — integrators must currently trust the
 * email field or perform their own verification server-side. A future phase
 * will add Relay-side confirmation via OTP before dispatching the webhook.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { type InferSelectModel } from 'drizzle-orm';
import { decrypt } from '../crypto';
import { db } from '../db/index';
import { signup_confirmations, type tenant_providers } from '../db/schema';
import { sendEmail } from '../auth/mailer';
import {
  billingMode,
  requireActiveTenantSubscription,
} from '../billing/charge';
import { hmacPostOrThrow } from './hmac';
import { recordOutcome, shouldBreak } from '../actions/breaker';
import {
  encodeProviderCredential,
  type ProviderCredential,
} from '../credentials/envelope';
import type {
  CreateApiKeyResult,
  InboundEmail,
  PendingSignup,
  Provider,
  SignupOutcome,
} from './types';

type TenantProviderRow = InferSelectModel<typeof tenant_providers>;

export interface TenantAccount {
  accountId: string;          // integrator's own account id for the user
  initialCredential?: ProviderCredential; // present only within a single signup workflow run
}

/** State we persist into `PendingSignup.providerState` while awaiting user confirmation. */
interface TenantPendingState {
  signupJobId: string;
  input: Record<string, unknown>;
  userEmail: string;
  displayName: string;
}

const CONFIRM_TTL_MS = 15 * 60 * 1000; // matches the workflow's 15-minute sleep window

function extractSignupJobId(emailAlias: string): string | null {
  // emailAlias format: "signup-<uuid>@<catchallDomain>"
  const m = emailAlias.match(/^signup-([0-9a-f-]{36})@/i);
  return m ? m[1] : null;
}

function appBaseUrl(): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  const prodHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prodHost) return `https://${prodHost.replace(/^https?:\/\//, '')}`;
  return 'http://localhost:3000';
}

async function sendConfirmationEmail(params: {
  userEmail: string;
  displayName: string;
  confirmUrl: string;
}): Promise<void> {
  await sendEmail({
    to: params.userEmail,
    subject: `Confirm signup for ${params.displayName}`,
    text:
      `An AI agent is signing you up for ${params.displayName}.\n\n` +
      `If you authorized this, click to confirm:\n${params.confirmUrl}\n\n` +
      `If you didn't request this, you can ignore this email. ` +
      `Relay will not create the account unless you click the link above.\n\n` +
      `This link expires in 15 minutes.`,
    html:
      `<p>An AI agent is signing you up for <strong>${params.displayName}</strong>.</p>` +
      `<p>If you authorized this, click to confirm:</p>` +
      `<p><a href="${params.confirmUrl}" style="background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Confirm signup</a></p>` +
      `<p style="color:#666;font-size:13px;">If you didn't request this, you can ignore this email. Relay will not create the account unless you click the link above.</p>` +
      `<p style="color:#666;font-size:13px;">This link expires in 15 minutes.</p>`,
  });
}

// ---------------------------------------------------------------------------
// Webhook dispatch (delegates to hmacPostOrThrow — legacy wrapper keeps the
// throw-on-failure semantics the WDK workflow depends on for retry routing).
// ---------------------------------------------------------------------------
interface DispatchArgs {
  url: string;
  secret: string;
  slug: string;
  payload: Record<string, unknown>;
}

async function dispatch(args: DispatchArgs): Promise<unknown> {
  const key = `tenant:${args.slug}`;
  if (shouldBreak(key)) {
    // Short-circuit while the breaker is open. Integrator is flapping; don't
    // hammer their webhook.
    throw new Error(
      `integrator_degraded — tenant ${args.slug} is temporarily paused after repeated webhook failures`,
    );
  }
  try {
    const result = await hmacPostOrThrow({
      url: args.url,
      secret: args.secret,
      body: args.payload,
      headers: { 'X-Relay-Provider': args.slug },
      label: key,
    });
    recordOutcome(key, true);
    return result;
  } catch (err) {
    recordOutcome(key, false);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function tenantProviderFromRow(row: TenantProviderRow): Provider<Record<string, unknown>, TenantAccount> {
  const slug = row.slug;
  const tenantId = row.tenant_id;
  const webhookUrl = row.signup_webhook_url;
  const teardownUrl = row.teardown_webhook_url ?? row.signup_webhook_url;
  const secret = decrypt(row.webhook_secret_enc).toString('utf8');
  const needsEmailVerification = row.needs_email_verification;
  const displayName = row.display_name;

  // Billing gate: every integrator webhook dispatch requires the tenant's
  // Relay subscription to be active. TenantInactive propagates; the workflow
  // body translates it into a terminal failSignupJob call and the route-side
  // chargeEventId refund path credits the user back. `BILLING_ENFORCEMENT=off`
  // short-circuits so mode=off is a true no-op.
  async function assertTenantActive(): Promise<void> {
    if (billingMode() === 'off') return;
    await requireActiveTenantSubscription(tenantId);
  }

  // We accept any JSON object as input — the integrator declares their own
  // shape via `input_schema`, which is surfaced through GET /v1/providers
  // but not strictly enforced here (would require building a Zod schema
  // from the JSON schema at runtime; deferred).
  const inputSchema = z.record(z.string(), z.unknown());

  async function dispatchSignup(
    email: string,
    input: unknown,
    signupJobId: string,
  ): Promise<{ accountId: string; credential: ProviderCredential; externalId: string }> {
    await assertTenantActive();
    const data = (await dispatch({
      url: webhookUrl,
      secret,
      slug,
      payload: {
        kind: 'signup',
        signupId: signupJobId,
        email,
        input,
        provider_slug: slug,
      },
    })) as {
      accountId?: unknown;
      apiKey?: unknown;
      credentials?: unknown;
      externalId?: unknown;
    };

    const credential =
      data.credentials &&
      typeof data.credentials === 'object' &&
      !Array.isArray(data.credentials)
        ? (data.credentials as Record<string, unknown>)
        : typeof data.apiKey === 'string'
          ? data.apiKey
          : null;

    if (typeof data.accountId !== 'string' || credential == null) {
      throw new Error(
        `[tenant:${slug}] signup response missing accountId or credentials/apiKey; got ${JSON.stringify(data).slice(0, 200)}`,
      );
    }
    const externalId =
      typeof data.externalId === 'string' ? data.externalId : data.accountId;
    return { accountId: data.accountId, credential, externalId };
  }

  return {
    id: slug,
    inputSchema,

    async signup(_ctx, input, emailAddress): Promise<SignupOutcome<TenantAccount>> {
      // ---- Path A: no verification required → direct dispatch to integrator
      if (!needsEmailVerification) {
        const signupJobId = extractSignupJobId(emailAddress);
        if (!signupJobId) {
          throw new Error(
            `[tenant:${slug}] emailAlias "${emailAddress}" did not contain a signup job id`,
          );
        }
        const { accountId, credential, externalId } = await dispatchSignup(
          emailAddress,
          input,
          signupJobId,
        );
        return {
          needsEmail: false,
          externalId,
          credentials: credential,
          account: { accountId, initialCredential: credential },
        };
      }

      // ---- Path B: user must click a confirmation email before we dispatch.
      // Pull the signupJobId out of the catch-all alias (format:
      // "signup-<uuid>@<domain>"), send an email to the *real* user address,
      // and return `{ needsEmail: true }` so the WDK workflow suspends.
      const signupJobId = extractSignupJobId(emailAddress);
      if (!signupJobId) {
        throw new Error(
          `[tenant:${slug}] emailAlias "${emailAddress}" did not contain a signup job id`,
        );
      }

      // The `emailAddress` passed to signup() is the *catch-all* alias, not the
      // user's real address. Tenant signups pass the real address through
      // `input.email` (the agent is expected to supply it). If missing,
      // reject — we can't confirm an identity we don't know.
      const userEmail = String((input as Record<string, unknown>)?.email ?? '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(userEmail)) {
        throw new Error(
          `[tenant:${slug}] needs_email_verification=true but input.email is missing or invalid`,
        );
      }

      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + CONFIRM_TTL_MS);

      await db.insert(signup_confirmations).values({
        signup_job_id: signupJobId,
        token,
        email: userEmail,
        tenant_provider_slug: slug,
        expires_at: expiresAt,
      });

      const confirmUrl = `${appBaseUrl()}/v1/signups/${signupJobId}/confirm/${token}`;
      await sendConfirmationEmail({ userEmail, displayName, confirmUrl });

      const pendingState: TenantPendingState = {
        signupJobId,
        input: input as Record<string, unknown>,
        userEmail,
        displayName,
      };
      const pending: PendingSignup = {
        id: signupJobId,
        providerState: pendingState,
      };
      return { needsEmail: true, pending };
    },

    async handleVerificationEmail(
      _ctx,
      _inbound: InboundEmail,
      pending: PendingSignup,
    ): Promise<SignupOutcome<TenantAccount>> {
      const state = pending.providerState as TenantPendingState;
      const { accountId, credential, externalId } = await dispatchSignup(
        state.userEmail,
        state.input,
        state.signupJobId,
      );
      return {
        needsEmail: false,
        externalId,
        credentials: credential,
        account: { accountId, initialCredential: credential },
      };
    },

    async createApiKey(_ctx, account, label): Promise<CreateApiKeyResult> {
      // The initial key is the one we already got from signup — avoid a second
      // round-trip. Only the fresh-signup workflow will have `initialCredential` set.
      if (label === 'initial' && account.initialCredential) {
        return { key: encodeProviderCredential(account.initialCredential) };
      }
      await assertTenantActive();
      const data = (await dispatch({
        url: webhookUrl,
        secret,
        slug,
        payload: {
          kind: 'create_api_key',
          account_id: account.accountId,
          label,
        },
      })) as { key?: unknown; providerKeyId?: unknown };

      if (typeof data.key !== 'string') {
        throw new Error(`[tenant:${slug}] create_api_key response missing 'key'`);
      }
      return {
        key: data.key,
        ...(typeof data.providerKeyId === 'string'
          ? { providerKeyId: data.providerKeyId }
          : {}),
      };
    },

    async revokeApiKey(_ctx, account, keyId): Promise<void> {
      await assertTenantActive();
      await dispatch({
        url: webhookUrl,
        secret,
        slug,
        payload: {
          kind: 'revoke_api_key',
          account_id: account.accountId,
          key_id: keyId,
        },
      });
    },

    async teardown(_ctx, account): Promise<void> {
      await assertTenantActive();
      await dispatch({
        url: teardownUrl,
        secret,
        slug,
        payload: {
          kind: 'teardown',
          account_id: account.accountId,
        },
      });
    },
  };
}

/**
 * Reconstruct a TenantAccount from a stored accounts row (for post-signup
 * operations like mint-another-key or delete).
 */
export function tenantAccountFromRow(accountRow: { external_id: string }): TenantAccount {
  return { accountId: accountRow.external_id };
}
