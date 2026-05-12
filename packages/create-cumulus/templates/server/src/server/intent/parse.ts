/**
 * Heuristic goal-to-categories parser for POST /v1/intent.
 *
 * Determinism is the product feature here — agents need reproducible
 * resolutions so they can build idempotent flows on top. We refuse to call
 * an LLM for v1; the small canonical category surface (13 slugs) lets a
 * curated phrase map cover ~95% of real prompts in O(n) and zero ms.
 *
 * The keyword map lives here (not in `categories.ts`) by design: the
 * canonical `CATEGORY_ALIASES` list explicitly forbids sub-taxonomy entries
 * like "postgres" → database. Intent parsing deals in surface phrases that
 * agents type, which is a different concern than category aliasing.
 */
import { CANONICAL_CATEGORIES, type CanonicalCategory } from '../providers/categories';

/**
 * Phrase → categories map. Keys are lowercase, may contain spaces; longer
 * phrases must come before their substrings so the longest-match-first walk
 * resolves "transactional email" before "email".
 *
 * When extending: prefer concrete domain words ("postgres", "mailing list")
 * over generic ones ("data" → could be database, storage, analytics). Add
 * a Vitest case for any new key.
 */
export const INTENT_KEYWORDS: Array<readonly [string, readonly CanonicalCategory[]]> = [
  // multi-word phrases first (order matters for longest-match)
  ['transactional email', ['email']],
  ['marketing email', ['newsletter']],
  ['email newsletter', ['newsletter']],
  ['mailing list', ['newsletter']],
  ['object storage', ['storage']],
  ['file storage', ['storage']],
  ['blob storage', ['storage']],
  ['error tracking', ['observability']],
  ['feature flags', ['saas']],
  ['vector search', ['ai', 'search']],
  ['vector store', ['ai']],
  ['llm gateway', ['ai']],
  ['model gateway', ['ai']],
  ['headless cms', ['cms']],
  ['login', ['auth']],
  ['sign in', ['auth']],
  ['sign up', ['auth']],
  ['user accounts', ['auth']],
  ['key value', ['storage']],
  ['kv store', ['storage']],

  // single-word fallbacks
  ['postgres', ['database']],
  ['postgresql', ['database']],
  ['mysql', ['database']],
  ['mongodb', ['database']],
  ['mongo', ['database']],
  ['redis', ['storage']],
  ['databases', ['database']],
  ['database', ['database']],
  ['db', ['database']],
  ['sql', ['database']],
  ['email', ['email']],
  ['emails', ['email']],
  ['mail', ['email']],
  ['transactional', ['email']],
  ['newsletter', ['newsletter']],
  ['broadcast', ['newsletter']],
  ['deploy', ['hosting']],
  ['deployment', ['hosting']],
  ['hosting', ['hosting']],
  ['vercel', ['hosting']],
  ['nextjs', ['hosting']],
  ['next.js', ['hosting']],
  ['nuxt', ['hosting']],
  ['frontend', ['hosting']],
  ['auth', ['auth']],
  ['authentication', ['auth']],
  ['identity', ['auth']],
  ['sso', ['auth']],
  ['oauth', ['auth']],
  ['storage', ['storage']],
  ['files', ['storage']],
  ['blob', ['storage']],
  ['s3', ['storage']],
  ['bucket', ['storage']],
  ['analytics', ['analytics']],
  ['metrics', ['analytics']],
  ['tracking', ['analytics']],
  ['payments', ['payments']],
  ['payment', ['payments']],
  ['billing', ['payments']],
  ['stripe', ['payments']],
  ['checkout', ['payments']],
  ['cms', ['cms']],
  ['content', ['cms']],
  ['observability', ['observability']],
  ['logging', ['observability']],
  ['logs', ['observability']],
  ['monitoring', ['observability']],
  ['telemetry', ['observability']],
  ['sentry', ['observability']],
  ['datadog', ['observability']],
  ['ai', ['ai']],
  ['llm', ['ai']],
  ['embeddings', ['ai']],
  ['ml', ['ai']],
  ['claude', ['ai']],
  ['openai', ['ai']],
  ['search', ['search']],
  ['typesense', ['search']],
  ['elastic', ['search']],
  ['algolia', ['search']],
] as const;

/**
 * Result of parsing a free-text goal.
 *
 * - `categories` is deduplicated, ordered by canonical category order
 *   (CANONICAL_CATEGORIES from categories.ts). Empty if nothing matched.
 * - `unmatched` lists tokens that didn't resolve to a category. Surfaced in
 *   the route response as `unmatchedTerms[]` so callers can debug their
 *   prompts without grepping our source.
 */
export interface ParseResult {
  categories: CanonicalCategory[];
  unmatched: string[];
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'plus',
  'with',
  'for',
  'to',
  'of',
  'on',
  'in',
  'i',
  'we',
  'need',
  'want',
  'add',
  'set',
  'up',
  'setup',
  'app',
  'application',
  'service',
  'support',
  'my',
  'our',
  'is',
  'are',
  'this',
  'that',
  'some',
  'please',
  'using',
  'use',
  'project',
  'site',
]);

/**
 * Parse a free-text goal into a deduped, canonically-ordered category list.
 *
 * Algorithm:
 *   1. Lowercase + strip punctuation.
 *   2. Walk the keyword map sorted longest-first; for each phrase, scan the
 *      input and record matches. Mark matched character ranges so a longer
 *      phrase ("transactional email") wins over a shorter one ("email").
 *   3. Tokenize the residual (unmatched) text on whitespace; drop stop
 *      words; the rest becomes `unmatched`.
 *   4. Dedup categories and sort by CANONICAL_CATEGORIES order.
 */
export function parseIntent(goal: string): ParseResult {
  const normalized = goal.toLowerCase().replace(/[^a-z0-9.\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return { categories: [], unmatched: [] };

  // Sort keywords longest-first so "transactional email" beats "email".
  const sortedKeywords = [...INTENT_KEYWORDS].sort(
    ([a], [b]) => b.length - a.length,
  );

  const matchedRanges: Array<[number, number]> = [];
  const matchedCategories = new Set<CanonicalCategory>();

  for (const [phrase, cats] of sortedKeywords) {
    let from = 0;
    while (from < normalized.length) {
      const idx = normalized.indexOf(phrase, from);
      if (idx === -1) break;
      const end = idx + phrase.length;

      // word boundaries: phrase must not be embedded inside a longer word
      const before = idx === 0 ? ' ' : normalized[idx - 1];
      const after = end === normalized.length ? ' ' : normalized[end];
      const isBoundary = /[^a-z0-9]/.test(before) && /[^a-z0-9]/.test(after);

      if (isBoundary && !overlaps(matchedRanges, idx, end)) {
        matchedRanges.push([idx, end]);
        for (const c of cats) matchedCategories.add(c);
      }
      from = end;
    }
  }

  // Build the residual string (chars not covered by any match) and tokenize.
  matchedRanges.sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  let residual = '';
  for (const [s, e] of matchedRanges) {
    if (s > cursor) residual += normalized.slice(cursor, s);
    cursor = e;
  }
  if (cursor < normalized.length) residual += normalized.slice(cursor);

  const unmatched = residual
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));

  // Dedup and order by canonical position.
  const categories = CANONICAL_CATEGORIES.filter((c) => matchedCategories.has(c));

  return { categories, unmatched };
}

function overlaps(ranges: Array<[number, number]>, s: number, e: number): boolean {
  for (const [rs, re] of ranges) {
    if (s < re && e > rs) return true;
  }
  return false;
}
