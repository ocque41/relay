import { beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { decrypt, encrypt, generateToken, hashToken } from './crypto';

describe('crypto', () => {
  beforeAll(() => {
    process.env.MASTER_KEY = randomBytes(32).toString('base64');
  });

  describe('encrypt / decrypt', () => {
    it('round-trips a UTF-8 string', () => {
      const plaintext = 'super-secret-api-key-abc123';
      const ct = encrypt(plaintext);
      expect(decrypt(ct).toString('utf8')).toBe(plaintext);
    });

    it('round-trips a raw Buffer', () => {
      const plaintext = Buffer.from([0x00, 0xff, 0x42, 0x7a, 0x13]);
      const ct = encrypt(plaintext);
      expect(Buffer.compare(decrypt(ct), plaintext)).toBe(0);
    });

    it('produces different ciphertext for the same plaintext (random nonce)', () => {
      const a = encrypt('hello');
      const b = encrypt('hello');
      expect(Buffer.compare(a, b)).not.toBe(0);
    });

    it('uses the 12+16+N layout', () => {
      const ct = encrypt('x');
      expect(ct.length).toBe(12 + 16 + 1);
    });

    it('fails with a tampered tag', () => {
      const ct = encrypt('sensitive');
      ct[15] ^= 0x01;
      expect(() => decrypt(ct)).toThrow();
    });

    it('fails when MASTER_KEY is not 32 bytes', () => {
      const prev = process.env.MASTER_KEY;
      process.env.MASTER_KEY = Buffer.alloc(16).toString('base64');
      expect(() => encrypt('x')).toThrow(/32 bytes/);
      process.env.MASTER_KEY = prev;
    });

    it('decrypts under a versioned MASTER_KEY_V2 when explicitly requested', () => {
      const prev = process.env.MASTER_KEY;
      const keyV2 = randomBytes(32).toString('base64');
      process.env.MASTER_KEY = keyV2;
      const ct = encrypt('rotated-secret');
      process.env.MASTER_KEY = prev;
      process.env.MASTER_KEY_V2 = keyV2;
      expect(decrypt(ct, 2).toString('utf8')).toBe('rotated-secret');
      delete process.env.MASTER_KEY_V2;
    });

    it('fails with a mismatched key_version (tag validation)', () => {
      const prev = process.env.MASTER_KEY;
      process.env.MASTER_KEY = randomBytes(32).toString('base64');
      const ct = encrypt('x');
      process.env.MASTER_KEY = prev;
      process.env.MASTER_KEY_V2 = randomBytes(32).toString('base64');
      expect(() => decrypt(ct, 2)).toThrow();
      delete process.env.MASTER_KEY_V2;
    });
  });

  describe('hashToken', () => {
    it('is deterministic', () => {
      const t = 'agt_test';
      expect(hashToken(t)).toBe(hashToken(t));
    });

    it('produces a 64-char hex string (sha-256)', () => {
      const h = hashToken('agt_whatever');
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });

    it('differs for different inputs', () => {
      expect(hashToken('a')).not.toBe(hashToken('b'));
    });
  });

  describe('generateToken', () => {
    it('starts with agt_ and has base64url suffix', () => {
      const t = generateToken();
      expect(t.startsWith('agt_')).toBe(true);
      expect(t.slice(4)).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('is unique across calls', () => {
      const a = generateToken();
      const b = generateToken();
      expect(a).not.toBe(b);
    });
  });
});
