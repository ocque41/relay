import { createHook, sleep, FatalError } from 'workflow';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../src/server/db/index';
import { signup_jobs, accounts, api_keys } from '../src/server/db/schema';
import { getProvider } from '../src/server/providers/index';
import { encrypt } from '../src/server/crypto';
import {
  encodeProviderCredential,
  type ProviderCredential,
} from '../src/server/credentials/envelope';
import { credentialForAccountStorage } from '../src/server/credentials/storage';
import { TenantInactive } from '../src/server/billing/charge';
import { refundIntegratorQuota } from '../src/server/billing/quota';
import type { InboundEmail, SignupOutcome } from '../src/server/providers/types';

// ---------------------------------------------------------------------------
// Workflow input type
// ---------------------------------------------------------------------------
export interface SignupWorkflowParams {
  providerId: string;
  input: unknown;
  signupJobId: string;
  emailAlias: string;
  /**
   * End-user who owns the resulting account. Threaded through the workflow
   * so the accounts row can be attributed to a user without the workflow
   * having to re-derive it from audit_log.
   */
  userId: string | null;
  /** Tenant whose provider is running, or null for built-in providers. */
  tenantId: string | null;
  /**
   * Personal workspace this signup belongs to. Populated by the
   * calling REST / MCP route from the agent's pin (`agents.user_workspace_id`)
   * with a fallback to the user's currently-active workspace. Threaded
   * through so the resulting `accounts` row inherits it.
   */
  userWorkspaceId: string | null;
  /**
   * Optional alias for /v1/intent multi-resolution dedup.
   * NULL means "primary account for this (workspace, provider)". Threaded
   * to insertAccountRecord so the partial unique index can enforce dedup.
   */
  alias?: string | null;
}

// ---------------------------------------------------------------------------
// Step: Call the provider's signup() with automatic retry.
//
// Catches `TenantInactive` (thrown by the tenant-provider dispatch gate)
// and rethrows as `FatalError` so WDK short-circuits retries — subscription
// state rarely flips in the span of a retry loop. The workflow body catches
// the FatalError and calls failSignupJob.
// ---------------------------------------------------------------------------
async function doProviderSignup(params: {
  providerId: string;
  input: unknown;
  emailAlias: string;
}): Promise<SignupOutcome<unknown>> {
  'use step';

  const p = await getProvider(params.providerId);
  if (!p) throw new FatalError(`Provider "${params.providerId}" not found`);

  try {
    return await p.signup({ db }, params.input as never, params.emailAlias);
  } catch (err) {
    if (err instanceof TenantInactive) {
      throw new FatalError(
        `product unavailable — the integrator's Relay subscription is ${err.state}`,
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Step: Mark signup_jobs as awaiting_email
// ---------------------------------------------------------------------------
async function markAwaitingEmail(signupJobId: string): Promise<void> {
  'use step';

  await db
    .update(signup_jobs)
    .set({ status: 'awaiting_email', updated_at: new Date() })
    .where(eq(signup_jobs.id, signupJobId));
}

// ---------------------------------------------------------------------------
// Step: Handle the inbound verification email via the provider.
// ---------------------------------------------------------------------------
async function doHandleEmail(params: {
  providerId: string;
  email: InboundEmail;
  pending: unknown;
}): Promise<SignupOutcome<unknown>> {
  'use step';

  const p = await getProvider(params.providerId);
  if (!p) throw new FatalError(`Provider "${params.providerId}" not found`);
  if (!p.handleVerificationEmail) {
    throw new FatalError(`Provider "${params.providerId}" does not support email verification`);
  }

  try {
    return await p.handleVerificationEmail(
      { db },
      params.email,
      params.pending as never,
    );
  } catch (err) {
    if (err instanceof TenantInactive) {
      throw new FatalError(
        `product unavailable — the integrator's Relay subscription is ${err.state}`,
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Step: Insert the account record.
//
// On unique-index violation (`accounts_workspace_provider_alias_active`),
// recover by looking up the existing account with the same (workspace,
// provider, alias) tuple and returning its id with `dedup: true`. The
// workflow uses this to skip api-key minting (the existing account already
// has one) and complete its signup_job pointing to the dedup target. This
// is the catch-all for the race where two intent calls both passed the
// advisory lock + signup_jobs check before either workflow ran.
// ---------------------------------------------------------------------------
async function insertAccountRecord(params: {
  providerId: string;
  externalId: string;
  label: string;
  emailAlias: string;
  credentials: ProviderCredential | null;
  userId: string | null;
  tenantId: string | null;
  userWorkspaceId: string | null;
  alias: string | null;
}): Promise<{ accountId: string; dedup: boolean }> {
  'use step';

  const accountId = crypto.randomUUID();
  try {
    await db.insert(accounts).values({
      id: accountId,
      provider_id: params.providerId,
      external_id: params.externalId,
      label: params.label,
      email_alias: params.emailAlias,
      credentials_enc: params.credentials
        ? encrypt(encodeProviderCredential(params.credentials))
        : null,
      user_id: params.userId,
      tenant_id: params.tenantId,
      user_workspace_id: params.userWorkspaceId,
      alias: params.alias,
    });
    return { accountId, dedup: false };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code !== '23505') throw err;

    // Unique-violation on the partial index. Look up the existing row.
    const aliasFilter =
      params.alias === null
        ? isNull(accounts.alias)
        : eq(accounts.alias, params.alias);
    const workspaceFilter =
      params.userWorkspaceId === null
        ? isNull(accounts.user_workspace_id)
        : eq(accounts.user_workspace_id, params.userWorkspaceId);
    const [existing] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.provider_id, params.providerId),
          workspaceFilter,
          aliasFilter,
          sql`${accounts.status} != 'failed'`,
        ),
      )
      .limit(1);

    if (!existing) {
      // Index says a row exists but our SELECT can't find it — fail loudly
      // rather than silently inventing an account id.
      throw err;
    }
    return { accountId: existing.id, dedup: true };
  }
}

// ---------------------------------------------------------------------------
// Step: Mint the initial API key and stash it on signup_jobs for one-time
// delivery to the agent. A bookkeeping row lands in api_keys so the alias
// and provider_key_id survive (needed for future revocation), but we do
// NOT write the key bytes anywhere durable — the plaintext only exists in
// signup_jobs.pending_credentials_enc until the agent claims it.
// ---------------------------------------------------------------------------
async function mintAndStashInitialApiKey(params: {
  accountId: string;
  providerId: string;
  account: unknown;
  signupJobId: string;
}): Promise<void> {
  'use step';

  const p = await getProvider(params.providerId);
  if (!p) throw new FatalError(`Provider "${params.providerId}" not found`);

  const { key: rawKey, providerKeyId } = await p.createApiKey(
    { db },
    params.account as never,
    'initial',
  );

  await db.insert(api_keys).values({
    account_id: params.accountId,
    label: 'initial',
    // NOTE: key_enc intentionally omitted. Relay does not persist third-party
    // API keys. The bookkeeping row exists for alias + revoke.
    ...(providerKeyId != null ? { provider_key_id: providerKeyId } : {}),
  });

  await db
    .update(signup_jobs)
    .set({
      pending_credentials_enc: encrypt(rawKey),
      updated_at: new Date(),
    })
    .where(eq(signup_jobs.id, params.signupJobId));
}

// ---------------------------------------------------------------------------
// Step: Mark signup_jobs as complete
// ---------------------------------------------------------------------------
async function completeSignupJob(params: {
  signupJobId: string;
  accountId: string;
}): Promise<void> {
  'use step';

  await db
    .update(signup_jobs)
    .set({ status: 'complete', account_id: params.accountId, updated_at: new Date() })
    .where(eq(signup_jobs.id, params.signupJobId));
}

// ---------------------------------------------------------------------------
// Step: Mark signup_jobs as failed AND refund the integrator-quota slot
// that was claimed at dispatch time (if any). Refund is best-effort — a
// refund write failure must not mask the original terminal error.
//
// When `tenantId` is null the signup targeted a built-in provider and
// nothing was claimed, so the refund is a no-op.
// ---------------------------------------------------------------------------
async function failSignupJob(params: {
  signupJobId: string;
  error: string;
  tenantId?: string | null;
}): Promise<void> {
  'use step';

  await db
    .update(signup_jobs)
    .set({ status: 'failed', error: params.error, updated_at: new Date() })
    .where(eq(signup_jobs.id, params.signupJobId));

  if (params.tenantId) {
    try {
      await refundIntegratorQuota({
        tenantId: params.tenantId,
        signupJobId: params.signupJobId,
      });
    } catch (err) {
      console.error(
        `[signupWorkflow] quota refund failed for signupJob=${params.signupJobId}:`,
        err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Durable workflow
// ---------------------------------------------------------------------------
export async function signupWorkflow(params: SignupWorkflowParams): Promise<void> {
  'use workflow';

  const {
    providerId,
    input,
    signupJobId,
    emailAlias,
    userId,
    tenantId,
    userWorkspaceId,
    alias,
  } = params;

  try {
    // 1. Call provider.signup() — retries automatically on transient failure
    const outcome = await doProviderSignup({ providerId, input, emailAlias });

    let finalOutcome = outcome;

    // 2. If the provider needs email verification, suspend until the email arrives
    if (outcome.needsEmail) {
      await markAwaitingEmail(signupJobId);

      // createHook with the signupJobId as token so the email webhook can
      // call resumeHook(signupJobId, inboundEmail) to resume this workflow.
      const hook = createHook<InboundEmail>({ token: signupJobId });

      try {
        // Race the email hook against a 15-minute timeout.
        const result = await Promise.race<InboundEmail | undefined>([
          (hook as unknown as Promise<InboundEmail>),
          sleep('15m').then(() => undefined),
        ]);

        if (result === undefined) {
          await failSignupJob({ signupJobId, error: 'email_timeout', tenantId });
          return;
        }

        finalOutcome = await doHandleEmail({
          providerId,
          email: result,
          pending: (outcome as { needsEmail: true; pending: unknown }).pending,
        });
      } finally {
        hook.dispose();
      }
    }

    if (finalOutcome.needsEmail) {
      await failSignupJob({ signupJobId, error: 'email_not_received', tenantId });
      return;
    }

    // 3. Insert the account. Built-in demo providers can still keep encrypted
    //    connection material on the account because later operations may need
    //    it. Tenant providers do not need it after the one-time handoff, so
    //    their raw provider credentials only live in pending_credentials_enc.
    //    On dedup (concurrent intent race), insertAccountRecord returns the
    //    existing account id — we skip api-key minting (existing account
    //    already has one) and refund the integrator quota slot this
    //    workflow claimed at dispatch time.
    const label = (input as { name?: string }).name ?? providerId;

    const { accountId, dedup } = await insertAccountRecord({
      providerId,
      externalId: (finalOutcome as { externalId: string }).externalId,
      label,
      emailAlias,
      credentials: credentialForAccountStorage({
        tenantId,
        credential: (finalOutcome as { credentials?: ProviderCredential | null }).credentials,
      }),
      userId,
      tenantId,
      userWorkspaceId,
      alias: alias ?? null,
    });

    if (dedup) {
      if (tenantId) {
        try {
          await refundIntegratorQuota({ tenantId, signupJobId });
        } catch (err) {
          console.error(
            `[signupWorkflow] dedup quota refund failed for signupJob=${signupJobId}:`,
            err,
          );
        }
      }
      await completeSignupJob({ signupJobId, accountId });
      return;
    }

    // 4. Mint the initial API key and stash it for one-time retrieval by the
    //    calling agent (via GET /v1/signups/:id). We deliberately do NOT persist
    //    the key bytes — only an encrypted buffer that gets cleared on first read.
    await mintAndStashInitialApiKey({
      accountId,
      providerId,
      account: (finalOutcome as { account: unknown }).account,
      signupJobId,
    });

    // 5. Complete the signup job
    await completeSignupJob({ signupJobId, accountId });
  } catch (err) {
    // Any step that exhausts retries (or throws FatalError — e.g. the
    // TenantInactive translation in doProviderSignup) lands here.
    const msg = err instanceof Error ? err.message : String(err);
    await failSignupJob({ signupJobId, error: msg, tenantId });
    throw err;
  }
}
