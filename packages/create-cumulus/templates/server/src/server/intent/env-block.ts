/**
 * Deterministic env-block formatter for POST /v1/intent.
 *
 * Sorts resolutions by canonical category order, then alias, so two intent
 * calls that resolve to the same set always produce a byte-identical
 * `envBlock`. Agents diff these.
 *
 * Collision handling: when two resolutions declare the same `envVar`
 * (possible when integrators register custom providers that both want
 * `EMAIL_API_KEY`), suffix with the provider id (`EMAIL_API_KEY_RESEND`)
 * and emit a note so the caller can rename in their app config.
 */
import { CANONICAL_CATEGORIES, type CanonicalCategory } from '../providers/categories';

export type EnvStyle = 'raw';

export const SUPPORTED_ENV_STYLES: readonly EnvStyle[] = ['raw'] as const;

export const PENDING_SENTINEL = '__pending__';
export const REVEAL_SENTINEL = '__reveal_required__';

export interface EnvResolution {
  category: CanonicalCategory | string;
  alias: string | null;
  provider: string;
  /**
   * The env var name this resolution maps to. Required for resolutions that
   * have a credential to surface; absent for `no_provider` / `ambiguous`
   * statuses (those are skipped from the env block entirely).
   */
  envVar?: string;
  /** Plaintext credential, when available (fresh signup, reveal-once first read). */
  value?: string | null;
  /** Status determines which sentinel is used when `value` is absent. */
  status: 'existing' | 'provisioning' | 'ambiguous' | 'no_provider';
}

export interface FormatResult {
  envBlock: string;
  /**
   * Per-resolution env var name as it appears in the block, after any
   * collision suffixing. Same length and order as the input array.
   */
  finalEnvVars: Array<string | null>;
  /** Human-readable warnings (collisions, etc.). Appended to the route's `notes[]`. */
  notes: string[];
}

const CATEGORY_ORDER: Record<string, number> = Object.fromEntries(
  CANONICAL_CATEGORIES.map((c, i) => [c as string, i]),
);

function categoryRank(c: string): number {
  return CATEGORY_ORDER[c] ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Sort resolutions in a stable canonical order:
 *   1. Category position in CANONICAL_CATEGORIES
 *   2. Alias (NULL last so the primary account leads)
 *   3. Provider id
 *
 * Returns a *new* array of `{ resolution, originalIndex }` so the route can
 * align `finalEnvVars` back to its input ordering.
 */
function sortResolutions(
  resolutions: readonly EnvResolution[],
): Array<{ r: EnvResolution; originalIndex: number }> {
  return resolutions
    .map((r, i) => ({ r, originalIndex: i }))
    .sort((a, b) => {
      const ca = categoryRank(a.r.category);
      const cb = categoryRank(b.r.category);
      if (ca !== cb) return ca - cb;
      const aa = a.r.alias ?? '';
      const ab = b.r.alias ?? '';
      if (aa !== ab) {
        // NULL/empty alias (the "primary") leads.
        if (aa === '') return -1;
        if (ab === '') return 1;
        return aa.localeCompare(ab);
      }
      return a.r.provider.localeCompare(b.r.provider);
    });
}

export function formatEnvBlock(
  resolutions: readonly EnvResolution[],
  style: EnvStyle,
): FormatResult {
  if (style !== 'raw') {
    throw new Error(`unsupported envStyle: ${style}`);
  }

  const finalEnvVars: Array<string | null> = new Array(resolutions.length).fill(null);
  const notes: string[] = [];

  // Group by base envVar to detect collisions.
  const byBaseVar = new Map<string, Array<{ r: EnvResolution; originalIndex: number }>>();
  const sorted = sortResolutions(resolutions);

  for (const item of sorted) {
    const base = item.r.envVar;
    if (!base) continue;
    if (item.r.status === 'no_provider' || item.r.status === 'ambiguous') continue;
    const list = byBaseVar.get(base) ?? [];
    list.push(item);
    byBaseVar.set(base, list);
  }

  const lines: string[] = [];

  for (const item of sorted) {
    const r = item.r;
    if (!r.envVar) continue;
    if (r.status === 'no_provider' || r.status === 'ambiguous') continue;

    const collisionGroup = byBaseVar.get(r.envVar) ?? [];
    let finalVar = r.envVar;
    if (collisionGroup.length > 1) {
      finalVar = `${r.envVar}_${r.provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    }

    finalEnvVars[item.originalIndex] = finalVar;

    let value: string;
    if (typeof r.value === 'string' && r.value.length > 0) {
      value = r.value;
    } else if (r.status === 'provisioning') {
      value = PENDING_SENTINEL;
    } else {
      value = REVEAL_SENTINEL;
    }
    lines.push(`${finalVar}=${escapeEnvValue(value)}`);
  }

  // One note per collided base var, deduped.
  const seenCollisions = new Set<string>();
  for (const [base, group] of byBaseVar) {
    if (group.length > 1 && !seenCollisions.has(base)) {
      seenCollisions.add(base);
      notes.push(
        `multiple providers want ${base}; emitted one var per provider with the provider id suffix — rename in your app config if needed`,
      );
    }
  }

  return {
    envBlock: lines.length === 0 ? '' : lines.join('\n') + '\n',
    finalEnvVars,
    notes,
  };
}

/**
 * Quote env values that contain characters which would be ambiguous under
 * dotenv: spaces, `#`, quotes, or any control char. Otherwise emit raw.
 * Sentinels are always raw (deterministic, no quotes).
 */
function escapeEnvValue(v: string): string {
  if (v === PENDING_SENTINEL || v === REVEAL_SENTINEL) return v;
  if (/[\s"#\\$`]/.test(v)) {
    return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return v;
}
