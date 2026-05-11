/**
 * Provider-within-category selector for POST /v1/intent.
 *
 * Picks the "best" provider for a category when the caller didn't `pin` a
 * specific one. Deterministic (no random tie-breaking) so two intent calls
 * with the same goal at the same point in time always resolve identically.
 *
 * Tie-break order:
 *   1. pricingModel:  free > free-tier > freemium > usage-based > paid
 *   2. id (alphabetical)
 *
 * Returns `{ kind: 'one', provider }` for an unambiguous pick,
 *         `{ kind: 'ambiguous', candidates }` when 2+ providers tie at the
 *           top of the pricing ladder (caller must `pin` to disambiguate),
 *         `{ kind: 'none' }` when zero providers serve the category.
 */

export interface SelectableProvider {
  id: string;
  pricingModel?: 'free' | 'free-tier' | 'paid' | 'usage-based' | 'freemium' | null;
  categories?: string[] | null;
}

export type SelectResult<P extends SelectableProvider> =
  | { kind: 'one'; provider: P }
  | { kind: 'ambiguous'; candidates: P[] }
  | { kind: 'none' };

const PRICING_RANK: Record<NonNullable<SelectableProvider['pricingModel']>, number> = {
  free: 0,
  'free-tier': 1,
  freemium: 2,
  'usage-based': 3,
  paid: 4,
};

const DEFAULT_RANK = PRICING_RANK['paid'] + 1;

function rankFor(p: SelectableProvider): number {
  return p.pricingModel ? PRICING_RANK[p.pricingModel] : DEFAULT_RANK;
}

function hasCategory(p: SelectableProvider, category: string): boolean {
  return Array.isArray(p.categories) && p.categories.includes(category);
}

/**
 * Filter `providers` to those serving `category`, then apply the tie-break.
 */
export function selectProvider<P extends SelectableProvider>(
  category: string,
  providers: readonly P[],
): SelectResult<P> {
  const candidates = providers.filter((p) => hasCategory(p, category));
  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length === 1) return { kind: 'one', provider: candidates[0] };

  const sorted = [...candidates].sort((a, b) => {
    const ra = rankFor(a);
    const rb = rankFor(b);
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });

  // If the top two share the same rank, callers must pin.
  const topRank = rankFor(sorted[0]);
  const tied = sorted.filter((p) => rankFor(p) === topRank);
  if (tied.length > 1) return { kind: 'ambiguous', candidates: tied };

  return { kind: 'one', provider: sorted[0] };
}
