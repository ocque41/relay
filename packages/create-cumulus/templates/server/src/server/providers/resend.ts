import { z } from 'zod';
import type {
  Provider,
  ProviderCtx,
  SignupOutcome,
  CreateApiKeyResult,
  InboundEmail,
  PendingSignup,
} from './types';
import {
  extractVerificationLink,
  extractVerificationCode,
  parseEmailAlias,
} from '../email/parse';

const RESEND_API_BASE = 'https://api.resend.com';

// ---------------------------------------------------------------------------
// Schema & types
// ---------------------------------------------------------------------------

export const resendInputSchema = z.object({
  email: z
    .string()
    .email()
    .describe('Email address for the new account (typically the catch-all alias)'),
  name: z.string().min(1).describe('Display name for the account'),
});

export type ResendInput = z.infer<typeof resendInputSchema>;

export type ResendAccount = {
  userId: string;
  email: string;
};

/** Shape persisted into `PendingSignup.providerState` while we wait for email. */
type ResendPendingState = {
  email: string;
  name: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function resendFetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY environment variable is not set');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    // Resend rejects requests without a User-Agent with HTTP 403.
    'User-Agent': 'api-dispatch/1.0 (+https://github.com/)',
    ...((init?.headers as Record<string, string>) ?? {}),
  };

  const res = await fetch(`${RESEND_API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)');
    throw new Error(`Resend API ${res.status} on ${path}: ${body}`);
  }

  if (res.status === 204) return null;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * Resend provider — exercises the email-verified signup flow end-to-end.
 *
 * Resend does not expose a public API for creating net-new user accounts
 * (account creation is dashboard-only). To still demonstrate the full
 * `needsEmail: true` → `waitForEmail` → `handleVerificationEmail` loop, this
 * provider sends a real verification email through Resend's `POST /emails`
 * API to the catch-all alias. The catch-all webhook then resumes
 * the suspended workflow with the inbound email, and `handleVerificationEmail`
 * treats the verification link embedded in that email as proof of delivery.
 *
 * API key minting and revocation hit the real Resend API using the admin
 * `RESEND_API_KEY` token.
 *
 * Required env:
 *   RESEND_API_KEY          admin-level Resend API key (re_…)
 *   RESEND_FROM_ADDRESS     optional — from address, default onboarding@resend.dev
 *   APP_BASE_URL            optional — base URL used in the verification link,
 *                            default https://example.com
 */
export const resendProvider: Provider<ResendInput, ResendAccount> = {
  id: 'resend',
  visibility: 'demo',
  displayName: 'Resend',
  description: 'Operator self-service — mints a Resend API key INSIDE the Relay operator\'s own Resend account (auth: RESEND_API_KEY env) and exercises the email-verified signup loop. Not an end-user signup on Resend.',
  docsUrl: 'https://resend.com/docs',
  homepage: 'https://resend.com',
  npmPackage: 'resend',
  categories: ['email'],
  capabilities: [
    'transactional',
    'templates',
    'webhooks',
    'broadcast',
    'domains',
  ],
  pricingModel: 'free-tier',
  pricingUrl: 'https://resend.com/pricing',
  freeTierSummary: '3,000 emails per month and 100 emails per day on the Free plan.',
  envVar: 'RESEND_API_KEY',

  defaultInputForIntent({ catchallAlias, userEmail, workspaceSlug, alias, workspaceId }) {
    // Resend signup needs an email it can verify. Prefer the workspace's
    // catch-all alias (Relay reads the inbox automatically); fall back to
    // the user's own email; last resort is a deterministic alias on the
    // catchall domain.
    const catchallDomain = process.env.CATCHALL_DOMAIN ?? 'mail.example.com';
    const email =
      catchallAlias ??
      userEmail ??
      `relay-${workspaceId.slice(0, 8)}@${catchallDomain}`;
    const base = workspaceSlug ?? workspaceId.slice(0, 8);
    const tail = alias ?? 'primary';
    return {
      email,
      name: `${base}-${tail}`.slice(0, 60),
    };
  },

  inputSchema: resendInputSchema,

  /**
   * Kick off an email-verified signup.
   *
   * Sends a real verification email through Resend's `POST /emails` endpoint
   * to `emailAddress` (the catch-all alias of the form `signup-<id>@<domain>`).
   * Returns `needsEmail: true` so the workflow suspends until the email
   * webhook delivers the inbound message.
   */
  async signup(
    _ctx: ProviderCtx,
    input: ResendInput,
    emailAddress: string,
  ): Promise<SignupOutcome<ResendAccount>> {
    // Derive the pending-signup id from the catch-all alias so the WDK hook
    // token (`signupJobId`) lines up with the one the workflow created. This
    // keeps us aligned with the `resumeHook(signupId, ...)` path.
    const pendingId = parseEmailAlias(emailAddress) ?? crypto.randomUUID();

    const verifyBase = process.env.APP_BASE_URL ?? 'https://example.com';
    const verifyUrl = `${verifyBase}/verify?token=${pendingId}`;
    const fromAddress =
      process.env.RESEND_FROM_ADDRESS ?? 'onboarding@resend.dev';

    // Send the verification email using Resend's real sending API.
    // The verification URL deliberately contains the keyword `verify` so the
    // webhook's `extractVerificationLink` helper picks it up on arrival.
    //
    // Best-effort: a failure here (e.g. unverified-domain restrictions on
    // free-tier Resend accounts that block sends to arbitrary recipients)
    // must NOT abort the workflow. Local tests can simulate the inbound email
    // via the catch-all webhook script, so suspension on `needsEmail: true` is
    // the only thing that has to happen here.
    try {
      await resendFetch<{ id: string }>('/emails', {
        method: 'POST',
        body: JSON.stringify({
          from: fromAddress,
          to: [emailAddress],
          subject: `Verify your account — ${input.name}`,
          html: `<p>Hi ${input.name},</p>
<p>Please <a href="${verifyUrl}">verify your account</a> to continue.</p>`,
          text: `Hi ${input.name},\n\nVerify your account: ${verifyUrl}\n`,
        }),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[resend] verification email send failed (continuing as best-effort): ${msg}`,
      );
    }

    return {
      needsEmail: true,
      pending: {
        id: pendingId,
        providerState: {
          email: emailAddress,
          name: input.name,
        } satisfies ResendPendingState,
      },
    };
  },

  /**
   * Resume after the verification email has been delivered via the catch-all
   * webhook. We extract the verification link (or fall back to a numeric code)
   * to demonstrate the parsing path, then treat the successful delivery itself
   * as proof that the account is "verified" — Resend offers no signup endpoint
   * we could actually POST back to here.
   */
  async handleVerificationEmail(
    _ctx: ProviderCtx,
    email: InboundEmail,
    pending: PendingSignup,
  ): Promise<SignupOutcome<ResendAccount>> {
    const state = pending.providerState as ResendPendingState;

    const link = extractVerificationLink(email.bodyText);
    const code = link ? null : extractVerificationCode(email.bodyText);

    if (!link && !code) {
      throw new Error(
        `Resend provider: verification email contained no link or code (subject: ${email.subject})`,
      );
    }

    // In a provider that actually exposed a verify endpoint we would follow
    // `link` (or POST `code`) here to complete the server-side verification.
    // Since Resend doesn't, the arrival of the email at the catch-all IS the
    // verification proof — we record the link/code in credentials for audit.
    const userId = pending.id;

    const credentials = JSON.stringify({
      verified: true,
      verificationLink: link,
      verificationCode: code,
      verifiedAt: new Date().toISOString(),
    });

    return {
      needsEmail: false,
      account: { userId, email: state.email },
      externalId: userId,
      credentials,
    };
  },

  /**
   * Mint a real Resend API key via `POST /api-keys`.
   *
   * Resend enforces a 50-char limit on the `name` field, so we truncate
   * the generated label.
   */
  async createApiKey(
    _ctx: ProviderCtx,
    _account: ResendAccount,
    label: string,
  ): Promise<CreateApiKeyResult> {
    const keyName = `${label}-${Date.now()}`.slice(0, 50);

    const data = await resendFetch<{ id: string; token: string }>('/api-keys', {
      method: 'POST',
      body: JSON.stringify({
        name: keyName,
        permission: 'sending_access',
      }),
    });

    if (!data) {
      throw new Error('Resend API returned empty response for api-key creation');
    }

    return { key: data.token, providerKeyId: data.id };
  },

  /**
   * Revoke a Resend API key via `DELETE /api-keys/{id}`.
   */
  async revokeApiKey(
    _ctx: ProviderCtx,
    _account: ResendAccount,
    keyId: string,
  ): Promise<void> {
    await resendFetch(`/api-keys/${keyId}`, { method: 'DELETE' });
  },

  /**
   * No-op teardown.
   *
   * Resend has no public API for deleting user accounts — account lifecycle
   * is dashboard-only. We surface a warning so operators know they may need
   * to clean up manually via the Resend console.
   */
  async teardown(_ctx: ProviderCtx, account: ResendAccount): Promise<void> {
    console.warn(
      `[resend] teardown is a no-op for ${account.email}: Resend does not ` +
        'expose a public API to delete user accounts. Clean up via the ' +
        'Resend dashboard if required.',
    );
  },
};
