import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Provider } from './types';
import { neonProvider } from './neon';
import { vercelProvider } from './vercel';
import { resendProvider } from './resend';
import { tenantProviderFromRow } from './tenant';
import { db } from '../db/index';
import { tenant_providers } from '../db/schema';

// ---------------------------------------------------------------------------
// Static registry — hard-coded providers loaded at module init
// ---------------------------------------------------------------------------

const registry = new Map<string, Provider<any, any>>();

/** Register a provider so it can be looked up by id. */
export function registerProvider(p: Provider<any, any>): void {
  registry.set(p.id, p);
}

// ---------------------------------------------------------------------------
// Unified lookup: static first, then DB-backed tenant providers
// ---------------------------------------------------------------------------

/**
 * Retrieve a provider by its id or tenant slug.
 * Returns undefined if neither a static provider nor a tenant_providers row matches.
 */
export async function getProvider(id: string): Promise<Provider<any, any> | undefined> {
  const staticProvider = registry.get(id);
  if (staticProvider) return staticProvider;

  const rows = await db
    .select()
    .from(tenant_providers)
    .where(eq(tenant_providers.slug, id))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;

  return tenantProviderFromRow(row);
}

export type PricingModel =
  | 'free'
  | 'free-tier'
  | 'paid'
  | 'usage-based'
  | 'freemium';

export interface ProviderSummary {
  id: string;
  kind: 'builtin' | 'tenant';
  visibility: 'public' | 'demo';
  displayName: string;
  description: string | null;
  docsUrl: string | null;
  homepage: string | null;
  npmPackage: string | null;
  categories: string[];
  pricingModel: PricingModel | null;
  pricingUrl: string | null;
  freeTierSummary: string | null;
  capabilities: string[];
  inputSchema: unknown;
  tenantId?: string;
  needsEmailVerification?: boolean;
}

function builtinSummary(p: Provider<any, any>): ProviderSummary {
  return {
    id: p.id,
    kind: 'builtin',
    visibility: p.visibility ?? 'public',
    displayName: p.displayName ?? p.id,
    description: p.description ?? null,
    docsUrl: p.docsUrl ?? null,
    homepage: p.homepage ?? null,
    npmPackage: p.npmPackage ?? null,
    categories: p.categories ?? [],
    pricingModel: p.pricingModel ?? null,
    pricingUrl: p.pricingUrl ?? null,
    freeTierSummary: p.freeTierSummary ?? null,
    capabilities: p.capabilities ?? [],
    inputSchema: zodToJsonSchema(p.inputSchema),
  };
}

function tenantRowToSummary(r: typeof tenant_providers.$inferSelect): ProviderSummary {
  return {
    id: r.slug,
    kind: 'tenant',
    visibility: 'public',
    displayName: r.display_name,
    description: r.description ?? null,
    docsUrl: r.docs_url ?? null,
    homepage: r.homepage ?? null,
    npmPackage: r.npm_package ?? null,
    categories: Array.isArray(r.categories) ? (r.categories as string[]) : [],
    pricingModel: (r.pricing_model as PricingModel | null) ?? null,
    pricingUrl: r.pricing_url ?? null,
    freeTierSummary: r.free_tier_summary ?? null,
    capabilities: Array.isArray(r.capabilities) ? (r.capabilities as string[]) : [],
    inputSchema: (r.input_schema ?? {}) as unknown,
    tenantId: r.tenant_id,
    needsEmailVerification: r.needs_email_verification,
  };
}

export interface ListProvidersOptions {
  /**
   * Include providers marked `visibility: 'demo'` in the static registry.
   * Defaults to false — demo providers (Neon, Vercel, Resend operator
   * self-service) are hidden from public discovery surfaces. Internal
   * smoke tests opt in via `?include=demo` (REST) or this flag.
   */
  includeDemo?: boolean;
}

/**
 * List all providers — both static and tenant-defined — as lightweight summaries.
 * The inputSchema is rendered via zod's toJSONSchema helper for built-in
 * providers, or the stored input_schema for tenant providers.
 *
 * By default, providers with `visibility: 'demo'` are filtered out. Pass
 * `{ includeDemo: true }` to include them (used by smoke scripts and the
 * `?include=demo` query param on the public REST surface).
 */
export async function listProviders(
  options: ListProvidersOptions = {},
): Promise<ProviderSummary[]> {
  const builtin = [...registry.values()].map(builtinSummary);
  const rows = await db.select().from(tenant_providers);
  const tenant = rows.map(tenantRowToSummary);
  const all = [...builtin, ...tenant];
  if (options.includeDemo) return all;
  return all.filter((p) => p.visibility !== 'demo');
}

/**
 * Fetch a single provider summary by id — static registry first, tenant_providers
 * second. Returns undefined when neither match.
 */
export async function getProviderSummary(id: string): Promise<ProviderSummary | undefined> {
  const staticProvider = registry.get(id);
  if (staticProvider) return builtinSummary(staticProvider);

  const rows = await db
    .select()
    .from(tenant_providers)
    .where(eq(tenant_providers.slug, id))
    .limit(1);
  const row = rows[0];
  return row ? tenantRowToSummary(row) : undefined;
}

/**
 * Convert a zod schema to a JSON Schema object using zod v4's native helper.
 * Falls back to `{}` if conversion throws (robust for weird schemas).
 */
function zodToJsonSchema(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema as z.ZodType<unknown>);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Built-in providers — registered at module init
// ---------------------------------------------------------------------------

registerProvider(neonProvider);
registerProvider(vercelProvider);
registerProvider(resendProvider);
