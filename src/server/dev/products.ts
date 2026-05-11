/**
 * Shared insertion helper for tenant products (a.k.a. tenant_providers rows).
 *
 * Both the REST route `POST /v1/dev/products` and the MCP tool
 * `register_tenant_product` call this helper so the webhook-secret minting and
 * row-insertion logic live in exactly one place.
 *
 * The plaintext webhook secret is returned exactly once. Only the AES-256-GCM
 * ciphertext is persisted (column `tenant_providers.webhook_secret_enc`).
 */
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index';
import { tenant_providers } from '../db/schema';
import { encrypt } from '../crypto';
import {
  CategoryValidationError,
  normalizeCategoriesOrThrow,
  type CanonicalCategory,
} from '../providers/categories';

export type VerificationMode = 'none' | 'relay_confirm_link' | 'integrator_email';

export type PricingModel =
  | 'free'
  | 'free-tier'
  | 'paid'
  | 'usage-based'
  | 'freemium';

const PRICING_MODELS: ReadonlySet<PricingModel> = new Set([
  'free',
  'free-tier',
  'paid',
  'usage-based',
  'freemium',
]);

export interface RegisterTenantProductArgs {
  tenantId: string;
  slug: string;
  displayName: string;
  signupWebhookUrl: string;
  teardownWebhookUrl?: string;
  verificationMode?: VerificationMode;
  inputSchema?: Record<string, unknown>;
  // Discovery metadata — all optional, surfaced via GET /v1/providers and the
  // chunked /v1/index catalog so agents can compare providers inside a
  // category without following external docs.
  description?: string;
  docsUrl?: string;
  homepage?: string;
  npmPackage?: string;
  categories?: string[];
  pricingModel?: PricingModel;
  pricingUrl?: string;
  freeTierSummary?: string;
  capabilities?: string[];
}

export interface RegisterTenantProductResult {
  id: string;
  slug: string;
  webhook_secret: string;
  /** Canonicalized categories actually persisted (aliases resolved, dedup'd). */
  categories: CanonicalCategory[];
}

/**
 * Structured, typed errors so callers (REST route, MCP tool, CLI) can translate
 * to HTTP status codes or tool-layer error payloads without string-matching.
 */
export type RegisterTenantProductError =
  | { kind: 'invalid_slug'; message: string }
  | { kind: 'slug_taken'; message: string }
  | {
      kind: 'invalid_categories';
      message: string;
      invalid: string[];
      canonical: readonly string[];
    }
  | { kind: 'invalid_pricing_model'; message: string };

export class RegisterTenantProductFailure extends Error {
  public readonly kind: RegisterTenantProductError['kind'];
  public readonly invalid?: string[];
  public readonly canonical?: readonly string[];
  constructor(err: RegisterTenantProductError) {
    super(err.message);
    this.kind = err.kind;
    this.name = 'RegisterTenantProductFailure';
    if (err.kind === 'invalid_categories') {
      this.invalid = err.invalid;
      this.canonical = err.canonical;
    }
  }
}

const SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Insert a new tenant_providers row, minting and encrypting the webhook secret.
 *
 * Returns the plaintext secret exactly once — the caller is responsible for
 * handing it to the user and then forgetting it.
 *
 * Throws `RegisterTenantProductFailure` for validation / uniqueness errors so
 * the REST layer can map `invalid_slug` → 400 and `slug_taken` → 409.
 */
export async function registerTenantProduct(
  args: RegisterTenantProductArgs,
): Promise<RegisterTenantProductResult> {
  const slug = args.slug.trim();
  if (!SLUG_RE.test(slug) || slug.length < 2 || slug.length > 60) {
    throw new RegisterTenantProductFailure({
      kind: 'invalid_slug',
      message: 'slug must match [a-z0-9-]+ and be 2-60 chars',
    });
  }

  // The `slug` column carries a global UNIQUE in the DB today, but we still
  // prefer scoping the clash check by tenant_id for clearer error messages and
  // to stay forward-compatible with the planned (tenant_id, slug) composite
  // unique constraint.
  const [clash] = await db
    .select({ slug: tenant_providers.slug })
    .from(tenant_providers)
    .where(
      and(
        eq(tenant_providers.slug, slug),
        eq(tenant_providers.tenant_id, args.tenantId),
      ),
    )
    .limit(1);
  if (clash) {
    throw new RegisterTenantProductFailure({
      kind: 'slug_taken',
      message: 'slug already taken for this tenant',
    });
  }

  // Also reject a clash against any other tenant because of the global unique
  // index — surface a deterministic 409 instead of letting the DB raise.
  const [globalClash] = await db
    .select({ slug: tenant_providers.slug })
    .from(tenant_providers)
    .where(eq(tenant_providers.slug, slug))
    .limit(1);
  if (globalClash) {
    throw new RegisterTenantProductFailure({
      kind: 'slug_taken',
      message: 'slug already taken',
    });
  }

  let canonicalCategories: CanonicalCategory[] = [];
  if (args.categories && args.categories.length > 0) {
    try {
      canonicalCategories = normalizeCategoriesOrThrow(args.categories);
    } catch (err) {
      if (err instanceof CategoryValidationError) {
        throw new RegisterTenantProductFailure({
          kind: 'invalid_categories',
          message: err.message,
          invalid: err.invalid,
          canonical: err.canonical,
        });
      }
      throw err;
    }
  }

  if (args.pricingModel !== undefined && !PRICING_MODELS.has(args.pricingModel)) {
    throw new RegisterTenantProductFailure({
      kind: 'invalid_pricing_model',
      message:
        `pricing_model must be one of: ${[...PRICING_MODELS].join(', ')}`,
    });
  }

  const capabilities = Array.isArray(args.capabilities)
    ? [
        ...new Set(
          args.capabilities
            .filter((c): c is string => typeof c === 'string')
            .map((c) => c.trim().toLowerCase())
            .filter((c) => c.length > 0),
        ),
      ]
    : [];

  const webhookSecret = randomBytes(32).toString('base64url');
  const mode: VerificationMode = args.verificationMode ?? 'relay_confirm_link';

  const [inserted] = await db
    .insert(tenant_providers)
    .values({
      tenant_id: args.tenantId,
      slug,
      display_name: args.displayName,
      signup_webhook_url: args.signupWebhookUrl,
      teardown_webhook_url: args.teardownWebhookUrl ?? null,
      webhook_secret_enc: encrypt(webhookSecret),
      input_schema: args.inputSchema ?? {},
      description: args.description ?? null,
      docs_url: args.docsUrl ?? null,
      homepage: args.homepage ?? null,
      npm_package: args.npmPackage ?? null,
      categories: canonicalCategories,
      pricing_model: args.pricingModel ?? null,
      pricing_url: args.pricingUrl ?? null,
      free_tier_summary: args.freeTierSummary ?? null,
      capabilities,
      needs_email_verification: mode !== 'none',
      verification_mode: mode,
    })
    .returning({ id: tenant_providers.id, slug: tenant_providers.slug });

  return {
    id: inserted.id,
    slug: inserted.slug,
    webhook_secret: webhookSecret,
    categories: canonicalCategories,
  };
}
