/**
 * Regression suite for the inbound-email parser. The email-verified signup
 * workflow depends on these helpers extracting the right link/code from a
 * provider's verification email. Any change to the regexes needs a test.
 */
import { describe, expect, it } from 'vitest';
import {
  extractVerificationCode,
  extractVerificationLink,
  parseEmailAlias,
} from './parse';

describe('extractVerificationLink', () => {
  it('returns null for empty input', () => {
    expect(extractVerificationLink('')).toBeNull();
    expect(extractVerificationLink(undefined as unknown as string)).toBeNull();
  });

  it('returns null when no URL contains a verification keyword', () => {
    expect(
      extractVerificationLink(
        'Welcome to Wahoo. Your account is live at https://wahoo.example.com/dashboard',
      ),
    ).toBeNull();
  });

  it('extracts a /verify link', () => {
    const body = 'Click to finish: https://example.com/auth/verify?token=abc123';
    expect(extractVerificationLink(body)).toBe(
      'https://example.com/auth/verify?token=abc123',
    );
  });

  it('extracts a /confirm link', () => {
    const body = 'Confirm your email: https://provider.io/confirm/foo-bar';
    expect(extractVerificationLink(body)).toBe(
      'https://provider.io/confirm/foo-bar',
    );
  });

  it('extracts a magic-link URL', () => {
    const body = 'https://magic.example.dev/magic-link?t=xyz';
    expect(extractVerificationLink(body)).toBe(
      'https://magic.example.dev/magic-link?t=xyz',
    );
  });

  it('returns the FIRST matching URL when multiple are present', () => {
    const body =
      'First: https://one.example/activate?x=1 — Second: https://two.example/verify?y=2';
    expect(extractVerificationLink(body)).toBe(
      'https://one.example/activate?x=1',
    );
  });

  it('trims trailing punctuation', () => {
    const body = 'See https://example.com/verify?id=42.';
    expect(extractVerificationLink(body)).toBe(
      'https://example.com/verify?id=42',
    );
  });

  it('skips matching the keyword when it appears only in non-URL prose', () => {
    const body =
      'Click here to verify: https://example.com/dashboard — you are all set.';
    expect(extractVerificationLink(body)).toBeNull();
  });
});

describe('extractVerificationCode', () => {
  it('returns null for empty input', () => {
    expect(extractVerificationCode('')).toBeNull();
    expect(extractVerificationCode(undefined as unknown as string)).toBeNull();
  });

  it('extracts a 6-digit OTP surrounded by prose', () => {
    expect(
      extractVerificationCode('Your code is 482917 (expires in 10 minutes).'),
    ).toBe('482917');
  });

  it('extracts a 4-digit OTP', () => {
    expect(extractVerificationCode('Code: 1234')).toBe('1234');
  });

  it('does not extract digits longer than 8', () => {
    // 9+ digits is not a valid OTP shape in this codebase.
    expect(extractVerificationCode('Invoice: 123456789')).toBeNull();
  });

  it('does not extract digits embedded in alphanumeric tokens', () => {
    expect(extractVerificationCode('sess_abc123456def')).toBeNull();
  });

  it('returns the FIRST matching run of digits', () => {
    expect(extractVerificationCode('first 1234 then 5678')).toBe('1234');
  });
});

describe('parseEmailAlias', () => {
  it('returns null for non-signup addresses', () => {
    expect(parseEmailAlias('hello@example.com')).toBeNull();
    expect(parseEmailAlias('')).toBeNull();
  });

  it('extracts the signup id from a canonical signup alias', () => {
    expect(
      parseEmailAlias('signup-abc123@signups.example.com'),
    ).toBe('abc123');
  });

  it('handles UUID-shaped ids', () => {
    expect(
      parseEmailAlias(
        'signup-11111111-2222-3333-4444-555555555555@signups.example.com',
      ),
    ).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('is case-insensitive on the "signup-" prefix', () => {
    expect(parseEmailAlias('SIGNUP-abc@mail.example')).toBe('abc');
  });

  it('ignores anything after the @', () => {
    // Two different local-parts on the same domain produce different ids.
    expect(parseEmailAlias('signup-one@x.example')).toBe('one');
    expect(parseEmailAlias('signup-two@x.example')).toBe('two');
  });
});
