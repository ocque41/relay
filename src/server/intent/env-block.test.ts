import { describe, it, expect } from 'vitest';
import {
  formatEnvBlock,
  PENDING_SENTINEL,
  REVEAL_SENTINEL,
  type EnvResolution,
} from './env-block';

describe('formatEnvBlock', () => {
  it('orders by canonical category position then alias', () => {
    const resolutions: EnvResolution[] = [
      { category: 'email', alias: null, provider: 'resend', envVar: 'RESEND_API_KEY', status: 'existing' },
      { category: 'database', alias: 'analytics', provider: 'neon', envVar: 'DATABASE_URL_ANALYTICS', status: 'existing' },
      { category: 'database', alias: null, provider: 'neon', envVar: 'DATABASE_URL', status: 'existing' },
      { category: 'hosting', alias: null, provider: 'vercel', envVar: 'VERCEL_TOKEN', status: 'existing' },
    ];
    const r = formatEnvBlock(resolutions, 'raw');
    const lines = r.envBlock.trim().split('\n');
    expect(lines).toEqual([
      'DATABASE_URL=__reveal_required__',
      'DATABASE_URL_ANALYTICS=__reveal_required__',
      'VERCEL_TOKEN=__reveal_required__',
      'RESEND_API_KEY=__reveal_required__',
    ]);
  });

  it('uses pending sentinel for provisioning resolutions', () => {
    const resolutions: EnvResolution[] = [
      { category: 'email', alias: null, provider: 'resend', envVar: 'RESEND_API_KEY', status: 'provisioning' },
    ];
    const r = formatEnvBlock(resolutions, 'raw');
    expect(r.envBlock).toContain(`RESEND_API_KEY=${PENDING_SENTINEL}`);
  });

  it('uses reveal sentinel for existing-with-no-value', () => {
    const resolutions: EnvResolution[] = [
      { category: 'database', alias: null, provider: 'neon', envVar: 'DATABASE_URL', status: 'existing' },
    ];
    const r = formatEnvBlock(resolutions, 'raw');
    expect(r.envBlock).toContain(`DATABASE_URL=${REVEAL_SENTINEL}`);
  });

  it('emits inline plaintext when value is supplied (fresh signup)', () => {
    const resolutions: EnvResolution[] = [
      {
        category: 'database',
        alias: null,
        provider: 'neon',
        envVar: 'DATABASE_URL',
        status: 'provisioning',
        value: 'postgres://user:pass@host/db',
      },
    ];
    const r = formatEnvBlock(resolutions, 'raw');
    expect(r.envBlock).toContain('DATABASE_URL=postgres://user:pass@host/db');
  });

  it('quotes values with whitespace or special chars', () => {
    const resolutions: EnvResolution[] = [
      {
        category: 'database',
        alias: null,
        provider: 'neon',
        envVar: 'DATABASE_URL',
        status: 'provisioning',
        value: 'value with spaces "and quotes"',
      },
    ];
    const r = formatEnvBlock(resolutions, 'raw');
    expect(r.envBlock).toContain('DATABASE_URL="value with spaces \\"and quotes\\""');
  });

  it('skips no_provider and ambiguous resolutions from the block', () => {
    const resolutions: EnvResolution[] = [
      { category: 'database', alias: null, provider: 'neon', envVar: 'DATABASE_URL', status: 'existing' },
      { category: 'analytics', alias: null, provider: '', envVar: undefined, status: 'no_provider' },
      { category: 'auth', alias: null, provider: '', envVar: undefined, status: 'ambiguous' },
    ];
    const r = formatEnvBlock(resolutions, 'raw');
    const lines = r.envBlock.trim().split('\n').filter((l) => l.length > 0);
    expect(lines).toEqual(['DATABASE_URL=__reveal_required__']);
  });

  it('detects env-var collisions and suffixes with provider id', () => {
    const resolutions: EnvResolution[] = [
      { category: 'email', alias: null, provider: 'resend', envVar: 'EMAIL_API_KEY', status: 'existing' },
      { category: 'email', alias: 'marketing', provider: 'postmark', envVar: 'EMAIL_API_KEY', status: 'existing' },
    ];
    const r = formatEnvBlock(resolutions, 'raw');
    expect(r.envBlock).toContain('EMAIL_API_KEY_RESEND=');
    expect(r.envBlock).toContain('EMAIL_API_KEY_POSTMARK=');
    expect(r.notes.length).toBe(1);
    expect(r.notes[0]).toContain('EMAIL_API_KEY');
    expect(r.finalEnvVars[0]).toBe('EMAIL_API_KEY_RESEND');
    expect(r.finalEnvVars[1]).toBe('EMAIL_API_KEY_POSTMARK');
  });

  it('returns empty block when there is nothing to emit', () => {
    expect(formatEnvBlock([], 'raw').envBlock).toBe('');
  });

  it('rejects unsupported envStyle', () => {
    expect(() => formatEnvBlock([], 'next' as never)).toThrow();
  });

  it('produces byte-identical output for the same input (determinism)', () => {
    const resolutions: EnvResolution[] = [
      { category: 'email', alias: null, provider: 'resend', envVar: 'RESEND_API_KEY', status: 'existing' },
      { category: 'database', alias: null, provider: 'neon', envVar: 'DATABASE_URL', status: 'existing' },
    ];
    const a = formatEnvBlock(resolutions, 'raw');
    const b = formatEnvBlock(resolutions, 'raw');
    expect(a.envBlock).toBe(b.envBlock);
  });
});
