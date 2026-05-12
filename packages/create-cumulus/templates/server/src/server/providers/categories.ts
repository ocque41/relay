/**
 * Canonical provider categories + alias map used by the chunked provider index.
 *
 * The public /v1/index surface and its MCP equivalents (`list_categories`,
 * `list_providers_by_category`) let agents fetch the catalog in slices by
 * category instead of shipping every provider on every discovery call.
 *
 * `CANONICAL_CATEGORIES` is the only source of truth — both `registerTenantProduct`
 * (write side) and the index routes (read side) normalize through the helpers
 * below so agents can ask for fuzzy variants (`hoster`, `mail`, `db`) and still
 * reach the right bucket.
 *
 * When adding a new canonical slug, also add:
 *   - A display label in `CATEGORY_DISPLAY_NAMES`
 *   - Any likely alternate terms in `CATEGORY_ALIASES`
 *   - A short blurb on the public /docs/agent-builders page
 */

export const CANONICAL_CATEGORIES = [
  'database',
  'hosting',
  'email',
  'newsletter',
  'auth',
  'storage',
  'analytics',
  'payments',
  'cms',
  'observability',
  'ai',
  'search',
  'saas',
] as const;

export type CanonicalCategory = (typeof CANONICAL_CATEGORIES)[number];

/**
 * The subset of CANONICAL_CATEGORIES that's surfaced in the public discovery
 * overview at /v1/index (and the MCP `list_categories` tool). Registration
 * still accepts the full canonical set — a tenant can register a product
 * under any canonical slug — but until at least one public provider exists
 * in a category, that category is hidden from the marketing-facing index.
 *
 * Sprint scope now includes the Cumulus Database provider wedge, so `ai` and
 * `database` both appear in public category discovery.
 */
export const PUBLIC_CATEGORIES: ReadonlySet<CanonicalCategory> = new Set([
  'ai',
  'database',
]);

export function isPublicCategory(c: CanonicalCategory): boolean {
  return PUBLIC_CATEGORIES.has(c);
}

export const CATEGORY_DISPLAY_NAMES: Record<CanonicalCategory, string> = {
  database: 'Databases',
  hosting: 'Hosting',
  email: 'Email',
  newsletter: 'Newsletters',
  auth: 'Authentication',
  storage: 'Storage',
  analytics: 'Analytics',
  payments: 'Payments',
  cms: 'CMS',
  observability: 'Observability',
  ai: 'AI',
  search: 'Search',
  saas: 'Other SaaS',
};

/**
 * Alternate terms that resolve to a canonical slug. Agents use whatever word
 * came out of the user's prompt; the index resolves before filtering.
 *
 * Keep this narrow — every alias is a promise that the target category is
 * stable. Prefer aliasing real synonyms (`hoster`/`host` → `hosting`) over
 * sub-taxonomies (`postgres` belongs in `capabilities`, not here).
 */
export const CATEGORY_ALIASES: Record<string, CanonicalCategory> = {
  db: 'database',
  databases: 'database',
  sql: 'database',
  host: 'hosting',
  hoster: 'hosting',
  hosts: 'hosting',
  deployment: 'hosting',
  deploy: 'hosting',
  mail: 'email',
  emails: 'email',
  transactional: 'email',
  newsletters: 'newsletter',
  broadcast: 'newsletter',
  authentication: 'auth',
  identity: 'auth',
  sso: 'auth',
  'object-storage': 'storage',
  blob: 'storage',
  files: 'storage',
  metrics: 'analytics',
  telemetry: 'observability',
  logs: 'observability',
  logging: 'observability',
  monitoring: 'observability',
  payment: 'payments',
  billing: 'payments',
  content: 'cms',
  llm: 'ai',
  ml: 'ai',
  embeddings: 'ai',
};

const CANONICAL_SET: ReadonlySet<CanonicalCategory> = new Set(
  CANONICAL_CATEGORIES,
);

function isCanonical(input: string): input is CanonicalCategory {
  return CANONICAL_SET.has(input as CanonicalCategory);
}

/**
 * Lowercase, trim, and resolve a single user-supplied category string to a
 * canonical slug. Returns `null` when the input is neither canonical nor a
 * known alias.
 */
export function resolveCategory(input: string): CanonicalCategory | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;
  if (isCanonical(normalized)) return normalized;
  return CATEGORY_ALIASES[normalized] ?? null;
}

export class CategoryValidationError extends Error {
  public readonly invalid: string[];
  public readonly canonical: readonly CanonicalCategory[];
  constructor(invalid: string[]) {
    super(
      `invalid categories: ${invalid.join(', ')}. ` +
        `Canonical: ${CANONICAL_CATEGORIES.join(', ')}`,
    );
    this.invalid = invalid;
    this.canonical = CANONICAL_CATEGORIES;
    this.name = 'CategoryValidationError';
  }
}

/**
 * Validate and normalize a set of categories supplied at registration time.
 * Deduplicates, resolves aliases, and throws `CategoryValidationError` with
 * the list of unresolvable inputs when any fail.
 *
 * Empty input returns `[]` — integrators may register a product without any
 * category and it simply won't appear in the per-category index slices.
 */
export function normalizeCategoriesOrThrow(
  inputs: readonly string[],
): CanonicalCategory[] {
  const resolved: CanonicalCategory[] = [];
  const invalid: string[] = [];
  const seen = new Set<CanonicalCategory>();

  for (const raw of inputs) {
    if (typeof raw !== 'string') {
      invalid.push(String(raw));
      continue;
    }
    const canonical = resolveCategory(raw);
    if (!canonical) {
      invalid.push(raw);
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    resolved.push(canonical);
  }

  if (invalid.length > 0) {
    throw new CategoryValidationError(invalid);
  }
  return resolved;
}

/**
 * Best-effort normalization for legacy / imported data that may carry
 * free-form category strings. Unlike `normalizeCategoriesOrThrow`, this one
 * silently drops unresolvable inputs instead of throwing. Used by the read
 * path so rows written before the vocabulary was enforced still render
 * sensibly in the index.
 */
export function normalizeCategoriesLoose(
  inputs: readonly unknown[],
): CanonicalCategory[] {
  const out: CanonicalCategory[] = [];
  const seen = new Set<CanonicalCategory>();
  for (const raw of inputs) {
    if (typeof raw !== 'string') continue;
    const canonical = resolveCategory(raw);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}
