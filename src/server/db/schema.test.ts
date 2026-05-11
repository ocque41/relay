import { describe, it, expect } from 'vitest';
import { api_keys, users } from './schema';

/**
 * Schema shape tests — pure column-presence checks. These exist to prevent the
 * `last_used_at` + `agent_guide*` columns from being renamed or removed without
 * a conscious test update; end-to-end migrations run against the real DB.
 */
describe('api_keys schema', () => {
  it('exposes last_used_at alongside last_revealed_at', () => {
    const cols = Object.keys(api_keys);
    expect(cols).toContain('last_used_at');
    expect(cols).toContain('last_revealed_at');
  });
});

describe('users schema', () => {
  it('exposes agent_guide + agent_guide_updated_at for per-user memory', () => {
    const cols = Object.keys(users);
    expect(cols).toContain('agent_guide');
    expect(cols).toContain('agent_guide_updated_at');
  });
});
