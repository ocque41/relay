/**
 * Central agent-token mint helper.
 *
 * One reason to funnel every `insert(agents)` call site through this helper:
 * expiry. New tokens default to 30 days, rotating automatically; callers that
 * want a non-expiring token must pass `expiry: 'never'` AND
 * `userRequestedNever: true`. That second flag is the belt-and-suspenders guard
 * against an agent "helpfully" requesting a forever token on its own — callers
 * must surface the decision to the human user and record their explicit consent.
 *
 * The auth middleware (src/server/auth.ts) and the MCP authenticate() helper
 * both reject tokens where `expires_at <= now()` with a distinct
 * `agent_token_expired` error so callers can tell the user to re-bootstrap.
 *
 * Scope filtering: callers MUST pass the caller's session / request context
 * if they want to grant the special `admin` scope — the helper will strip
 * `admin` from the final scope array unless `allowAdmin: true` is set. This
 * keeps end-user self-service routes from accidentally minting platform-admin
 * tokens.
 */
import { db } from '../db/index';
import { agents } from '../db/schema';
import { generateToken, hashToken } from '../crypto';

/** Default expiry for new agent tokens: 30 days. */
export const DEFAULT_AGENT_TOKEN_DAYS = 30;

/**
 * Expiry policy.
 *   - `{ days: N }`   — token expires N days from now. N must be ≥ 1.
 *   - `'never'`       — token never expires. Only honored when
 *                       `userRequestedNever: true` is set on the options.
 *                       Otherwise falls back to the default 30 days.
 */
export type ExpiryPolicy = { days: number } | 'never';

export interface MintAgentTokenOptions {
  userId: string | null;
  tenantId?: string | null;
  userWorkspaceId?: string | null;
  scopes?: string[];
  label?: string | null;
  /** Expiry policy. Defaults to `{ days: 30 }`. */
  expiry?: ExpiryPolicy;
  /**
   * Must be `true` when `expiry === 'never'` for the helper to honor that
   * request. Surfaces the human-user's explicit consent to a forever token.
   * Without this flag, a `'never'` request degrades to the default 30d TTL.
   */
  userRequestedNever?: boolean;
  /** Permit the `admin` scope. Off by default — self-service routes always pass false. */
  allowAdmin?: boolean;
}

export interface MintedAgentToken {
  /** Plaintext token — shown exactly once, never stored. */
  token: string;
  /** Agent row id. */
  agentId: string;
  /** SHA-256 hex of `token`. */
  tokenHash: string;
  /** Absolute expiry instant, or null when `'never'` was honored. */
  expiresAt: Date | null;
}

export function resolveExpiresAt(
  expiry: ExpiryPolicy | undefined,
  userRequestedNever: boolean | undefined,
  now: Date = new Date(),
): Date | null {
  if (expiry === 'never') {
    if (userRequestedNever === true) return null;
    // The caller asked for a non-expiring token but didn't confirm the human
    // requested it — fall back to the default so no agent "helpfully" issues
    // itself a forever token.
    return new Date(now.getTime() + DEFAULT_AGENT_TOKEN_DAYS * 86_400_000);
  }
  if (expiry && typeof expiry === 'object' && typeof expiry.days === 'number') {
    const days = Math.max(1, Math.floor(expiry.days));
    return new Date(now.getTime() + days * 86_400_000);
  }
  return new Date(now.getTime() + DEFAULT_AGENT_TOKEN_DAYS * 86_400_000);
}

export function sanitizeScopes(
  scopes: string[] | undefined,
  allowAdmin: boolean | undefined,
): string[] {
  const input = scopes ?? [];
  if (allowAdmin) return input;
  return input.filter((s) => s !== 'admin');
}

/**
 * Insert an `agents` row and return the freshly-minted plaintext token plus
 * its expiry. Never logs the plaintext.
 */
export async function mintAgentToken(
  opts: MintAgentTokenOptions,
): Promise<MintedAgentToken> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = resolveExpiresAt(opts.expiry, opts.userRequestedNever);
  const scopes = sanitizeScopes(opts.scopes, opts.allowAdmin);

  const [row] = await db
    .insert(agents)
    .values({
      user_id: opts.userId,
      tenant_id: opts.tenantId ?? null,
      user_workspace_id: opts.userWorkspaceId ?? null,
      token_hash: tokenHash,
      label: opts.label ?? null,
      scopes,
      expires_at: expiresAt,
    })
    .returning({ id: agents.id });

  return { token, agentId: row.id, tokenHash, expiresAt };
}
