/**
 * MCP server exposing the API's operations as tools for AI agents.
 *
 * Transport: Web-Standard Streamable HTTP, stateless mode — one MCP request
 * → one HTTP response, no session state. This works on Vercel Fluid Compute,
 * Cloudflare Workers, and any other Web-Fetch runtime.
 *
 * Auth: every tool takes an `agent_token` argument which is validated inline
 * (same SHA-256 + agents table lookup used by the REST `bearerAuth` middleware).
 * The HTTP request itself is unauthenticated — auth lives at the tool layer so
 * AI clients that don't know how to set HTTP headers can still authenticate.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { start, resumeHook } from 'workflow/api';

import { db } from '../server/db/index';
import {
  accounts,
  actions as actionsTable,
  agents,
  api_keys,
  audit_log,
  email_messages,
  magic_links,
  signup_jobs,
  tenant_providers,
  tenant_subscriptions,
  tenants,
  tenant_quota_state,
  plan_catalog,
  user_workspaces,
  users,
} from '../server/db/schema';
import { decrypt, hashToken } from '../server/crypto';
import {
  DEFAULT_AGENT_TOKEN_DAYS,
  mintAgentToken,
  type ExpiryPolicy,
} from '../server/auth/mint-token';
import { DEFAULT_AGENT_GUIDE } from '../server/auth/default-agent-guide';
import { getProvider, getProviderSummary, listProviders } from '../server/providers/index';
import {
  computeCategorySlice,
  computeIndexOverview,
} from '../server/routes/index-catalog';
import type { NeonAccount } from '../server/providers/neon';
import { generateOtp, verifyOtp } from '../server/auth/email-otp';
import { sendOtpEmail } from '../server/auth/mailer';
import { userCanAccessTenant } from '../server/auth/workspace';
import {
  extractVerificationCode,
  extractVerificationLink,
} from '../server/email/parse';
import { desc, gt } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { signupWorkflow } from '../../workflows/signup';
import { resolveIntent } from '../server/intent/resolve';
import {
  registerTenantProduct,
  RegisterTenantProductFailure,
} from '../server/dev/products';
import {
  TenantInactive,
  requireActiveTenantSubscription,
} from '../server/billing/charge';
import {
  BillingCheckoutFailure,
  CHECKOUT_PLANS,
  createBillingPortalSession,
  createCheckoutSession,
  isSubscriptionActive,
  getLatestSubscription,
  type BillingInterval,
  type PlanId,
} from '../server/billing/checkout';
import {
  CREDIT_PACK_IDS,
  PACK_DEFS,
  createCreditCheckoutSession,
  listCredits,
  type CreditPackId,
} from '../server/billing/credits';
import {
  IntegratorQuotaExhausted,
  refundIntegratorQuota,
  requireIntegratorQuota,
} from '../server/billing/quota';
import {
  UserRateLimited,
  checkUserSignupLimit,
  decrementUserSignupLimit,
} from '../server/abuse/signup-limit';
import {
  chargeAction,
  refundAction,
  type ChargeReceipt,
} from '../server/billing/charge-action';
import { checkKeyRevealLimit } from '../server/abuse/key-reveal-limit';
import { deliverSignupCredentialsOnce } from '../server/signups/handoff';

// ---------------------------------------------------------------------------
// Auth helper — same logic as src/server/auth.ts bearerAuth, but inline so we
// don't need Hono's middleware plumbing.
// ---------------------------------------------------------------------------
interface AuthenticatedAgent {
  agentId: string;
  scopes: string[];
}

async function authenticate(
  agentToken: string | undefined,
): Promise<AuthenticatedAgent> {
  if (!agentToken || typeof agentToken !== 'string') {
    throw new Error('unauthorized: missing agent_token');
  }
  const hash = hashToken(agentToken);
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.token_hash, hash), isNull(agents.revoked_at)))
    .limit(1);
  const agent = rows[0];
  if (!agent) {
    throw new Error('unauthorized: invalid agent_token');
  }
  if (agent.expires_at && agent.expires_at.getTime() <= Date.now()) {
    // Distinct error payload so MCP clients can detect expiry and prompt the
    // user to re-run register_tenant without treating this as a hard rejection.
    throw new Error('agent_token_expired');
  }
  return {
    agentId: agent.id,
    scopes: (agent.scopes as string[]) ?? [],
  };
}

// Convenience helper: return a tool result as structured JSON text.
function ok(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  };
}

function err(message: string) {
  return {
    isError: true,
    content: [
      { type: 'text' as const, text: JSON.stringify({ error: message }) },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers for MCP tools.
// ---------------------------------------------------------------------------
function appBaseUrlForBilling(): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  const prodHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prodHost) return `https://${prodHost.replace(/^https?:\/\//, '')}`;
  return 'http://localhost:3000';
}

// ---------------------------------------------------------------------------
// Build the McpServer
// ---------------------------------------------------------------------------
export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: 'agent-signup-api',
    version: '1.0.0',
  });

  // -------------------------------------------------------------------------
  // 1. list_providers
  // -------------------------------------------------------------------------
  server.registerTool(
    'list_providers',
    {
      description:
        'List every registered signup provider (e.g. neon, vercel, resend).',
      inputSchema: {
        agent_token: z
          .string()
          .describe('Bearer token identifying the calling agent.'),
      },
    },
    async ({ agent_token }) => {
      try {
        await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }
      const providers = await listProviders();
      return ok(
        providers.map((p) => ({
          id: p.id,
          kind: p.kind,
          displayName: p.displayName,
          description: p.description,
          docsUrl: p.docsUrl,
          homepage: p.homepage,
          npmPackage: p.npmPackage,
          categories: p.categories,
          pricingModel: p.pricingModel,
          pricingUrl: p.pricingUrl,
          freeTierSummary: p.freeTierSummary,
          capabilities: p.capabilities,
          inputSchema: p.inputSchema,
          ...(p.tenantId ? { tenantId: p.tenantId } : {}),
          ...(p.needsEmailVerification !== undefined
            ? { needsEmailVerification: p.needsEmailVerification }
            : {}),
        })),
      );
    },
  );

  // -------------------------------------------------------------------------
  // 1a1. list_categories — chunked discovery overview. No agent_token needed:
  //      the returned data is just canonical slugs + aliases + counts, same
  //      information that is publicly documented on /docs/agent-builders.
  //      Agents call this first, then narrow to list_providers_by_category.
  // -------------------------------------------------------------------------
  server.registerTool(
    'list_categories',
    {
      description:
        'Return the top-level provider index: which categories currently have at least one registered provider, with counts, provider ids, and the alias map agents can use for fuzzy category lookups.',
      inputSchema: {},
    },
    async () => {
      const overview = await computeIndexOverview();
      return ok(overview);
    },
  );

  // -------------------------------------------------------------------------
  // 1a2. list_providers_by_category — the per-category chunk. Requires an
  //      agent_token for parity with list_providers; returns full provider
  //      metadata so the agent can compare and pick without a second call.
  // -------------------------------------------------------------------------
  server.registerTool(
    'list_providers_by_category',
    {
      description:
        'Return every provider registered under a given category (e.g. "database", "hosting", "email"). Aliases like "hoster" → "hosting" are resolved server-side. Optional filters narrow the result without a second call.',
      inputSchema: {
        agent_token: z
          .string()
          .describe('Bearer token identifying the calling agent.'),
        category: z
          .string()
          .describe(
            'Canonical category slug or a known alias — see list_categories.',
          ),
        capability: z
          .array(z.string())
          .optional()
          .describe(
            'Require every listed capability (AND semantics). E.g. ["postgres","serverless"].',
          ),
        pricing: z
          .enum(['free', 'free-tier', 'paid', 'usage-based', 'freemium'])
          .optional()
          .describe('Restrict to providers with this pricing model.'),
      },
    },
    async ({ agent_token, category, capability, pricing }) => {
      try {
        await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }
      const result = await computeCategorySlice(category, {
        capability: capability ?? [],
        pricing,
      });
      if (result.kind === 'unknown') {
        return err(
          `unknown_category: "${category}" is neither canonical nor a known alias`,
        );
      }
      return ok(result.slice);
    },
  );

  // -------------------------------------------------------------------------
  // 1b. get_provider — full metadata + input schema for a single provider
  // -------------------------------------------------------------------------
  server.registerTool(
    'get_provider',
    {
      description:
        'Get full metadata + JSON Schema input for a single provider by id. Returns the same shape as list_providers but for one entry.',
      inputSchema: {
        agent_token: z
          .string()
          .describe('Bearer token identifying the calling agent.'),
        id: z
          .string()
          .describe('Provider id (built-in slug or tenant_providers.slug).'),
      },
    },
    async ({ agent_token, id }) => {
      try {
        await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }
      const p = await getProviderSummary(id);
      if (!p) {
        return err(`no provider registered with id "${id}"`);
      }
      return ok({
        id: p.id,
        kind: p.kind,
        displayName: p.displayName,
        description: p.description,
        docsUrl: p.docsUrl,
        homepage: p.homepage,
        npmPackage: p.npmPackage,
        categories: p.categories,
        pricingModel: p.pricingModel,
        pricingUrl: p.pricingUrl,
        freeTierSummary: p.freeTierSummary,
        capabilities: p.capabilities,
        inputSchema: p.inputSchema,
        ...(p.tenantId ? { tenantId: p.tenantId } : {}),
        ...(p.needsEmailVerification !== undefined
          ? { needsEmailVerification: p.needsEmailVerification }
          : {}),
      });
    },
  );

  // -------------------------------------------------------------------------
  // 2. create_signup
  // -------------------------------------------------------------------------
  server.registerTool(
    'create_signup',
    {
      description:
        'Provision a new account on the given provider. Starts a durable workflow and returns a signup_id that can be polled via get_signup_status.',
      inputSchema: {
        agent_token: z.string(),
        provider: z
          .string()
          .describe('Provider id, e.g. "neon", "vercel", "resend".'),
        input: z
          .record(z.string(), z.unknown())
          .describe('Provider-specific input object.'),
      },
    },
    async ({ agent_token, provider, input }) => {
      let authed: AuthenticatedAgent;
      try {
        authed = await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }

      const p = await getProvider(provider);
      if (!p) return err(`provider "${provider}" not found`);

      let validInput: unknown;
      try {
        validInput = p.inputSchema.parse(input);
      } catch (ze) {
        const msg = ze instanceof Error ? ze.message : String(ze);
        return err(`input validation failed: ${msg}`);
      }

      // Ownership resolution — same logic as POST /v1/signups.
      const [agentRow] = await db
        .select({
          user_id: agents.user_id,
          user_workspace_id: agents.user_workspace_id,
        })
        .from(agents)
        .where(eq(agents.id, authed.agentId))
        .limit(1);
      const userId = agentRow?.user_id ?? null;
      let userWorkspaceId: string | null = agentRow?.user_workspace_id ?? null;
      if (userId && !userWorkspaceId) {
        const { resolveActiveUserWorkspace } = await import(
          '../server/user-workspaces'
        );
        userWorkspaceId = (await resolveActiveUserWorkspace(userId)).id;
      }
      const [tenantProviderRow] = await db
        .select({ tenant_id: tenant_providers.tenant_id })
        .from(tenant_providers)
        .where(eq(tenant_providers.slug, provider))
        .limit(1);
      const tenantId = tenantProviderRow?.tenant_id ?? null;

      const signupJobId = crypto.randomUUID();
      const catchallDomain = process.env.CATCHALL_DOMAIN ?? 'mail.example.com';
      const alias = `signup-${signupJobId}@${catchallDomain}`;

      // End-user abuse gate: per-month signup cap. Admin-scoped bypass.
      if (userId && !authed.scopes.includes('admin')) {
        try {
          await checkUserSignupLimit(userId);
        } catch (limitErr) {
          if (limitErr instanceof UserRateLimited) {
            return err(
              `user_signup_limit_exceeded: ${limitErr.current}/${limitErr.limit} in ${limitErr.periodYm}`,
            );
          }
          throw limitErr;
        }
      }

      // Integrator-quota gate (mirror POST /v1/signups). Admin-scoped tokens
      // bypass. Built-in providers have no tenant and pass through.
      if (tenantId && !authed.scopes.includes('admin')) {
        try {
          await requireActiveTenantSubscription(tenantId);
          await requireIntegratorQuota({ tenantId, signupJobId });
        } catch (gateErr) {
          if (gateErr instanceof TenantInactive) {
            return err(
              `product unavailable — the integrator's Relay subscription is ${gateErr.state}`,
            );
          }
          if (gateErr instanceof IntegratorQuotaExhausted) {
            return err(
              `integrator ${gateErr.tenantId} signup quota exhausted on plan ${gateErr.plan}`,
            );
          }
          throw gateErr;
        }
      }

      await db
        .insert(signup_jobs)
        .values({
          id: signupJobId,
          status: 'pending',
          user_id: userId,
          tenant_id: tenantId,
          user_workspace_id: userWorkspaceId,
          calling_agent_id: authed.agentId,
          provider_slug: provider,
        });

      let run;
      try {
        run = await start(signupWorkflow, [
          {
            providerId: provider,
            input: validInput,
            signupJobId,
            emailAlias: alias,
            userId,
            tenantId,
            userWorkspaceId,
          },
        ]);
      } catch (workflowErr) {
        const msg =
          workflowErr instanceof Error ? workflowErr.message : String(workflowErr);
        await db
          .update(signup_jobs)
          .set({ status: 'failed', error: msg, updated_at: new Date() })
          .where(eq(signup_jobs.id, signupJobId));
        if (tenantId) {
          try {
            await refundIntegratorQuota({ tenantId, signupJobId });
          } catch (refundErr) {
            console.error('[mcp.create_signup] quota refund failed:', refundErr);
          }
        }
        if (userId) {
          try {
            await decrementUserSignupLimit(userId);
          } catch (decErr) {
            console.error('[mcp.create_signup] abuse-counter decrement failed:', decErr);
          }
        }
        return err(`failed to start workflow: ${msg}`);
      }

      await db
        .update(signup_jobs)
        .set({ workflow_run_id: run.runId, updated_at: new Date() })
        .where(eq(signup_jobs.id, signupJobId));

      await db.insert(audit_log).values({
        agent_id: authed.agentId,
        action: 'signup_create',
        target: signupJobId,
        metadata: { provider, via: 'mcp' },
        user_id: userId,
        tenant_id: tenantId,
      });

      return ok({ signup_id: signupJobId, status: 'pending' });
    },
  );

  // -------------------------------------------------------------------------
  // 3. get_signup_status
  // -------------------------------------------------------------------------
  server.registerTool(
    'get_signup_status',
    {
      description:
        'Poll the status of a signup job. Returns { signup_id, status, error?, account_id? }.',
      inputSchema: {
        agent_token: z.string(),
        signup_id: z.string(),
      },
    },
    async ({ agent_token, signup_id }) => {
      let authed: AuthenticatedAgent;
      try {
        authed = await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }

      const [job] = await db
        .select()
        .from(signup_jobs)
        .where(eq(signup_jobs.id, signup_id))
        .limit(1);

      if (!job) return err('signup job not found');

      // Authorization: only the owning user's agents may observe a signup.
      const [agentRow] = await db
        .select({ user_id: agents.user_id })
        .from(agents)
        .where(eq(agents.id, authed.agentId))
        .limit(1);
      const callerUserId = agentRow?.user_id ?? null;
      if (job.user_id && callerUserId !== job.user_id) {
        return err('signup job not found');
      }

      // Deliver-once: same policy as the REST endpoint.
      let initialApiKey: string | undefined;
      let initialCredentials: Record<string, unknown> | undefined;
      if (
        job.status === 'complete' &&
        job.pending_credentials_enc &&
        !job.credentials_delivered_at &&
        callerUserId === job.user_id
      ) {
        try {
          const delivered = await deliverSignupCredentialsOnce({
            job,
            callingAgentId: authed.agentId,
            callerUserId,
            via: 'mcp',
          });
          initialApiKey = delivered.initialApiKey;
          initialCredentials = delivered.initialCredentials;
        } catch (e) {
          console.error('[mcp.get_signup_status] deliver failed:', e);
        }
      }

      return ok({
        signup_id: job.id,
        status: job.status,
        ...(job.error != null ? { error: job.error } : {}),
        ...(job.account_id != null ? { account_id: job.account_id } : {}),
        ...(initialApiKey !== undefined ? { initial_api_key: initialApiKey } : {}),
        ...(initialCredentials !== undefined ? { initial_credentials: initialCredentials } : {}),
      });
    },
  );

  // -------------------------------------------------------------------------
  // 4. list_accounts — scoped to the calling user. Previously returned every
  // account in the database to any authenticated agent; now filters by the
  // user_id that owns the calling agent, so one user's agents cannot observe
  // another user's accounts.
  // -------------------------------------------------------------------------
  server.registerTool(
    'list_accounts',
    {
      description:
        "List the calling user's accounts (credentials are never returned). Scoped to accounts provisioned on the authenticated user's behalf.",
      inputSchema: {
        agent_token: z.string(),
      },
    },
    async ({ agent_token }) => {
      let authed: AuthenticatedAgent;
      try {
        authed = await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }

      const [agentRow] = await db
        .select({
          user_id: agents.user_id,
          user_workspace_id: agents.user_workspace_id,
        })
        .from(agents)
        .where(eq(agents.id, authed.agentId))
        .limit(1);
      const callerUserId = agentRow?.user_id ?? null;
      if (!callerUserId) {
        return err('agent_token is not associated with a user');
      }
      let wsId = agentRow?.user_workspace_id ?? null;
      if (!wsId) {
        const { resolveActiveUserWorkspace } = await import(
          '../server/user-workspaces'
        );
        wsId = (await resolveActiveUserWorkspace(callerUserId)).id;
      }

      const rows = await db
        .select({
          id: accounts.id,
          provider_id: accounts.provider_id,
          external_id: accounts.external_id,
          label: accounts.label,
          email_alias: accounts.email_alias,
          status: accounts.status,
          created_at: accounts.created_at,
        })
        .from(accounts)
        .where(
          and(
            eq(accounts.user_id, callerUserId),
            eq(accounts.user_workspace_id, wsId),
          ),
        );

      return ok(rows);
    },
  );

  // -------------------------------------------------------------------------
  // 5. get_api_key  (mint a new key for an account)
  //
  // Security model: Relay does NOT persist third-party API keys. The plaintext
  // is returned to the calling agent EXACTLY ONCE in this response; the agent
  // hands it to the user in their own conversation. We store only the label,
  // created_at, and provider_key_id (for future revocation) — never `key_enc`.
  // -------------------------------------------------------------------------
  server.registerTool(
    'get_api_key',
    {
      description:
        'Mint a new API key on the provider and return its plaintext EXACTLY ONCE. Relay does not persist the key bytes; only a bookkeeping row (label + provider_key_id) is kept so the key can be revoked later. The calling agent must hand the plaintext to the user in-chat and forget it.',
      inputSchema: {
        agent_token: z.string(),
        account_id: z.string(),
        label: z.string().optional(),
      },
    },
    async ({ agent_token, account_id, label }) => {
      let authed: AuthenticatedAgent;
      try {
        authed = await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }

      const [account] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.id, account_id))
        .limit(1);

      if (!account) return err('account not found');

      // Authorization: account must belong to the calling agent's user and
      // to the workspace the agent is pinned to.
      const [agentRow] = await db
        .select({
          user_id: agents.user_id,
          user_workspace_id: agents.user_workspace_id,
        })
        .from(agents)
        .where(eq(agents.id, authed.agentId))
        .limit(1);
      const callerUserId = agentRow?.user_id ?? null;
      if (account.user_id && callerUserId !== account.user_id) {
        return err('account not found');
      }
      if (callerUserId && account.user_workspace_id) {
        let wsId = agentRow?.user_workspace_id ?? null;
        if (!wsId) {
          const { resolveActiveUserWorkspace } = await import(
            '../server/user-workspaces'
          );
          wsId = (await resolveActiveUserWorkspace(callerUserId)).id;
        }
        if (account.user_workspace_id !== wsId) {
          return err('account not found');
        }
      }

      const provider = await getProvider(account.provider_id);
      if (!provider) {
        return err(`provider "${account.provider_id}" not registered`);
      }

      const resolvedLabel = label ?? `key-${Date.now()}`;

      // Charge the action against the integrator quota (BILLING_METER=actions)
      // and the per-user-month action cap. Refunded if the provider call fails.
      let receipt: ChargeReceipt;
      try {
        receipt = await chargeAction({
          tenantId: account.tenant_id,
          userId: callerUserId!,
          providerId: account.provider_id,
          action: 'mint',
        });
      } catch (e) {
        return err((e as Error).message);
      }

      // Union-shaped object so both built-in (Neon-like) and tenant providers
      // find the fields they need.
      const providerAccount: NeonAccount & { accountId: string } = {
        projectId: account.external_id,
        accountId: account.external_id,
        name: account.label,
        connectionUri: '',
      };
      if (account.credentials_enc) {
        try {
          providerAccount.connectionUri = decrypt(
            account.credentials_enc,
          ).toString('utf8');
        } catch {
          /* ignore — createApiKey may not need it */
        }
      }

      let minted: Awaited<ReturnType<typeof provider.createApiKey>>;
      let newKey: {
        id: string;
        account_id: string;
        label: string;
        created_at: Date | string | null;
      };
      try {
        minted = await provider.createApiKey(
          { db },
          providerAccount as never,
          resolvedLabel,
        );

        [newKey] = await db
          .insert(api_keys)
          .values({
            account_id,
            label: resolvedLabel,
            // key_enc intentionally omitted — zero-retention policy.
            ...(minted.providerKeyId != null
              ? { provider_key_id: minted.providerKeyId }
              : {}),
          })
          .returning({
            id: api_keys.id,
            account_id: api_keys.account_id,
            label: api_keys.label,
            created_at: api_keys.created_at,
          });
      } catch (e) {
        await refundAction({
          tenantId: account.tenant_id,
          userId: callerUserId!,
          receipt,
        });
        return err((e as Error).message);
      }

      await db.insert(audit_log).values({
        agent_id: authed.agentId,
        action: 'key_create',
        target: newKey.id,
        metadata: { account_id, label: resolvedLabel, via: 'mcp' },
        user_id: account.user_id,
        tenant_id: account.tenant_id,
      });

      // Plaintext key returned ONCE — Relay does not retain it.
      return ok({
        id: newKey.id,
        account_id: newKey.account_id,
        label: newKey.label,
        key: minted.key,
        created_at: newKey.created_at,
        note: 'Relay does not store this key. Hand it to the user in-chat and forget it. To rotate, call get_api_key again to mint a new one.',
      });
    },
  );

  // -------------------------------------------------------------------------
  // 6. reveal_api_key — deprecated under the zero-retention policy.
  //
  // Relay no longer stores third-party API key bytes. Legacy rows created
  // before the policy change may still have a key_enc column; those are
  // decrypted once and then scrubbed. New rows cannot be revealed — rotate
  // by calling get_api_key instead.
  // -------------------------------------------------------------------------
  server.registerTool(
    'reveal_api_key',
    {
      description:
        'Legacy: reveal a pre-policy-change stored key once, then scrub it from the database. New keys minted under the zero-retention policy cannot be revealed — call get_api_key to mint a fresh one instead.',
      inputSchema: {
        agent_token: z.string(),
        account_id: z.string(),
        key_id: z.string(),
      },
    },
    async ({ agent_token, account_id, key_id }) => {
      let authed: AuthenticatedAgent;
      try {
        authed = await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }

      const [account] = await db
        .select({
          user_id: accounts.user_id,
          tenant_id: accounts.tenant_id,
          user_workspace_id: accounts.user_workspace_id,
          provider_id: accounts.provider_id,
        })
        .from(accounts)
        .where(eq(accounts.id, account_id))
        .limit(1);
      if (!account) return err('account not found');

      const [agentRow] = await db
        .select({
          user_id: agents.user_id,
          user_workspace_id: agents.user_workspace_id,
        })
        .from(agents)
        .where(eq(agents.id, authed.agentId))
        .limit(1);
      const callerUserId = agentRow?.user_id ?? null;
      if (account.user_id && callerUserId !== account.user_id) {
        return err('account not found');
      }
      if (callerUserId && account.user_workspace_id) {
        let wsId = agentRow?.user_workspace_id ?? null;
        if (!wsId) {
          const { resolveActiveUserWorkspace } = await import(
            '../server/user-workspaces'
          );
          wsId = (await resolveActiveUserWorkspace(callerUserId)).id;
        }
        if (account.user_workspace_id !== wsId) {
          return err('account not found');
        }
      }

      const [row] = await db
        .select()
        .from(api_keys)
        .where(
          and(
            eq(api_keys.id, key_id),
            eq(api_keys.account_id, account_id),
            isNull(api_keys.revoked_at),
          ),
        )
        .limit(1);

      if (!row) return err('api key not found');
      if (!row.key_enc) {
        return err(
          'key bytes are not stored — Relay does not retain API keys. Call get_api_key to mint a new one.',
        );
      }

      // Per-key per-day reveal cap.
      try {
        checkKeyRevealLimit(callerUserId!, key_id);
      } catch (e) {
        return err((e as Error).message);
      }

      // Charge the reveal action. Refunded if decryption fails.
      let receipt: ChargeReceipt;
      try {
        receipt = await chargeAction({
          tenantId: account.tenant_id,
          userId: callerUserId!,
          providerId: account.provider_id,
          action: 'reveal',
        });
      } catch (e) {
        return err((e as Error).message);
      }

      let plaintext: string;
      try {
        plaintext = decrypt(row.key_enc).toString('utf8');
      } catch (e) {
        await refundAction({
          tenantId: account.tenant_id,
          userId: callerUserId!,
          receipt,
        });
        return err(
          `decryption failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const now = new Date();

      // Scrub after revealing so the key is never returned twice.
      await db
        .update(api_keys)
        .set({ last_revealed_at: now, key_enc: null })
        .where(eq(api_keys.id, key_id));

      await db.insert(audit_log).values({
        agent_id: authed.agentId,
        action: 'key_reveal',
        target: key_id,
        metadata: { account_id, legacy: true },
        user_id: account.user_id,
        tenant_id: account.tenant_id,
      });

      return ok({
        id: row.id,
        label: row.label,
        key: plaintext,
        revealed_at: now.toISOString(),
        note: 'Legacy reveal. The key bytes have now been scrubbed from the database; future reveals will fail.',
      });
    },
  );

  // -------------------------------------------------------------------------
  // 7. delete_account
  // -------------------------------------------------------------------------
  server.registerTool(
    'delete_account',
    {
      description:
        'Permanently delete an account. Calls the provider teardown (if available), removes child rows, and writes an audit_log entry.',
      inputSchema: {
        agent_token: z.string(),
        account_id: z.string(),
      },
    },
    async ({ agent_token, account_id }) => {
      let authed: AuthenticatedAgent;
      try {
        authed = await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }

      const [account] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.id, account_id))
        .limit(1);

      if (!account) return err('account not found');

      // Authorization: only the owning user's agents may delete — and the
      // workspace pin must match the account's workspace.
      const [agentRow] = await db
        .select({
          user_id: agents.user_id,
          user_workspace_id: agents.user_workspace_id,
        })
        .from(agents)
        .where(eq(agents.id, authed.agentId))
        .limit(1);
      const callerUserId = agentRow?.user_id ?? null;
      if (account.user_id && callerUserId !== account.user_id) {
        return err('account not found');
      }
      if (callerUserId && account.user_workspace_id) {
        let wsId = agentRow?.user_workspace_id ?? null;
        if (!wsId) {
          const { resolveActiveUserWorkspace } = await import(
            '../server/user-workspaces'
          );
          wsId = (await resolveActiveUserWorkspace(callerUserId)).id;
        }
        if (account.user_workspace_id !== wsId) {
          return err('account not found');
        }
      }

      // Charge the delete action. Refunded if the cleanup throws below.
      let receipt: ChargeReceipt;
      try {
        receipt = await chargeAction({
          tenantId: account.tenant_id,
          userId: callerUserId!,
          providerId: account.provider_id,
          action: 'delete',
        });
      } catch (e) {
        return err((e as Error).message);
      }

      try {
        const provider = await getProvider(account.provider_id);
        if (provider?.teardown) {
          try {
            const providerAccount = {
              projectId: account.external_id,
              accountId: account.external_id,
              name: account.label,
              connectionUri: '',
            };
            await provider.teardown({ db }, providerAccount as never);
          } catch (e) {
            // Log but don't block: local record must be removed even if remote fails.
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[mcp.delete_account] teardown failed: ${msg}`);
          }
        }

        // FK cleanup.
        await db.delete(api_keys).where(eq(api_keys.account_id, account_id));
        await db
          .update(signup_jobs)
          .set({ account_id: null })
          .where(eq(signup_jobs.account_id, account_id));
        await db.delete(accounts).where(eq(accounts.id, account_id));
      } catch (e) {
        await refundAction({
          tenantId: account.tenant_id,
          userId: callerUserId!,
          receipt,
        });
        throw e;
      }

      await db.insert(audit_log).values({
        agent_id: authed.agentId,
        action: 'account_delete',
        target: account_id,
        metadata: { provider_id: account.provider_id },
        user_id: account.user_id,
        tenant_id: account.tenant_id,
      });

      return ok({ deleted: true, id: account_id });
    },
  );

  // -------------------------------------------------------------------------
  // 8. register_tenant — public (no agent_token).
  //    First half of the dogfood flow: an agent starts the signup for a new
  //    Relay user + tenant by triggering an OTP email. The user pastes the
  //    code back to the agent, which calls submit_verification_code.
  // -------------------------------------------------------------------------
  server.registerTool(
    'register_tenant',
    {
      description:
        'Start signing a brand-new user up for Relay and creating their first tenant. Sends a 6-digit OTP to the given email address. Pair with submit_verification_code.',
      inputSchema: {
        email: z.string().email().describe('Email address of the Relay user being signed up.'),
      },
    },
    async ({ email }) => {
      try {
        const { code } = await generateOtp(email, 'signup');
        await sendOtpEmail(email, code);
        return ok({
          status: 'otp_sent',
          email,
          next_step:
            'User will receive a 6-digit code by email. Call submit_verification_code({ email, code, tenant_name }) to complete signup.',
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if ((e as { kind?: string })?.kind === 'rate_limit') {
          return err('too many OTPs for this email; wait a few minutes and retry');
        }
        return err(`failed to send OTP: ${msg}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 9. submit_verification_code — public (no agent_token).
  //    Completes the dogfood flow: verifies the OTP, upserts the user,
  //    creates a tenant, mints an agent token for the user, returns plaintext.
  // -------------------------------------------------------------------------
  server.registerTool(
    'submit_verification_code',
    {
      description:
        'Complete Relay signup: verify the 6-digit code, create (or reuse) the user, create a new tenant with the given name, and return a freshly minted agent_token the caller can use on future /v1/* calls. Tokens expire after 30 days by default; pass `never_expires: true` ONLY when the human user has explicitly asked for a non-rotating token.',
      inputSchema: {
        email: z.string().email(),
        code: z.string().regex(/^\d{6}$/).describe('6-digit code from the email.'),
        tenant_name: z
          .string()
          .min(1)
          .max(120)
          .describe("Human-readable name for the user's first tenant (e.g. 'ExampleApp')."),
        expires_in_days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe(
            `How many days the new token remains valid. Defaults to ${DEFAULT_AGENT_TOKEN_DAYS}. Ignored when never_expires=true.`,
          ),
        never_expires: z
          .boolean()
          .optional()
          .describe(
            'Set to true to mint a non-expiring token. Only request this when the human user has explicitly asked for a forever token; otherwise a 30-day token is the secure default.',
          ),
      },
    },
    async ({ email, code, tenant_name, expires_in_days, never_expires }) => {
      const result = await verifyOtp(email, code);
      if (!result.ok) return err(`verification failed: ${result.reason}`);

      // Integrator-only revenue: new users get no token grant.
      void result.created;

      // Seed the default agent guide for freshly-created users who don't have
      // one yet. Existing users with a custom guide are left alone.
      if (result.created) {
        await db
          .update(users)
          .set({
            agent_guide: DEFAULT_AGENT_GUIDE,
            agent_guide_updated_at: new Date(),
          })
          .where(and(eq(users.id, result.userId), isNull(users.agent_guide)));
      }

      // Derive a slug from the tenant name; avoid collisions with a short suffix.
      const baseSlug =
        tenant_name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '')
          .slice(0, 40) || 'tenant';
      let slug = baseSlug;
      const clash = await db
        .select({ slug: tenants.slug })
        .from(tenants)
        .where(eq(tenants.slug, baseSlug))
        .limit(1);
      if (clash[0]) slug = `${baseSlug}-${randomBytes(2).toString('hex')}`;

      const [tenant] = await db
        .insert(tenants)
        .values({ owner_user_id: result.userId, name: tenant_name, slug })
        .returning({ id: tenants.id, slug: tenants.slug, name: tenants.name });

      // Mint an agent token with the requested expiry policy.
      const expiry: ExpiryPolicy = never_expires
        ? 'never'
        : { days: expires_in_days ?? DEFAULT_AGENT_TOKEN_DAYS };
      const minted = await mintAgentToken({
        userId: result.userId,
        scopes: ['*'],
        label: `cli-${new Date().toISOString().slice(0, 10)}`,
        expiry,
        userRequestedNever: never_expires === true,
      });

      await db.insert(audit_log).values({
        agent_id: minted.agentId,
        action: 'signup_create',
        target: tenant.id,
        metadata: {
          via: 'mcp.submit_verification_code',
          user_created: result.created,
          expires_at: minted.expiresAt ? minted.expiresAt.toISOString() : null,
        },
      });

      return ok({
        user_id: result.userId,
        user_email: result.email,
        user_created: result.created,
        tenant: tenant,
        agent_token: minted.token,
        agent_token_id: minted.agentId,
        agent_token_expires_at: minted.expiresAt
          ? minted.expiresAt.toISOString()
          : null,
        note: minted.expiresAt
          ? `agent_token is shown once. Save it before moving on. Expires ${minted.expiresAt.toISOString().slice(0, 10)}.`
          : 'agent_token is shown once and NEVER EXPIRES. Save it immediately.',
      });
    },
  );

  // -------------------------------------------------------------------------
  // 9b. register_tenant_product — bearer auth
  //     Closes the bootstrap gap: agents can mint a tenant product (and its
  //     plaintext webhook_secret) without the human clicking through
  //     /dev/products. The webhook_secret is shown exactly once.
  // -------------------------------------------------------------------------
  server.registerTool(
    'register_tenant_product',
    {
      description:
        "Register a new product on the caller's tenant and return a plaintext webhook_secret exactly once. Use immediately after `submit_verification_code` (or `whoami`) to complete the agent-bootstrap loop — the secret must be saved to the integrator's .env.local as RELAY_WEBHOOK_SECRET.",
      inputSchema: {
        agent_token: z.string().describe('Bearer token identifying the calling agent.'),
        tenant_id: z
          .string()
          .uuid()
          .describe('Target tenant. Agent must own or be a member of this tenant.'),
        slug: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .min(2)
          .max(60)
          .describe('Product slug, [a-z0-9-]+, 2-60 chars. Must be unique globally today.'),
        display_name: z.string().min(1).max(120),
        signup_webhook_url: z
          .string()
          .url()
          .describe('HTTPS endpoint Relay POSTs to when an end-user signs up.'),
        teardown_webhook_url: z.string().url().optional(),
        verification_mode: z
          .enum(['none', 'relay_confirm_link', 'integrator_email'])
          .optional()
          .describe("Defaults to 'relay_confirm_link'."),
        input_schema: z.record(z.string(), z.unknown()).optional(),
        description: z
          .string()
          .max(500)
          .optional()
          .describe(
            'One-line description surfaced in the public provider index.',
          ),
        docs_url: z.string().url().optional(),
        homepage: z.string().url().optional(),
        npm_package: z.string().max(214).optional(),
        categories: z
          .array(z.string())
          .max(8)
          .optional()
          .describe(
            'Canonical category slugs (see list_categories). Aliases like "hoster" are auto-resolved; unknown inputs return invalid_categories.',
          ),
        pricing_model: z
          .enum(['free', 'free-tier', 'paid', 'usage-based', 'freemium'])
          .optional(),
        pricing_url: z.string().url().optional(),
        free_tier_summary: z.string().max(240).optional(),
        capabilities: z
          .array(z.string())
          .max(24)
          .optional()
          .describe(
            'Lower-case capability tags (e.g. ["postgres","serverless"]). Used by agents to filter within a category.',
          ),
      },
    },
    async ({
      agent_token,
      tenant_id,
      slug,
      display_name,
      signup_webhook_url,
      teardown_webhook_url,
      verification_mode,
      input_schema,
      description,
      docs_url,
      homepage,
      npm_package,
      categories,
      pricing_model,
      pricing_url,
      free_tier_summary,
      capabilities,
    }) => {
      let authed: AuthenticatedAgent;
      try {
        authed = await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }

      const [agentRow] = await db
        .select({ user_id: agents.user_id })
        .from(agents)
        .where(eq(agents.id, authed.agentId))
        .limit(1);
      const callerUserId = agentRow?.user_id ?? null;
      if (!callerUserId) {
        return err('agent_token is not associated with a user');
      }

      const allowed = await userCanAccessTenant(callerUserId, tenant_id);
      if (!allowed) {
        return err('forbidden: user is not a member of this tenant');
      }

      try {
        const result = await registerTenantProduct({
          tenantId: tenant_id,
          slug,
          displayName: display_name,
          signupWebhookUrl: signup_webhook_url,
          teardownWebhookUrl: teardown_webhook_url,
          verificationMode: verification_mode,
          inputSchema: input_schema,
          description,
          docsUrl: docs_url,
          homepage,
          npmPackage: npm_package,
          categories,
          pricingModel: pricing_model,
          pricingUrl: pricing_url,
          freeTierSummary: free_tier_summary,
          capabilities,
        });
        return ok({
          id: result.id,
          slug: result.slug,
          webhook_secret: result.webhook_secret,
          categories: result.categories,
          note: 'Shown once — save to .env.local as RELAY_WEBHOOK_SECRET',
        });
      } catch (e) {
        if (e instanceof RegisterTenantProductFailure) {
          if (e.kind === 'invalid_categories') {
            return err(
              `${e.message} (invalid: ${JSON.stringify(e.invalid ?? [])})`,
            );
          }
          return err(e.message);
        }
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // 10. get_my_inbox_address — bearer auth
  //     Returns the Relay-hosted email alias for the authenticated agent's
  //     user. Agents use this as the email address when signing the user up
  //     for third-party services, so verification emails land at an address
  //     the agent can read (via read_inbox below).
  // -------------------------------------------------------------------------
  server.registerTool(
    'get_my_inbox_address',
    {
      description:
        'Return the Relay-hosted email address that belongs to the authenticated user. Use this as the signup email when onboarding the user to a third-party service — verification emails land here and are readable via read_inbox.',
      inputSchema: {
        agent_token: z.string(),
      },
    },
    async ({ agent_token }) => {
      let authed: AuthenticatedAgent;
      try {
        authed = await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }
      const [a] = await db
        .select({
          user_id: agents.user_id,
          user_workspace_id: agents.user_workspace_id,
        })
        .from(agents)
        .where(eq(agents.id, authed.agentId))
        .limit(1);
      if (!a?.user_id) return err('agent_token is not associated with a user');

      // Each user workspace owns its own inbox alias. Return the alias for
      // whichever workspace this bearer is pinned to.
      const { resolveActiveUserWorkspace } = await import(
        '../server/user-workspaces'
      );
      let wsId = a.user_workspace_id ?? null;
      if (!wsId) wsId = (await resolveActiveUserWorkspace(a.user_id)).id;
      const [ws] = await db
        .select({ inbox_alias: user_workspaces.inbox_alias })
        .from(user_workspaces)
        .where(eq(user_workspaces.id, wsId))
        .limit(1);
      const alias = ws?.inbox_alias ?? null;
      if (!alias) return err('user has no inbox alias assigned');

      const catchallDomain = process.env.CATCHALL_DOMAIN ?? 'mail.example.com';
      return ok({
        alias,
        full_address: `${alias}@${catchallDomain}`,
      });
    },
  );

  // -------------------------------------------------------------------------
  // 11. read_inbox — bearer auth
  //     List recent emails received at the user's Relay alias. Optional
  //     `extract=true` auto-runs verification-link + verification-code
  //     extractors on each body and returns them inline.
  // -------------------------------------------------------------------------
  server.registerTool(
    'read_inbox',
    {
      description:
        'List recent emails received at the authenticated user\'s Relay inbox. Use this to pick up verification codes or links that third-party integrators send during agent-driven signups.',
      inputSchema: {
        agent_token: z.string(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Max messages to return (1-50, default 10).'),
        since_iso: z
          .string()
          .optional()
          .describe('ISO-8601 timestamp; only messages received after this are returned.'),
        extract: z
          .boolean()
          .optional()
          .describe('If true, auto-extract verification_link and verification_code from each body.'),
      },
    },
    async ({ agent_token, limit, since_iso, extract }) => {
      let authed: AuthenticatedAgent;
      try {
        authed = await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }
      const [a] = await db
        .select({
          user_id: agents.user_id,
          user_workspace_id: agents.user_workspace_id,
        })
        .from(agents)
        .where(eq(agents.id, authed.agentId))
        .limit(1);
      if (!a?.user_id) return err('agent_token is not associated with a user');

      const max = limit ?? 10;
      const sinceDate = since_iso ? new Date(since_iso) : null;

      // Scope to the agent's pinned workspace so a bearer pinned to one
      // workspace never reads another workspace's inbox.
      const { resolveActiveUserWorkspace } = await import(
        '../server/user-workspaces'
      );
      const wsId =
        a.user_workspace_id ?? (await resolveActiveUserWorkspace(a.user_id)).id;

      const baseWhere = sinceDate
        ? and(
            eq(email_messages.user_id, a.user_id),
            eq(email_messages.user_workspace_id, wsId),
            gt(email_messages.received_at, sinceDate),
          )
        : and(
            eq(email_messages.user_id, a.user_id),
            eq(email_messages.user_workspace_id, wsId),
          );

      const rows = await db
        .select({
          id: email_messages.id,
          to: email_messages.to_address,
          from: email_messages.from_address,
          subject: email_messages.subject,
          body_text: email_messages.body_text,
          received_at: email_messages.received_at,
        })
        .from(email_messages)
        .where(baseWhere)
        .orderBy(desc(email_messages.received_at))
        .limit(max);

      return ok({
        messages: rows.map((r) => {
          const base = {
            id: r.id,
            to: r.to,
            from: r.from,
            subject: r.subject,
            body_text: r.body_text,
            received_at: r.received_at ? r.received_at.toISOString() : null,
          };
          if (extract) {
            return {
              ...base,
              verification_link: r.body_text ? extractVerificationLink(r.body_text) : null,
              verification_code: r.body_text ? extractVerificationCode(r.body_text) : null,
            };
          }
          return base;
        }),
      });
    },
  );

  // -------------------------------------------------------------------------
  // 12. auto_confirm_pending_signup — bearer auth
  //     For a signup in `awaiting_email`, peek the user's inbox, find the most
  //     recent email received after the signup started, and resume the WDK
  //     workflow so it can dispatch the integrator webhook.
  //
  //     One-call convenience wrapper that would otherwise be:
  //       read_inbox({extract:true}) → pick the right message → resume manually.
  // -------------------------------------------------------------------------
  server.registerTool(
    'auto_confirm_pending_signup',
    {
      description:
        'For a signup awaiting email verification, scan the authenticated user\'s Relay inbox for a matching email and resume the workflow automatically. Returns { status: "resumed" | "no_email_yet" | "not_pending" }.',
      inputSchema: {
        agent_token: z.string(),
        signup_id: z.string().uuid(),
        from_contains: z
          .string()
          .optional()
          .describe('Optional filter: only accept emails whose `from` contains this string (e.g. "@example.com"). Use when the user\'s inbox may have unrelated recent messages.'),
      },
    },
    async ({ agent_token, signup_id, from_contains }) => {
      let authed: AuthenticatedAgent;
      try {
        authed = await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }

      const [a] = await db
        .select({
          user_id: agents.user_id,
          user_workspace_id: agents.user_workspace_id,
        })
        .from(agents)
        .where(eq(agents.id, authed.agentId))
        .limit(1);
      if (!a?.user_id) return err('agent_token is not associated with a user');

      const [job] = await db
        .select({
          id: signup_jobs.id,
          status: signup_jobs.status,
          created_at: signup_jobs.created_at,
          user_workspace_id: signup_jobs.user_workspace_id,
        })
        .from(signup_jobs)
        .where(eq(signup_jobs.id, signup_id))
        .limit(1);
      if (!job) return err('signup not found');
      if (job.status !== 'awaiting_email') {
        return ok({ status: 'not_pending', current_status: job.status });
      }

      const { resolveActiveUserWorkspace } = await import(
        '../server/user-workspaces'
      );
      const callerWsId =
        a.user_workspace_id ?? (await resolveActiveUserWorkspace(a.user_id)).id;
      // Cross-workspace access is not allowed — a bearer pinned to
      // workspace A cannot confirm a signup that belongs to workspace B.
      if (job.user_workspace_id && job.user_workspace_id !== callerWsId) {
        return err('signup not found');
      }

      const jobCreated = job.created_at ?? new Date(Date.now() - 60 * 60 * 1000);

      const rows = await db
        .select({
          id: email_messages.id,
          to: email_messages.to_address,
          from: email_messages.from_address,
          subject: email_messages.subject,
          body_text: email_messages.body_text,
          received_at: email_messages.received_at,
        })
        .from(email_messages)
        .where(
          and(
            eq(email_messages.user_id, a.user_id),
            eq(email_messages.user_workspace_id, callerWsId),
            gt(email_messages.received_at, jobCreated),
          ),
        )
        .orderBy(desc(email_messages.received_at))
        .limit(20);

      const candidate = rows.find((r) =>
        from_contains ? r.from.includes(from_contains) : true,
      );
      if (!candidate) {
        return ok({ status: 'no_email_yet', scanned: rows.length });
      }

      const inbound = {
        to: candidate.to,
        from: candidate.from,
        subject: candidate.subject ?? '',
        bodyText: candidate.body_text ?? '',
        headers: {} as Record<string, string>,
      };

      try {
        await resumeHook(signup_id, inbound);
      } catch (e) {
        return err(`resumeHook failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Link the email to the signup for audit clarity.
      await db
        .update(email_messages)
        .set({ matched_signup_id: signup_id })
        .where(eq(email_messages.id, candidate.id));

      return ok({
        status: 'resumed',
        email_id: candidate.id,
        verification_link: candidate.body_text
          ? extractVerificationLink(candidate.body_text)
          : null,
        verification_code: candidate.body_text
          ? extractVerificationCode(candidate.body_text)
          : null,
      });
    },
  );

  // -------------------------------------------------------------------------
  // 13. share_dashboard_link — bearer auth
  //     Mint a session-less, single-use URL that opens a read-only summary
  //     of the user's Relay data (/share/[token]). The plaintext URL is
  //     returned exactly once; only the SHA-256 hash is persisted.
  // -------------------------------------------------------------------------
  server.registerTool(
    'share_dashboard_link',
    {
      description:
        "Mint a short-lived, single-use URL that lets the user see a minimal read-only summary of their Relay data without logging in. Useful when the user is away from a computer and wants a quick glance at what's been created on their behalf. The URL is returned exactly once; Relay stores only its SHA-256 hash.",
      inputSchema: {
        agent_token: z.string(),
        ttl_minutes: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe('Minutes until the link expires (1-60, default 10).'),
        max_uses: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Maximum number of times the link can be viewed (1-10, default 1).'),
      },
    },
    async ({ agent_token, ttl_minutes, max_uses }) => {
      let authed: AuthenticatedAgent;
      try {
        authed = await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }

      const [a] = await db
        .select({ user_id: agents.user_id })
        .from(agents)
        .where(eq(agents.id, authed.agentId))
        .limit(1);
      if (!a?.user_id) return err('agent_token is not associated with a user');

      const ttlMin = ttl_minutes ?? 10;
      const uses = max_uses ?? 1;

      // Share links are free under the integrator-only revenue model.
      const token = 'mls_' + randomBytes(32).toString('base64url');
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000);

      await db.insert(magic_links).values({
        user_id: a.user_id,
        token_hash: tokenHash,
        purpose: 'dashboard_summary',
        expires_at: expiresAt,
        max_uses: uses,
        created_by: authed.agentId,
      });

      const base =
        process.env.APP_BASE_URL ??
        (process.env.VERCEL_PROJECT_PRODUCTION_URL
          ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.replace(/^https?:\/\//, '')}`
          : 'http://localhost:3000');

      return ok({
        url: `${base}/share/${token}`,
        expires_at: expiresAt.toISOString(),
        max_uses: uses,
        note: 'Print this URL to the user. Relay stored only the hash — once expired or claimed, the link cannot be regenerated.',
      });
    },
  );

  // -------------------------------------------------------------------------
  // 14. get_subscription_status — bearer auth, read-only.
  //     Returns the current tenant's Stripe subscription snapshot. Callable
  //     only by a user who owns or is a member of the tenant.
  // -------------------------------------------------------------------------
  server.registerTool(
    'get_subscription_status',
    {
      description:
        "Return the named tenant's subscription snapshot: status (trialing/active/past_due/canceled/none), plan, current_period_end, trial_ends_at, canceled_at. Caller must own or be a member of the tenant. Read-only — no DB writes.",
      inputSchema: {
        agent_token: z.string(),
        tenant_id: z
          .string()
          .uuid()
          .describe('Tenant to inspect. Must be a tenant the caller can access.'),
      },
    },
    async ({ agent_token, tenant_id }) => {
      let authed: AuthenticatedAgent;
      try {
        authed = await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }

      const [agentRow] = await db
        .select({ user_id: agents.user_id })
        .from(agents)
        .where(eq(agents.id, authed.agentId))
        .limit(1);
      const callerUserId = agentRow?.user_id ?? null;
      if (!callerUserId) {
        return err('agent_token is not associated with a user');
      }

      const allowed = await userCanAccessTenant(callerUserId, tenant_id);
      if (!allowed) {
        return err('forbidden: user is not a member of this tenant');
      }

      const [row] = await db
        .select({
          status: tenant_subscriptions.status,
          plan: tenant_subscriptions.plan,
          billing_interval: tenant_subscriptions.billing_interval,
          current_period_end: tenant_subscriptions.current_period_end,
          trial_ends_at: tenant_subscriptions.trial_ends_at,
          canceled_at: tenant_subscriptions.canceled_at,
        })
        .from(tenant_subscriptions)
        .where(eq(tenant_subscriptions.tenant_id, tenant_id))
        .orderBy(desc(tenant_subscriptions.created_at))
        .limit(1);

      const [quotaRow] = await db
        .select()
        .from(tenant_quota_state)
        .where(eq(tenant_quota_state.tenant_id, tenant_id))
        .limit(1);

      const [planRow] = row?.plan
        ? await db.select().from(plan_catalog).where(eq(plan_catalog.id, row.plan)).limit(1)
        : [undefined];

      const quota = quotaRow
        ? {
            included_total: planRow?.included_actions ?? 0,
            included_remaining: quotaRow.included_remaining,
            overage_count: quotaRow.overage_count,
            overage_price_cents: planRow?.overage_price_cents ?? 0,
            overage_spend_cents:
              quotaRow.overage_count * (planRow?.overage_price_cents ?? 0),
            period_start: quotaRow.period_start
              ? new Date(quotaRow.period_start).toISOString()
              : null,
            period_end: quotaRow.period_end
              ? new Date(quotaRow.period_end).toISOString()
              : null,
          }
        : null;

      const credits = await listCredits(tenant_id);

      return ok({
        tenant_id,
        status: row?.status ?? 'none',
        plan: row?.plan ?? null,
        billing_interval: row?.billing_interval ?? null,
        current_period_end: row?.current_period_end
          ? new Date(row.current_period_end).toISOString()
          : null,
        trial_ends_at: row?.trial_ends_at
          ? new Date(row.trial_ends_at).toISOString()
          : null,
        canceled_at: row?.canceled_at
          ? new Date(row.canceled_at).toISOString()
          : null,
        quota,
        credits: {
          total_remaining: credits.total_remaining,
          packs: credits.credits,
        },
        subscribe_url: `${appBaseUrlForBilling()}/dev/billing`,
      });
    },
  );

  // -------------------------------------------------------------------------
  // 15. start_subscription — bearer auth, returns a Stripe Checkout URL.
  //     Closes the dashboard-only gap in the agent bootstrap flow. If the
  //     tenant already has an active subscription the tool returns a Stripe
  //     Billing Portal link instead so the user can manage/change plan — a
  //     second Checkout would create a duplicate subscription.
  // -------------------------------------------------------------------------
  server.registerTool(
    'start_subscription',
    {
      description:
        "Start (or manage) a Stripe subscription for a tenant. Returns a Stripe Checkout URL for the chosen plan and interval (monthly or yearly — yearly ships at a 17% discount, ≈ 2 months free). If the tenant already has an active subscription (trialing/active/past_due), returns a Stripe Billing Portal URL under `already_active.portal_url` so the user can change plan, switch interval, or update payment method. The caller must own or be a member of the tenant. After the user completes Checkout, poll `get_subscription_status` until `status === 'active'`.",
      inputSchema: {
        agent_token: z
          .string()
          .describe('Bearer token identifying the calling agent.'),
        tenant_id: z
          .string()
          .uuid()
          .describe(
            'Tenant to attach the subscription to. Agent must own or be a member of this tenant.',
          ),
        plan: z
          .enum(['builder', 'starter', 'growth', 'scale'])
          .describe(
            'Plan id. Builder $49/mo, Starter $199/mo, Growth $999/mo, Scale $2,999/mo. Yearly equivalents: $490, $1,990, $9,990, $29,990 (17% off).',
          ),
        interval: z
          .enum(['monthly', 'yearly'])
          .optional()
          .default('monthly')
          .describe(
            'Billing cadence. Defaults to monthly. Pass `yearly` to apply the 17% annual discount.',
          ),
      },
    },
    async ({ agent_token, tenant_id, plan, interval }) => {
      let authed: AuthenticatedAgent;
      try {
        authed = await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }

      const [agentRow] = await db
        .select({ user_id: agents.user_id })
        .from(agents)
        .where(eq(agents.id, authed.agentId))
        .limit(1);
      const callerUserId = agentRow?.user_id ?? null;
      if (!callerUserId) {
        return err('agent_token is not associated with a user');
      }

      const allowed = await userCanAccessTenant(callerUserId, tenant_id);
      if (!allowed) {
        return err('forbidden: user is not a member of this tenant');
      }

      const existing = await getLatestSubscription(tenant_id);
      if (existing && isSubscriptionActive(existing.status)) {
        try {
          const portal = await createBillingPortalSession({
            tenantId: tenant_id,
          });
          return ok({
            already_active: {
              current_plan: existing.plan,
              status: existing.status,
              portal_url: portal.url,
            },
            note: `Tenant is already on plan ${existing.plan}. Use portal_url to change plan or cancel.`,
          });
        } catch (e) {
          if (e instanceof BillingCheckoutFailure) {
            // Fall through to creating a new checkout — the existing sub has
            // no Stripe customer on file (seeded trial, etc.), so starting
            // a fresh subscription is the right move.
          } else {
            return err(e instanceof Error ? e.message : String(e));
          }
        }
      }

      try {
        // Plan + interval were validated by the Zod enums above — casts are safe.
        const checkout = await createCheckoutSession({
          tenantId: tenant_id,
          actingUserId: callerUserId,
          plan: plan as PlanId,
          interval: interval as BillingInterval,
        });
        return ok({
          checkout_url: checkout.url,
          session_id: checkout.sessionId,
          expires_at: checkout.expiresAt.toISOString(),
          plan,
          billing_interval: interval,
          tenant_id,
          note: "Open checkout_url in the user's browser. After they pay, poll get_subscription_status until status === 'active'.",
        });
      } catch (e) {
        if (e instanceof BillingCheckoutFailure) {
          if (e.kind === 'plan_not_configured') {
            const monthlyAvailable = CHECKOUT_PLANS.filter(
              (p) => process.env[`STRIPE_PRICE_${p.toUpperCase()}`],
            );
            const yearlyAvailable = CHECKOUT_PLANS.filter(
              (p) => process.env[`STRIPE_PRICE_${p.toUpperCase()}_YEARLY`],
            );
            return err(
              `plan_not_configured: ${e.message}. Available plans (monthly): ${
                monthlyAvailable.join(', ') || '(none)'
              }. Available plans (yearly): ${yearlyAvailable.join(', ') || '(none)'}`,
            );
          }
          return err(e.message);
        }
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // 15b. purchase_credits — bearer auth, returns a Stripe Checkout URL for a
  //      one-shot credit pack (mode=payment). Use when the tenant is running
  //      low on plan-included headroom and wants extra actions priced 20%
  //      below the plan's overage rate. Credits expire 12 months after
  //      purchase and FIFO-consume *before* overage falls through.
  // -------------------------------------------------------------------------
  server.registerTool(
    'purchase_credits',
    {
      description:
        'Buy a one-shot credit pack of extra actions for the tenant. Returns a Stripe Checkout URL (mode=payment). Each pack is sized at ~50% of the plan\'s monthly quota and priced 20% below the plan\'s overage rate. Credits expire 12 months after purchase and are FIFO-consumed AFTER plan headroom is exhausted and BEFORE overage queues a per-action invoice item. Caller must own or be a member of the tenant.',
      inputSchema: {
        agent_token: z
          .string()
          .describe('Bearer token identifying the calling agent.'),
        tenant_id: z
          .string()
          .uuid()
          .describe('Tenant to credit. Caller must own or be a member.'),
        pack: z
          .enum(['builder', 'starter', 'growth', 'scale'])
          .describe(
            'Credit pack SKU. Builder 500/$20, Starter 5,000/$80, Growth 25,000/$400, Scale 100,000/$800.',
          ),
      },
    },
    async ({ agent_token, tenant_id, pack }) => {
      let authed: AuthenticatedAgent;
      try {
        authed = await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }

      const [agentRow] = await db
        .select({ user_id: agents.user_id })
        .from(agents)
        .where(eq(agents.id, authed.agentId))
        .limit(1);
      const callerUserId = agentRow?.user_id ?? null;
      if (!callerUserId) {
        return err('agent_token is not associated with a user');
      }

      const allowed = await userCanAccessTenant(callerUserId, tenant_id);
      if (!allowed) {
        return err('forbidden: user is not a member of this tenant');
      }

      try {
        const session = await createCreditCheckoutSession({
          tenantId: tenant_id,
          actingUserId: callerUserId,
          pack: pack as CreditPackId,
        });
        return ok({
          checkout_url: session.url,
          session_id: session.sessionId,
          expires_at: session.expiresAt.toISOString(),
          pack: {
            id: session.pack.id,
            actions: session.pack.actions,
            amount_cents: session.pack.amountCents,
            effective_cents_per_action: session.pack.effectiveCentsPerAction,
          },
          tenant_id,
          note: "Open checkout_url in the user's browser. After they pay, the credits land on the tenant within seconds. Verify by polling get_subscription_status; the response's `credits.total_remaining` will increase by the pack's action count.",
        });
      } catch (e) {
        if (e instanceof BillingCheckoutFailure) {
          if (e.kind === 'pack_not_configured') {
            const available = CREDIT_PACK_IDS.filter(
              (p) => process.env[`STRIPE_PRICE_CREDITS_${p.toUpperCase()}`],
            );
            const catalog = CREDIT_PACK_IDS.map((id) => {
              const def = PACK_DEFS[id];
              return `${id} (${def.actions.toLocaleString()} actions / $${(
                def.amountCents / 100
              ).toFixed(2)})`;
            }).join(', ');
            return err(
              `pack_not_configured: ${e.message}. Available packs on this instance: ${
                available.join(', ') || '(none)'
              }. Full catalog: ${catalog}`,
            );
          }
          return err(e.message);
        }
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // 16. whoami — public (accepts optional agent_token).
  //     Useful for an agent to check whether it already has a valid token or
  //     needs to call register_tenant.
  // -------------------------------------------------------------------------
  server.registerTool(
    'whoami',
    {
      description:
        'Return the identity associated with an agent_token (or "anonymous" if no valid token). Useful before deciding whether to call register_tenant or continue with an existing session.',
      inputSchema: {
        agent_token: z.string().optional(),
      },
    },
    async ({ agent_token }) => {
      if (!agent_token) return ok({ kind: 'anonymous' });
      try {
        const authed = await authenticate(agent_token);
        const [a] = await db
          .select({ user_id: agents.user_id, label: agents.label })
          .from(agents)
          .where(eq(agents.id, authed.agentId))
          .limit(1);

        let userEmail: string | null = null;
        let inboxAlias: string | null = null;
        if (a?.user_id) {
          const [u] = await db
            .select({ email: users.email, inbox_alias: users.inbox_alias })
            .from(users)
            .where(eq(users.id, a.user_id))
            .limit(1);
          userEmail = u?.email ?? null;
          inboxAlias = u?.inbox_alias ?? null;
        }

        const catchallDomain = process.env.CATCHALL_DOMAIN ?? 'mail.example.com';
        return ok({
          kind: 'agent',
          agent_id: authed.agentId,
          scopes: authed.scopes,
          label: a?.label ?? null,
          user_id: a?.user_id ?? null,
          user_email: userEmail,
          inbox_alias: inboxAlias,
          inbox_address: inboxAlias ? `${inboxAlias}@${catchallDomain}` : null,
        });
      } catch {
        return ok({ kind: 'anonymous' });
      }
    },
  );

  // -------------------------------------------------------------------------
  // 17. list_actions — discover the Actions-API catalog for a tenant.
  // -------------------------------------------------------------------------
  server.registerTool(
    'list_actions',
    {
      description:
        'Return the public Actions catalog for a Relay integrator. Use before execute_action so the agent knows which slugs exist and what input each expects.',
      inputSchema: {
        agent_token: z.string().describe('Bearer token identifying the calling agent.'),
        tenant_slug: z.string().describe('Relay tenant slug (from /.well-known/relay.json).'),
      },
    },
    async ({ agent_token, tenant_slug }) => {
      try {
        await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }

      const [tenant] = await db
        .select({ id: tenants.id, slug: tenants.slug })
        .from(tenants)
        .where(eq(tenants.slug, tenant_slug))
        .limit(1);
      if (!tenant) return err(`tenant_not_found:${tenant_slug}`);

      const rows = await db
        .select({
          slug: actionsTable.slug,
          display_name: actionsTable.display_name,
          description: actionsTable.description,
          input_schema: actionsTable.input_schema,
          output_schema: actionsTable.output_schema,
        })
        .from(actionsTable)
        .where(
          and(
            eq(actionsTable.tenant_id, tenant.id),
            eq(actionsTable.visibility, 'public'),
            isNull(actionsTable.disabled_at),
          ),
        );

      return ok({
        tenant_id: tenant.id,
        tenant_slug: tenant.slug,
        actions: rows.map((r) => ({
          slug: r.slug,
          display_name: r.display_name,
          description: r.description,
          input_schema: (r.input_schema as Record<string, unknown>) ?? {},
          output_schema: (r.output_schema as Record<string, unknown>) ?? {},
        })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // 18. execute_action — invoke an integrator action.
  //     Delegates to POST /v1/actions/execute to keep the charge/quota/refund
  //     semantics single-sourced.
  // -------------------------------------------------------------------------
  server.registerTool(
    'execute_action',
    {
      description:
        'Invoke a registered action on a Relay integrator. Charges action_execute (1 token) against the caller\'s wallet and counts against the tenant\'s monthly quota. Returns {invocationId, status, output} on success, or an error string.',
      inputSchema: {
        agent_token: z.string(),
        tenant_slug: z.string(),
        action_slug: z.string(),
        input: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Input object matching the action\'s input_schema.'),
        idempotency_key: z
          .string()
          .optional()
          .describe('Optional client-supplied idempotency key (24h TTL).'),
      },
    },
    async ({ agent_token, tenant_slug, action_slug, input, idempotency_key }) => {
      try {
        await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }

      const base =
        process.env.APP_BASE_URL ??
        (process.env.VERCEL_PROJECT_PRODUCTION_URL
          ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.replace(/^https?:\/\//, '')}`
          : 'http://localhost:3000');

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agent_token}`,
      };
      if (idempotency_key) headers['Idempotency-Key'] = idempotency_key;

      const res = await fetch(`${base}/v1/actions/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tenantSlug: tenant_slug,
          actionSlug: action_slug,
          input: input ?? {},
        }),
      });

      const text = await res.text();
      let data: unknown;
      try {
        data = text.length ? JSON.parse(text) : {};
      } catch {
        data = { raw: text.slice(0, 500) };
      }
      if (!res.ok) return err(JSON.stringify({ status: res.status, body: data }));
      return ok(data);
    },
  );

  // -------------------------------------------------------------------------
  // 19. read_agent_guide — bearer auth, read-only.
  //     Returns the caller-user's free-form markdown "agent guide" that holds
  //     preferences, defaults, and long-running context. Fetch at session start.
  // -------------------------------------------------------------------------
  server.registerTool(
    'read_agent_guide',
    {
      description:
        "Return the authenticated user's agent_guide markdown — preferences, defaults, and long-running context the user stored for their AI agents. Agents should call this at the start of every session so they inherit the user's conventions. Returns { content, updated_at, bytes }; `content` is the empty string when the user has never set a guide.",
      inputSchema: {
        agent_token: z.string(),
      },
    },
    async ({ agent_token }) => {
      let authed: AuthenticatedAgent;
      try {
        authed = await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }

      const [agentRow] = await db
        .select({ user_id: agents.user_id })
        .from(agents)
        .where(eq(agents.id, authed.agentId))
        .limit(1);
      const uid = agentRow?.user_id ?? null;
      if (!uid) return err('agent_token is not associated with a user');

      const [row] = await db
        .select({
          agent_guide: users.agent_guide,
          agent_guide_updated_at: users.agent_guide_updated_at,
        })
        .from(users)
        .where(eq(users.id, uid))
        .limit(1);

      const content = row?.agent_guide ?? '';
      return ok({
        content,
        updated_at: row?.agent_guide_updated_at
          ? new Date(row.agent_guide_updated_at).toISOString()
          : null,
        bytes: Buffer.byteLength(content, 'utf8'),
      });
    },
  );

  // -------------------------------------------------------------------------
  // 20. update_agent_guide — bearer auth, write.
  //     Replaces the caller-user's agent_guide. Last-write-wins; 64 KiB cap.
  //     Convention (not enforced): agents propose edits in chat and call this
  //     only after the user approves. Audit rows record byte counts, never
  //     content, so the audit log is not a shadow store.
  // -------------------------------------------------------------------------
  server.registerTool(
    'update_agent_guide',
    {
      description:
        "Replace the authenticated user's agent_guide with a new markdown body. Convention: propose the edit in chat first, get the user's confirmation, then call this tool. Last write wins; max 64 KiB. Returns { updated_at, bytes }.",
      inputSchema: {
        agent_token: z.string(),
        content: z
          .string()
          .describe('New markdown body (UTF-8). Must be <= 64 KiB (65536 bytes).'),
      },
    },
    async ({ agent_token, content }) => {
      let authed: AuthenticatedAgent;
      try {
        authed = await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }

      const bytes = Buffer.byteLength(content, 'utf8');
      const MAX_GUIDE_BYTES = 64 * 1024;
      if (bytes > MAX_GUIDE_BYTES) {
        return err(
          `agent_guide body is ${bytes} bytes; max is ${MAX_GUIDE_BYTES} bytes (64 KiB)`,
        );
      }

      const [agentRow] = await db
        .select({ user_id: agents.user_id })
        .from(agents)
        .where(eq(agents.id, authed.agentId))
        .limit(1);
      const uid = agentRow?.user_id ?? null;
      if (!uid) return err('agent_token is not associated with a user');

      const now = new Date();
      await db
        .update(users)
        .set({ agent_guide: content, agent_guide_updated_at: now })
        .where(eq(users.id, uid));

      await db.insert(audit_log).values({
        agent_id: authed.agentId,
        action: 'agent_guide_update',
        target: uid,
        metadata: { bytes, via: 'mcp' },
        user_id: uid,
      });

      return ok({ updated_at: now.toISOString(), bytes });
    },
  );

  // -------------------------------------------------------------------------
  // 21. resolve_intent — bearer auth, write.
  //     Goal-to-env resolver. Parses a natural-language goal, dedups against
  //     existing accounts, kicks signups for the gaps. Returns existing
  //     accounts as `accountId`-only entries (caller follows up via mint /
  //     reveal as needed) and provisioning entries with poll URLs.
  //     Slimmer than the REST shape: no envStyle (always raw), no
  //     revealUrl/revealAllUrl (LLMs would speculatively call them and rotate
  //     keys unnecessarily). Intent itself does not bill — sub-signups bill
  //     via the existing integrator-quota gate inside kickSignup.
  // -------------------------------------------------------------------------
  server.registerTool(
    'resolve_intent',
    {
      description:
        'Resolve a free-text infrastructure goal (e.g. "Postgres + transactional email for a Next.js app") into a set of existing-or-newly-provisioning accounts plus a paste-ready env block. Intent itself is non-billable; each spawned signup bills via the standard integrator quota. Returns deterministic results — same goal + same workspace = same response. Pin specific providers via `pin: [{category, providerId, alias?}]` to override the heuristic selector.',
      inputSchema: {
        agent_token: z.string(),
        goal: z
          .string()
          .min(1)
          .max(2000)
          .describe(
            'Natural-language description of what the workspace needs. Heuristic keyword match — no LLM.',
          ),
        workspace_id: z
          .string()
          .uuid()
          .describe(
            "Required. The user's workspace this resolution is scoped to. Must belong to the calling user.",
          ),
        pin: z
          .array(
            z.object({
              category: z.string().min(1),
              providerId: z.string().min(1),
              alias: z.string().min(1).max(64).optional(),
            }),
          )
          .max(20)
          .optional()
          .describe(
            'Override the parser/selector for specific categories. Each pin becomes its own resolution slot.',
          ),
      },
    },
    async ({ agent_token, goal, workspace_id, pin }) => {
      let authed: AuthenticatedAgent;
      try {
        authed = await authenticate(agent_token);
      } catch (e) {
        return err((e as Error).message);
      }

      const [agentRow] = await db
        .select({ user_id: agents.user_id })
        .from(agents)
        .where(eq(agents.id, authed.agentId))
        .limit(1);
      const userId = agentRow?.user_id ?? null;
      if (!userId) {
        return err('agent_token is not associated with a user');
      }

      const [workspaceRow] = await db
        .select({ id: user_workspaces.id })
        .from(user_workspaces)
        .where(
          and(
            eq(user_workspaces.id, workspace_id),
            eq(user_workspaces.user_id, userId),
          ),
        )
        .limit(1);
      if (!workspaceRow) return err('workspace not found');

      const result = await resolveIntent({
        goal,
        workspaceId: workspaceRow.id,
        envStyle: 'raw',
        pin,
        callingAgentId: authed.agentId,
        agentScopes: authed.scopes,
        userId,
      });

      // MCP variant: drop revealUrl + revealAllUrl so LLMs can't speculate
      // into legacy reveals or rotations they don't actually need. Agents
      // that do need plaintext for an existing account can call
      // reveal_api_key / get_api_key explicitly.
      const slimResolutions = result.resolutions.map((r) => ({
        category: r.category,
        alias: r.alias,
        provider: r.provider,
        status: r.status,
        accountId: r.accountId,
        signupJobId: r.signupJobId,
        pollUrl: r.pollUrl,
        envVar: r.envVar,
        value: r.value,
        candidates: r.candidates,
      }));

      await db.insert(audit_log).values({
        agent_id: authed.agentId,
        action: 'intent_resolve',
        target: null,
        metadata: {
          goal,
          categories: result.parsedCategories,
          unmatched: result.unmatchedTerms,
          via: 'mcp',
          resolutions: slimResolutions.map((r) => ({
            category: r.category,
            alias: r.alias,
            provider: r.provider,
            status: r.status,
          })),
        },
        user_id: userId,
        tenant_id: null,
      });

      return ok({
        resolutions: slimResolutions,
        envBlock: result.envBlock,
        pending: result.pending,
        unsatisfied: result.unsatisfied,
        unmatchedTerms: result.unmatchedTerms,
        notes: result.notes,
      });
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Hono handler — instantiate one McpServer + transport per request (stateless).
//
// The WebStandardStreamableHTTPServerTransport takes a raw Web-Standard
// Request and returns a Response, which Hono can return directly.
// ---------------------------------------------------------------------------
export async function handleMcpRequest(req: Request): Promise<Response> {
  const server = buildMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session id. Every request is self-contained.
    sessionIdGenerator: undefined,
    // Prefer JSON responses over SSE for simple request/response tool calls.
    enableJsonResponse: true,
  });

  await server.connect(transport);

  try {
    return await transport.handleRequest(req);
  } finally {
    // Best-effort cleanup; stateless transport has no long-lived state.
    void server.close();
  }
}
