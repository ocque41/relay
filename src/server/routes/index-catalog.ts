/**
 * Chunked provider index — the discovery surface agents hit before deciding
 * which provider to signup against.
 *
 * Two endpoints:
 *   GET /v1/index            — small top-level: which categories exist (with
 *                              counts + the aliases agents can use)
 *   GET /v1/index/:category  — the per-category chunk: full ProviderSummary[]
 *                              including pricing + capabilities, optionally
 *                              narrowed by ?capability=… and ?pricing=…
 *
 * Public, unauthenticated, free — parallel to /openapi.json so a cold-start
 * agent can discover the catalog before it has a token. Rate-limited per IP.
 * A 60-second in-memory cache bounds DB load when lots of agents fan out on
 * discovery at the same time; tenant products registered during the cache
 * window become visible on the next TTL rollover.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { type AppEnv } from '../auth';
import { readRateLimit } from '../rate-limit';
import { listProviders, type ProviderSummary } from '../providers/index';
import {
  CANONICAL_CATEGORIES,
  CATEGORY_ALIASES,
  CATEGORY_DISPLAY_NAMES,
  isPublicCategory,
  normalizeCategoriesLoose,
  resolveCategory,
  type CanonicalCategory,
} from '../providers/categories';

const app = new OpenAPIHono<AppEnv>();

// ---------------------------------------------------------------------------
// Cache — 60s TTL, mirrors src/server/billing/charge.ts. Keeps the index
// sub-ms on warm hits no matter how many agents fan out on discovery.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  at: number;
  providers: ProviderSummary[];
}

let cache: CacheEntry | null = null;

async function loadProviders(includeDemo: boolean): Promise<ProviderSummary[]> {
  if (!cache || Date.now() - cache.at >= CACHE_TTL_MS) {
    // Always cache the full list including demos. Filtering happens at read
    // time so the include=demo opt-in doesn't double the cache footprint.
    const providers = await listProviders({ includeDemo: true });
    cache = { at: Date.now(), providers };
  }
  if (includeDemo) return cache.providers;
  return cache.providers.filter((p) => p.visibility !== 'demo');
}

export function __resetIndexCacheForTests(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function canonicalCategoriesOf(p: ProviderSummary): CanonicalCategory[] {
  return normalizeCategoriesLoose(p.categories);
}

function filterByCapability(
  providers: ProviderSummary[],
  wanted: readonly string[],
): ProviderSummary[] {
  if (wanted.length === 0) return providers;
  const needles = wanted.map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (needles.length === 0) return providers;
  return providers.filter((p) => {
    const caps = p.capabilities.map((c) => c.toLowerCase());
    return needles.every((n) => caps.includes(n));
  });
}

function filterByPricing(
  providers: ProviderSummary[],
  pricing: string | undefined,
): ProviderSummary[] {
  if (!pricing) return providers;
  return providers.filter((p) => p.pricingModel === pricing);
}

function serializeProvider(p: ProviderSummary) {
  return {
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
    inputSchema: (p.inputSchema ?? {}) as Record<string, unknown>,
    ...(p.tenantId ? { tenantId: p.tenantId } : {}),
    ...(p.needsEmailVerification !== undefined
      ? { needsEmailVerification: p.needsEmailVerification }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Shared resolvers — thin-wrapped by the MCP tools so behavior can't drift
// between the REST and MCP surfaces.
// ---------------------------------------------------------------------------
export interface CategoryEntry {
  slug: CanonicalCategory;
  displayName: string;
  count: number;
  providerIds: string[];
}

export interface IndexOverview {
  categories: CategoryEntry[];
  aliases: Record<string, CanonicalCategory>;
}

export async function computeIndexOverview(
  opts: { includeDemo?: boolean } = {},
): Promise<IndexOverview> {
  const includeDemo = opts.includeDemo === true;
  const providers = await loadProviders(includeDemo);
  const buckets = new Map<CanonicalCategory, string[]>();
  for (const p of providers) {
    for (const cat of canonicalCategoriesOf(p)) {
      const list = buckets.get(cat) ?? [];
      list.push(p.id);
      buckets.set(cat, list);
    }
  }

  const categories: CategoryEntry[] = [];
  for (const cat of CANONICAL_CATEGORIES) {
    const ids = buckets.get(cat);
    if (!ids || ids.length === 0) continue;
    // Default surface: only ship public categories (PUBLIC_CATEGORIES). The
    // include=demo opt-in unlocks every canonical category that has at
    // least one provider in it, so smoke tests and internal callers see
    // the full picture.
    if (!includeDemo && !isPublicCategory(cat)) continue;
    categories.push({
      slug: cat,
      displayName: CATEGORY_DISPLAY_NAMES[cat],
      count: ids.length,
      providerIds: [...ids].sort(),
    });
  }

  return { categories, aliases: { ...CATEGORY_ALIASES } };
}

export interface CategorySlice {
  category: CanonicalCategory;
  displayName: string;
  providers: ReturnType<typeof serializeProvider>[];
}

export async function computeCategorySlice(
  rawCategory: string,
  opts: {
    capability?: readonly string[];
    pricing?: string;
    includeDemo?: boolean;
  } = {},
): Promise<{ kind: 'ok'; slice: CategorySlice } | { kind: 'unknown' }> {
  const canonical = resolveCategory(rawCategory);
  if (!canonical) return { kind: 'unknown' };
  const all = await loadProviders(opts.includeDemo === true);
  const inCategory = all.filter((p) =>
    canonicalCategoriesOf(p).includes(canonical),
  );
  const narrowed = filterByPricing(
    filterByCapability(inCategory, opts.capability ?? []),
    opts.pricing,
  );
  return {
    kind: 'ok',
    slice: {
      category: canonical,
      displayName: CATEGORY_DISPLAY_NAMES[canonical],
      providers: narrowed.map(serializeProvider),
    },
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const CategoryEntrySchema = z
  .object({
    slug: z.string().openapi({ example: 'database' }),
    displayName: z.string().openapi({ example: 'Databases' }),
    count: z.number().int().min(1).openapi({ example: 1 }),
    providerIds: z.array(z.string()).openapi({ example: ['neon'] }),
  })
  .openapi('IndexCategoryEntry');

const IndexOverviewSchema = z
  .object({
    categories: z.array(CategoryEntrySchema),
    aliases: z.record(z.string(), z.string()),
  })
  .openapi('IndexOverview');

const ProviderEntrySchema = z
  .object({
    id: z.string(),
    kind: z.enum(['builtin', 'tenant']),
    displayName: z.string(),
    description: z.string().nullable(),
    docsUrl: z.string().url().nullable(),
    homepage: z.string().url().nullable(),
    npmPackage: z.string().nullable(),
    categories: z.array(z.string()),
    pricingModel: z
      .enum(['free', 'free-tier', 'paid', 'usage-based', 'freemium'])
      .nullable(),
    pricingUrl: z.string().url().nullable(),
    freeTierSummary: z.string().nullable(),
    capabilities: z.array(z.string()),
    inputSchema: z.record(z.string(), z.unknown()),
    tenantId: z.string().uuid().optional(),
    needsEmailVerification: z.boolean().optional(),
  })
  .openapi('IndexProviderEntry');

const CategorySliceSchema = z
  .object({
    category: z.string(),
    displayName: z.string(),
    providers: z.array(ProviderEntrySchema),
  })
  .openapi('IndexCategorySlice');

const UnknownCategoryErrorSchema = z
  .object({
    error: z.literal('unknown_category'),
    requested: z.string(),
    canonical: z.array(z.string()),
  })
  .openapi('UnknownCategoryError');

// ---------------------------------------------------------------------------
// GET /v1/index
// ---------------------------------------------------------------------------
const overviewRoute = createRoute({
  method: 'get',
  path: '/v1/index',
  tags: ['index'],
  summary: 'Provider index — top-level categories',
  description:
    'Returns the list of categories that currently hold at least one registered provider, with counts, provider ids, and the alias map agents can use for fuzzy lookups. Follow up with GET /v1/index/:category to fetch full provider details in that category. Public — no auth required. Pass ?include=demo to also surface internal demo providers.',
  middleware: [readRateLimit] as const,
  request: {
    query: z.object({
      include: z
        .enum(['demo'])
        .optional()
        .openapi({
          description:
            'Pass `demo` to also surface internal operator-self-service providers in the response.',
        }),
    }),
  },
  responses: {
    200: {
      description: 'Index overview.',
      content: { 'application/json': { schema: IndexOverviewSchema } },
    },
    429: {
      description: 'Rate limit exceeded.',
      content: {
        'application/json': {
          schema: z.object({ error: z.string(), retryAfter: z.number() }),
        },
      },
    },
  },
});

app.openapi(overviewRoute, async (c) => {
  const { include } = c.req.valid('query');
  const overview = await computeIndexOverview({ includeDemo: include === 'demo' });
  c.header('Cache-Control', 'public, max-age=60');
  return c.json(overview, 200);
});

// ---------------------------------------------------------------------------
// GET /v1/index/:category
// ---------------------------------------------------------------------------
const sliceRoute = createRoute({
  method: 'get',
  path: '/v1/index/{category}',
  tags: ['index'],
  summary: 'Provider index — per-category chunk',
  description:
    'Returns the full ProviderSummary[] (including pricingModel, capabilities, docsUrl, and inputSchema) for every provider in the requested category. Aliases are resolved server-side (e.g. "hoster" → "hosting"). Optional filters: ?capability=<tag> (repeatable, AND) and ?pricing=<model>. Public — no auth required.',
  middleware: [readRateLimit] as const,
  request: {
    params: z.object({
      category: z
        .string()
        .openapi({ example: 'database', param: { name: 'category', in: 'path' } }),
    }),
    query: z.object({
      capability: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .openapi({
          example: 'postgres',
          description:
            'Capability tag to require. Repeat the query param to AND multiple tags.',
        }),
      pricing: z
        .enum(['free', 'free-tier', 'paid', 'usage-based', 'freemium'])
        .optional(),
      include: z
        .enum(['demo'])
        .optional()
        .openapi({
          description:
            'Pass `demo` to also surface internal operator-self-service providers in the response.',
        }),
    }),
  },
  responses: {
    200: {
      description: 'Providers in this category.',
      content: { 'application/json': { schema: CategorySliceSchema } },
    },
    404: {
      description: 'Unknown category and no matching alias.',
      content: { 'application/json': { schema: UnknownCategoryErrorSchema } },
    },
    429: {
      description: 'Rate limit exceeded.',
      content: {
        'application/json': {
          schema: z.object({ error: z.string(), retryAfter: z.number() }),
        },
      },
    },
  },
});

app.openapi(sliceRoute, async (c) => {
  const { category } = c.req.valid('param');
  const q = c.req.valid('query');
  const capability = Array.isArray(q.capability)
    ? q.capability
    : q.capability
      ? [q.capability]
      : [];
  const result = await computeCategorySlice(category, {
    capability,
    pricing: q.pricing,
    includeDemo: q.include === 'demo',
  });
  if (result.kind === 'unknown') {
    return c.json(
      {
        error: 'unknown_category' as const,
        requested: category,
        canonical: [...CANONICAL_CATEGORIES],
      },
      404,
    );
  }
  c.header('Cache-Control', 'public, max-age=60');
  return c.json(result.slice, 200);
});

export default app;
