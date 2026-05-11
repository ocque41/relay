import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  __resetKeyRevealLimitForTests,
  checkKeyRevealLimit,
} from './key-reveal-limit';
import { UserRateLimited } from './signup-limit';

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  __resetKeyRevealLimitForTests();
  process.env.USER_KEY_REVEAL_DAILY_LIMIT = '3';
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

describe('checkKeyRevealLimit', () => {
  it('returns null when ABUSE_ENFORCEMENT=off', () => {
    process.env.ABUSE_ENFORCEMENT = 'off';
    expect(checkKeyRevealLimit('user-1', 'key-1')).toBeNull();
  });

  it('counts up under the cap in warn mode', () => {
    process.env.ABUSE_ENFORCEMENT = 'warn';
    expect(checkKeyRevealLimit('user-1', 'key-1')).toBe(1);
    expect(checkKeyRevealLimit('user-1', 'key-1')).toBe(2);
    expect(checkKeyRevealLimit('user-1', 'key-1')).toBe(3);
  });

  it('does not throw past the cap in warn mode', () => {
    process.env.ABUSE_ENFORCEMENT = 'warn';
    for (let i = 0; i < 4; i++) checkKeyRevealLimit('user-1', 'key-1');
    expect(() => checkKeyRevealLimit('user-1', 'key-1')).not.toThrow();
  });

  it('throws UserRateLimited past the cap in enforce mode', () => {
    process.env.ABUSE_ENFORCEMENT = 'enforce';
    for (let i = 0; i < 3; i++) checkKeyRevealLimit('user-1', 'key-1');
    expect(() => checkKeyRevealLimit('user-1', 'key-1')).toThrow(UserRateLimited);
  });

  it('counters are independent per (user, key)', () => {
    process.env.ABUSE_ENFORCEMENT = 'enforce';
    for (let i = 0; i < 3; i++) checkKeyRevealLimit('user-1', 'key-1');
    expect(() => checkKeyRevealLimit('user-1', 'key-1')).toThrow(UserRateLimited);
    // Different key — fresh counter.
    expect(checkKeyRevealLimit('user-1', 'key-2')).toBe(1);
    // Different user — fresh counter.
    expect(checkKeyRevealLimit('user-2', 'key-1')).toBe(1);
  });

  it('uses default cap of 10 when env is unset', () => {
    delete process.env.USER_KEY_REVEAL_DAILY_LIMIT;
    process.env.ABUSE_ENFORCEMENT = 'enforce';
    for (let i = 0; i < 10; i++) checkKeyRevealLimit('user-1', 'key-1');
    expect(() => checkKeyRevealLimit('user-1', 'key-1')).toThrow(UserRateLimited);
  });

  it('throws with counter=action on the UserRateLimited', () => {
    process.env.ABUSE_ENFORCEMENT = 'enforce';
    for (let i = 0; i < 3; i++) checkKeyRevealLimit('user-1', 'key-1');
    try {
      checkKeyRevealLimit('user-1', 'key-1');
    } catch (e) {
      expect(e).toBeInstanceOf(UserRateLimited);
      expect((e as UserRateLimited).counter).toBe('action');
    }
  });
});
