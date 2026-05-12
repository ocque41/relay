/**
 * Reusable primitive that kicks off a durable signup workflow for a given
 * (provider, input, calling agent) tuple.
 *
 * Extracted from `routes/signups.ts` so both POST /v1/signups and the
 * intent route (POST /v1/intent) can spawn signups without duplicating the
 * abuse-limit + quota + audit chain. Callers pass an already-resolved agent
 * context (userId / userWorkspaceId / scopes) so the helper does no agent
 * fetch of its own.
 *
 * Returns a discriminated union — never throws for expected failure modes
 * (missing provider, exhausted quota, inactive subscription, etc.). Routes
 * translate `{ ok: false, status, body }` directly into a JSON response.
 */
import { eq } from 'drizzle-orm';
import { start } from 'workflow/api';
import { db } from '../db/index';
import { signup_jobs, tenant_providers } from '../db/schema';
import { getProvider } from '../providers/index';
import { recordAudit } from '../audit';
import {
  IntegratorQuotaExhausted,
  refundIntegratorQuota,
  requireIntegratorQuota,
} from '../billing/quota';
import { TenantInactive, requireActiveTenantSubscription } from '../billing/charge';
import {
  UserRateLimited,
  checkUserSignupLimit,
  decrementUserSignupLimit,
} from '../abuse/signup-limit';
import { signupWorkflow } from '../../../workflows/signup';

export interface KickSignupParams {
  provider: string;
  input: unknown;
  /** Resolved by the calling route from bearerAuth. */
  callingAgentId: string;
  agentScopes: readonly string[];
  userId: string | null;
  userWorkspaceId: string | null;
  /**
   * Optional /v1/intent dedup handle. NULL means "primary account for this
   * (workspace, provider)". Stamped on signup_jobs so the intent route can
   * detect in-flight provisions and avoid kicking duplicates.
   */
  alias?: string | null;
}

export type KickSignupResult =
  | { ok: true; signupJobId: string }
  | {
      ok: false;
      status: 400 | 404 | 429 | 502 | 503;
      body: Record<string, unknown> & { error: string };
    };

export async function kickSignup(params: KickSignupParams): Promise<KickSignupResult> {
  const provider = await getProvider(params.provider);
  if (!provider) {
    return {
      ok: false,
      status: 404,
      body: { error: `provider "${params.provider}" not found` },
    };
  }

  let validInput: unknown;
  try {
    validInput = provider.inputSchema.parse(params.input);
  } catch (err: unknown) {
    const ze = err as { message?: string };
    return {
      ok: false,
      status: 400,
      body: { error: `input validation failed: ${ze.message ?? 'invalid'}` },
    };
  }

  // Tenant resolution — built-in providers are tenantless and free.
  const [tenantProviderRow] = await db
    .select({ tenant_id: tenant_providers.tenant_id })
    .from(tenant_providers)
    .where(eq(tenant_providers.slug, params.provider))
    .limit(1);
  const tenantId = tenantProviderRow?.tenant_id ?? null;

  const signupJobId = crypto.randomUUID();
  const catchallDomain = process.env.CATCHALL_DOMAIN ?? 'mail.example.com';
  const emailAlias = `signup-${signupJobId}@${catchallDomain}`;

  // End-user abuse gate. Admin-scoped tokens bypass.
  if (params.userId && !params.agentScopes.includes('admin')) {
    try {
      await checkUserSignupLimit(params.userId);
    } catch (e) {
      if (e instanceof UserRateLimited) {
        return {
          ok: false,
          status: 429,
          body: {
            error: 'user_signup_limit_exceeded',
            limit: e.limit,
            current: e.current,
            period: e.periodYm,
          },
        };
      }
      throw e;
    }
  }

  // Integrator-quota gate.
  if (tenantId && !params.agentScopes.includes('admin')) {
    try {
      await requireActiveTenantSubscription(tenantId);
      await requireIntegratorQuota({ tenantId, signupJobId });
    } catch (e) {
      if (e instanceof TenantInactive) {
        return {
          ok: false,
          status: 503,
          body: {
            error: `product unavailable — the integrator's Relay subscription is ${e.state}`,
          },
        };
      }
      if (e instanceof IntegratorQuotaExhausted) {
        return {
          ok: false,
          status: 429,
          body: {
            error: `integrator ${e.tenantId} signup quota exhausted on plan ${e.plan}`,
          },
        };
      }
      throw e;
    }
  }

  await db.insert(signup_jobs).values({
    id: signupJobId,
    status: 'pending',
    user_id: params.userId,
    tenant_id: tenantId,
    user_workspace_id: params.userWorkspaceId,
    calling_agent_id: params.callingAgentId,
    provider_slug: params.provider,
    alias: params.alias ?? null,
  });

  let run;
  try {
    run = await start(signupWorkflow, [
      {
        providerId: params.provider,
        input: validInput,
        signupJobId,
        emailAlias,
        userId: params.userId,
        tenantId,
        userWorkspaceId: params.userWorkspaceId,
        alias: params.alias ?? null,
      },
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(signup_jobs)
      .set({ status: 'failed', error: msg, updated_at: new Date() })
      .where(eq(signup_jobs.id, signupJobId));
    if (tenantId) {
      try {
        await refundIntegratorQuota({ tenantId, signupJobId });
      } catch (refundErr) {
        console.error('[kickSignup] quota refund failed:', refundErr);
      }
    }
    if (params.userId) {
      try {
        await decrementUserSignupLimit(params.userId);
      } catch (decErr) {
        console.error('[kickSignup] abuse-counter decrement failed:', decErr);
      }
    }
    return {
      ok: false,
      status: 502,
      body: { error: `failed to start signup workflow: ${msg}` },
    };
  }

  await db
    .update(signup_jobs)
    .set({ workflow_run_id: run.runId, updated_at: new Date() })
    .where(eq(signup_jobs.id, signupJobId));

  await recordAudit(
    params.callingAgentId,
    'signup_create',
    signupJobId,
    { provider: params.provider, alias: params.alias ?? null },
    { user_id: params.userId, tenant_id: tenantId },
  );

  return { ok: true, signupJobId };
}
