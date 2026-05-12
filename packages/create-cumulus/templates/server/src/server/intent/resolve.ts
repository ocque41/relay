/**
 * Core intent resolution logic — shared by POST /v1/intent and the MCP
 * `resolve_intent` tool. Both surfaces wrap this with their own auth,
 * response shaping, and error mapping.
 *
 * Pure-ish: only DB reads (existing accounts, in-flight signup_jobs) and
 * one DB write per slot via kickSignup. No HTTP awareness, no caching, no
 * audit (callers do those).
 */
import { and, desc, eq, isNull, sql, inArray } from 'drizzle-orm';
import { db } from '../db/index';
import {
  accounts as accountsTable,
  api_keys as apiKeysTable,
  signup_jobs as signupJobsTable,
  user_workspaces as userWorkspacesTable,
  users as usersTable,
} from '../db/schema';
import { listProviders, getProvider } from '../providers/index';
import { parseIntent } from './parse';
import { selectProvider } from './select';
import {
  formatEnvBlock,
  type EnvResolution,
  type EnvStyle,
} from './env-block';
import { kickSignup } from '../signups/kick';

export interface ResolveIntentInput {
  goal: string;
  workspaceId: string;
  envStyle: EnvStyle;
  pin?: Array<{ category: string; providerId: string; alias?: string }>;
  callingAgentId: string;
  agentScopes: readonly string[];
  userId: string;
}

export interface ResolutionEntry extends EnvResolution {
  accountId?: string;
  signupJobId?: string;
  pollUrl?: string;
  revealUrl?: string;
  candidates?: string[];
}

export interface ResolveIntentResult {
  resolutions: ResolutionEntry[];
  envBlock: string;
  pending: string[];
  unsatisfied: Array<{ category: string; reason: string }>;
  unmatchedTerms: string[];
  revealAllUrl: string | null;
  notes: string[];
  /** Parser output exposed for the audit log. */
  parsedCategories: string[];
}

interface ResolutionSlot {
  category: string;
  alias: string | null;
  providerId: string | null;
  candidates?: string[];
}

export async function resolveIntent(input: ResolveIntentInput): Promise<ResolveIntentResult> {
  const parsed = parseIntent(input.goal);
  // Intent resolution sees the full registry — including demo-visibility
  // built-ins. The public discovery surface (/v1/index, /v1/providers)
  // hides demos by default; intent does not, because a goal that maps to
  // "neon" should still resolve.
  const allProviders = await listProviders({ includeDemo: true });

  // Fetch context for provider.defaultInputForIntent — workspace slug +
  // user email + catchall alias. One round-trip for everything.
  const [contextRow] = await db
    .select({
      workspaceSlug: userWorkspacesTable.slug,
      catchallAlias: userWorkspacesTable.inbox_alias,
      userEmail: usersTable.email,
    })
    .from(userWorkspacesTable)
    .leftJoin(usersTable, eq(userWorkspacesTable.user_id, usersTable.id))
    .where(eq(userWorkspacesTable.id, input.workspaceId))
    .limit(1);
  const catchallDomain = process.env.CATCHALL_DOMAIN ?? null;
  const intentCtx = {
    workspaceId: input.workspaceId,
    workspaceSlug: contextRow?.workspaceSlug ?? null,
    userEmail: contextRow?.userEmail ?? null,
    catchallAlias:
      contextRow?.catchallAlias && catchallDomain
        ? `${contextRow.catchallAlias}@${catchallDomain}`
        : null,
  };

  const slots: ResolutionSlot[] = [];
  const pinned = input.pin ?? [];
  const pinnedCategories = new Set(pinned.map((p) => p.category));

  for (const pin of pinned) {
    slots.push({
      category: pin.category,
      alias: pin.alias ?? null,
      providerId: pin.providerId,
    });
  }

  for (const category of parsed.categories) {
    if (pinnedCategories.has(category)) continue;
    const result = selectProvider(category, allProviders);
    if (result.kind === 'none') {
      slots.push({ category, alias: null, providerId: null });
    } else if (result.kind === 'ambiguous') {
      slots.push({
        category,
        alias: null,
        providerId: null,
        candidates: result.candidates.map((p) => p.id),
      });
    } else {
      slots.push({ category, alias: null, providerId: result.provider.id });
    }
  }

  const resolutions: ResolutionEntry[] = [];
  const unsatisfied: Array<{ category: string; reason: string }> = [];
  const pending: string[] = [];

  for (const slot of slots) {
    if (slot.providerId === null) {
      const status: 'ambiguous' | 'no_provider' = slot.candidates ? 'ambiguous' : 'no_provider';
      unsatisfied.push({ category: slot.category, reason: status });
      resolutions.push({
        category: slot.category,
        alias: slot.alias,
        provider: '',
        status,
        candidates: slot.candidates,
      });
      continue;
    }

    const provider = await getProvider(slot.providerId);
    const envVar = provider?.envVar;

    const aliasFilter =
      slot.alias === null
        ? isNull(accountsTable.alias)
        : eq(accountsTable.alias, slot.alias);
    const [existingAccount] = await db
      .select({ id: accountsTable.id })
      .from(accountsTable)
      .where(
        and(
          eq(accountsTable.user_workspace_id, input.workspaceId),
          eq(accountsTable.provider_id, slot.providerId),
          aliasFilter,
          sql`${accountsTable.status} != 'failed'`,
        ),
      )
      .limit(1);

    if (existingAccount) {
      const [latestKey] = await db
        .select({ id: apiKeysTable.id })
        .from(apiKeysTable)
        .where(
          and(
            eq(apiKeysTable.account_id, existingAccount.id),
            isNull(apiKeysTable.revoked_at),
          ),
        )
        .orderBy(desc(apiKeysTable.created_at))
        .limit(1);

      resolutions.push({
        category: slot.category,
        alias: slot.alias,
        provider: slot.providerId,
        status: 'existing',
        envVar,
        value: null,
        accountId: existingAccount.id,
        revealUrl: latestKey
          ? `/v1/accounts/${existingAccount.id}/api-keys/${latestKey.id}/reveal`
          : undefined,
      });
      continue;
    }

    const aliasFilterJobs =
      slot.alias === null
        ? isNull(signupJobsTable.alias)
        : eq(signupJobsTable.alias, slot.alias);
    const [inFlight] = await db
      .select({ id: signupJobsTable.id })
      .from(signupJobsTable)
      .where(
        and(
          eq(signupJobsTable.user_workspace_id, input.workspaceId),
          eq(signupJobsTable.provider_slug, slot.providerId),
          aliasFilterJobs,
          inArray(signupJobsTable.status, ['pending', 'awaiting_email']),
        ),
      )
      .orderBy(desc(signupJobsTable.created_at))
      .limit(1);

    if (inFlight) {
      pending.push(inFlight.id);
      resolutions.push({
        category: slot.category,
        alias: slot.alias,
        provider: slot.providerId,
        status: 'provisioning',
        envVar,
        value: null,
        signupJobId: inFlight.id,
        pollUrl: `/v1/signups/${inFlight.id}`,
      });
      continue;
    }

    // Build a default input for the provider. Without one, /v1/intent has
    // no way to satisfy the provider's required schema — surface as
    // no_provider with a clearer reason.
    let defaultInput: unknown;
    if (provider?.defaultInputForIntent) {
      defaultInput = provider.defaultInputForIntent({
        ...intentCtx,
        alias: slot.alias,
      });
    } else {
      unsatisfied.push({
        category: slot.category,
        reason: 'provider_requires_explicit_input — call /v1/signups directly',
      });
      resolutions.push({
        category: slot.category,
        alias: slot.alias,
        provider: slot.providerId,
        status: 'no_provider',
        envVar,
      });
      continue;
    }

    const kicked = await kickSignup({
      provider: slot.providerId,
      input: defaultInput,
      callingAgentId: input.callingAgentId,
      agentScopes: input.agentScopes,
      userId: input.userId,
      userWorkspaceId: input.workspaceId,
      alias: slot.alias,
    });

    if (!kicked.ok) {
      unsatisfied.push({
        category: slot.category,
        reason: `kick_signup_failed:${kicked.status}:${kicked.body.error}`,
      });
      resolutions.push({
        category: slot.category,
        alias: slot.alias,
        provider: slot.providerId,
        status: 'no_provider',
        envVar,
      });
      continue;
    }

    pending.push(kicked.signupJobId);
    resolutions.push({
      category: slot.category,
      alias: slot.alias,
      provider: slot.providerId,
      status: 'provisioning',
      envVar,
      value: null,
      signupJobId: kicked.signupJobId,
      pollUrl: `/v1/signups/${kicked.signupJobId}`,
    });
  }

  const formatted = formatEnvBlock(resolutions, input.envStyle);
  for (let i = 0; i < resolutions.length; i++) {
    const finalVar = formatted.finalEnvVars[i];
    if (finalVar) resolutions[i].envVar = finalVar;
  }

  const revealAllUrl = resolutions.some((r) => r.revealUrl)
    ? '/v1/accounts/keys/reveal-batch'
    : null;

  const notes: string[] = [...formatted.notes];
  for (const r of resolutions) {
    if (r.status === 'provisioning' && r.provider === 'resend') {
      notes.push(`Resend signup requires email verification — poll ${r.pollUrl}`);
    }
    if (r.status === 'ambiguous' && r.candidates) {
      notes.push(
        `${r.category} has multiple equally-priced providers (${r.candidates.join(', ')}) — pin one to disambiguate`,
      );
    }
  }

  return {
    resolutions,
    envBlock: formatted.envBlock,
    pending,
    unsatisfied,
    unmatchedTerms: parsed.unmatched,
    revealAllUrl,
    notes,
    parsedCategories: parsed.categories.slice(),
  };
}
