/**
 * Ajv-backed JSON Schema input validation for the Actions API.
 *
 * Actions declare their input_schema as a JSON Schema (not a Zod schema —
 * integrators may be written in any language). We compile the schema
 * lazily on first use and cache the validator by `action_id + sha256(schema)`
 * so a schema edit invalidates the cache without a restart.
 */
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { createHash } from 'node:crypto';

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  coerceTypes: false,
  useDefaults: true,
});
addFormats(ajv);

const CACHE_MAX = 500;
const cache = new Map<string, ValidateFunction>();

function schemaHash(schema: unknown): string {
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex').slice(0, 16);
}

export interface ValidateResult {
  ok: boolean;
  errors?: Array<{ path: string; message: string }>;
}

export function validateActionInput(
  actionId: string,
  schema: unknown,
  value: unknown,
): ValidateResult {
  if (!schema || typeof schema !== 'object' || Object.keys(schema as object).length === 0) {
    // No schema declared — accept anything.
    return { ok: true };
  }

  const key = `${actionId}:${schemaHash(schema)}`;
  let validator = cache.get(key);
  if (!validator) {
    try {
      validator = ajv.compile(schema as Record<string, unknown>);
    } catch (err) {
      return {
        ok: false,
        errors: [{ path: '', message: `invalid schema: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
    if (cache.size >= CACHE_MAX) {
      // LRU-ish eviction: drop the oldest. Map iteration is insertion-order.
      const firstKey = cache.keys().next().value as string | undefined;
      if (firstKey) cache.delete(firstKey);
    }
    cache.set(key, validator);
  }

  const ok = validator(value);
  if (ok) return { ok: true };

  const errors = (validator.errors ?? []).map((e) => ({
    path: e.instancePath || e.schemaPath,
    message: e.message ?? 'validation failed',
  }));
  return { ok: false, errors };
}
