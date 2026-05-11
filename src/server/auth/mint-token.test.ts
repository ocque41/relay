import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_TOKEN_DAYS,
  resolveExpiresAt,
  sanitizeScopes,
} from './mint-token';

describe('resolveExpiresAt', () => {
  const now = new Date('2026-04-21T00:00:00.000Z');
  const day = 86_400_000;

  it('defaults to 30 days when no expiry is given', () => {
    const out = resolveExpiresAt(undefined, undefined, now);
    expect(out).not.toBeNull();
    expect(out!.getTime() - now.getTime()).toBe(DEFAULT_AGENT_TOKEN_DAYS * day);
  });

  it('honors an explicit day count', () => {
    const out = resolveExpiresAt({ days: 7 }, false, now);
    expect(out!.getTime() - now.getTime()).toBe(7 * day);
  });

  it('clamps negative / zero days to a 1-day minimum', () => {
    const out = resolveExpiresAt({ days: 0 }, false, now);
    expect(out!.getTime() - now.getTime()).toBe(1 * day);
  });

  it('floors fractional day counts', () => {
    const out = resolveExpiresAt({ days: 7.9 }, false, now);
    expect(out!.getTime() - now.getTime()).toBe(7 * day);
  });

  it('returns null for "never" only when userRequestedNever=true', () => {
    expect(resolveExpiresAt('never', true, now)).toBeNull();
  });

  it('falls back to default 30d when "never" is asked without confirmation', () => {
    // Defense in depth: if an agent passes `expiry: 'never'` but doesn't
    // confirm the user asked for it, we mint a rotating token anyway.
    const out = resolveExpiresAt('never', false, now);
    expect(out!.getTime() - now.getTime()).toBe(DEFAULT_AGENT_TOKEN_DAYS * day);
  });

  it('falls back when confirmation flag is undefined', () => {
    const out = resolveExpiresAt('never', undefined, now);
    expect(out!.getTime() - now.getTime()).toBe(DEFAULT_AGENT_TOKEN_DAYS * day);
  });
});

describe('sanitizeScopes', () => {
  it('strips the admin scope by default', () => {
    expect(sanitizeScopes(['admin', 'user', '*'], false)).toEqual([
      'user',
      '*',
    ]);
  });

  it('keeps admin when explicitly allowed', () => {
    expect(sanitizeScopes(['admin', 'user'], true)).toEqual(['admin', 'user']);
  });

  it('handles undefined scopes', () => {
    expect(sanitizeScopes(undefined, false)).toEqual([]);
  });

  it('handles empty array', () => {
    expect(sanitizeScopes([], false)).toEqual([]);
  });

  it('preserves all other scopes including the star wildcard', () => {
    expect(sanitizeScopes(['*', 'integrator', 'agent'], false)).toEqual([
      '*',
      'integrator',
      'agent',
    ]);
  });
});
