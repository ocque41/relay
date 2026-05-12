import type { z } from 'zod';
import type { db } from '../db/index';
import type { ProviderCredential } from '../credentials/envelope';

/** Dependencies available to every provider method. */
export interface ProviderCtx {
  db: typeof db;
}

/** Inbound email received by the catch-all handler. */
export interface InboundEmail {
  to: string;
  from: string;
  subject: string;
  bodyText: string;
  headers: Record<string, string>;
}

/** Persisted state for a signup that is waiting for an email verification step. */
export interface PendingSignup {
  id: string;
  providerState: unknown;
}

/**
 * The result of provider.signup().
 *
 * - needsEmail: false — signup completed immediately; credentials are ready.
 * - needsEmail: true  — provider sent an email; caller should await handleVerificationEmail.
 */
export type SignupOutcome<Account> =
  | {
      needsEmail: false;
      account: Account;
      /** Stable identifier for the account on the provider (stored as external_id). */
      externalId: string;
      /** Primary credentials to encrypt and store. May be a legacy key or structured handoff object. */
      credentials: ProviderCredential;
    }
  | { needsEmail: true; pending: PendingSignup };

/** Result of provider.createApiKey(). */
export interface CreateApiKeyResult {
  /** The plaintext API key — caller is responsible for encrypting before storage. */
  key: string;
  /** Provider-side key identifier for later revocation (stored as provider_key_id). */
  providerKeyId?: string;
}

/**
 * Provider interface — each provider must implement this.
 *
 * @typeParam Input   — validated signup input (defined by inputSchema)
 * @typeParam Account — provider-specific account object returned after signup
 */
export interface Provider<Input, Account> {
  /** Unique provider identifier, e.g. "neon" or "vercel". */
  id: string;

  /**
   * 'public' (default) — surfaced in /v1/providers, /v1/index, and the MCP
   *   discovery tools. The catalog the agent sees.
   * 'demo' — registered for internal smoke tests and operator self-service,
   *   but hidden from public discovery surfaces. Pass `?include=demo` (REST)
   *   or `{ includeDemo: true }` (internal callers) to opt in.
   *
   * Tenant-registered providers always surface as public — this flag is for
   * the static registry only.
   */
  visibility?: 'public' | 'demo';

  /** Human-readable name, shown in lists and cards. Defaults to `id` if omitted. */
  displayName?: string;

  /** One-line description of what this provider does. */
  description?: string;

  /** Link to the provider's own docs (external). */
  docsUrl?: string;

  /** Provider's homepage — e.g. https://neon.tech, https://vercel.com. */
  homepage?: string;

  /** Optional npm package name if the provider ships a first-party SDK. */
  npmPackage?: string;

  /**
   * Canonical category slugs — see `CANONICAL_CATEGORIES` in ./categories.ts.
   * Populated by built-in providers directly; for tenant-registered products
   * the agent-facing registration flow validates against the same vocabulary.
   */
  categories?: string[];

  /**
   * Pricing model chip — lets an agent narrow the comparison without having
   * to follow docsUrl.
   */
  pricingModel?: 'free' | 'free-tier' | 'paid' | 'usage-based' | 'freemium';

  /** External pricing page (fallback: provider.homepage). */
  pricingUrl?: string;

  /** One-line summary of what the free tier offers, when applicable. */
  freeTierSummary?: string;

  /**
   * Capability tags — lower-case, hyphenated. Used by agents to filter within
   * a category (e.g. a `database` provider advertising `postgres`, `serverless`,
   * `branching`). Not a controlled vocabulary; providers choose their own.
   */
  capabilities?: string[];

  /**
   * Default environment variable name this provider's primary credential
   * maps to (e.g. `DATABASE_URL`, `RESEND_API_KEY`). Read by /v1/intent when
   * formatting an env block; collisions across resolutions are detected and
   * suffixed with the provider id at render time.
   */
  envVar?: string;

  /**
   * Optional: synthesise a sensible default input for /v1/intent calls,
   * which don't expose per-provider input. Receives the workspace + alias
   * so the default can be deterministic per (workspace, provider, alias)
   * tuple. When absent, /v1/intent treats the provider as un-default-able
   * and returns `status: 'no_provider'` for it (caller must hit
   * /v1/signups directly with explicit input).
   */
  defaultInputForIntent?(ctx: {
    workspaceId: string;
    workspaceSlug: string | null;
    userEmail: string | null;
    catchallAlias: string | null;
    alias: string | null;
  }): Input;

  /** Zod schema used to validate the caller's input object. */
  inputSchema: z.ZodType<Input>;

  /**
   * Provision a new account/resource on the provider.
   *
   * @param emailAddress — catch-all alias the provider may use for verification.
   */
  signup(
    ctx: ProviderCtx,
    input: Input,
    emailAddress: string,
  ): Promise<SignupOutcome<Account>>;

  /**
   * Resume a signup after receiving a verification email (optional).
   * Only required for providers that use email verification.
   */
  handleVerificationEmail?(
    ctx: ProviderCtx,
    email: InboundEmail,
    pending: PendingSignup,
  ): Promise<SignupOutcome<Account>>;

  /**
   * Mint a new API key for an existing account.
   * Returns the plaintext key and an optional provider-side key ID for later revocation.
   * Caller is responsible for encrypting the key before storage.
   */
  createApiKey(ctx: ProviderCtx, account: Account, label: string): Promise<CreateApiKeyResult>;

  /**
   * Revoke an API key by its provider-side key ID.
   */
  revokeApiKey(ctx: ProviderCtx, account: Account, keyId: string): Promise<void>;

  /**
   * Permanently delete the account/resource on the provider (optional).
   */
  teardown?(ctx: ProviderCtx, account: Account): Promise<void>;
}
