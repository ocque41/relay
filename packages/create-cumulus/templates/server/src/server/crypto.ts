import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/**
 * Application-layer AES-256-GCM with a tiny key-versioning scheme.
 *
 * Ciphertext layout is unchanged (`[nonce(12)][tag(16)][ciphertext(N)]`) —
 * the `key_version` SMALLINT column that lives alongside every encrypted
 * bytea (migration 0014) tells the decrypt path which master key to use.
 *
 * Env vars:
 *   - MASTER_KEY       — 32-byte base64, the current write key. Written rows
 *                        carry key_version = CURRENT_KEY_VERSION.
 *   - MASTER_KEY_V1    — optional; 32-byte base64 for decrypting rows written
 *                        with key_version = 1. Defaults to MASTER_KEY when
 *                        unset, matching the pre-rotation state.
 *   - MASTER_KEY_V2    — optional; used for rows with key_version = 2.
 *
 * Rotation procedure (post-launch, when/if the primary key must roll):
 *   1. Add MASTER_KEY_V2 with the new secret to Vercel env; leave MASTER_KEY
 *      pointing at the OLD secret so in-flight reads still work.
 *   2. Bump CURRENT_KEY_VERSION to 2 and redeploy; new writes use v2.
 *   3. Run scripts/rotate-master-key.ts to re-encrypt v1 rows under v2.
 *   4. Once zero v1 rows remain, drop MASTER_KEY_V1 from env and flip
 *      MASTER_KEY to point at the v2 secret.
 */

export const CURRENT_KEY_VERSION = 1;

function decodeMasterKey(raw: string, label: string): Buffer {
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`${label} must decode to 32 bytes; got ${key.length}`);
  }
  return key;
}

function getMasterKey(version: number = CURRENT_KEY_VERSION): Buffer {
  // Versioned keys take precedence; `MASTER_KEY` is the fallback so the
  // pre-rotation world (no versioned env vars) keeps working.
  const versioned = process.env[`MASTER_KEY_V${version}`];
  if (versioned) return decodeMasterKey(versioned, `MASTER_KEY_V${version}`);
  const raw = process.env.MASTER_KEY;
  if (!raw) {
    throw new Error(
      `MASTER_KEY is not set (and MASTER_KEY_V${version} not configured)`,
    );
  }
  return decodeMasterKey(raw, 'MASTER_KEY');
}

/**
 * Encrypts plaintext with AES-256-GCM under the current write key.
 *
 * Ciphertext layout: [12-byte nonce][16-byte GCM auth tag][N-byte ciphertext].
 * The key_version to store alongside the row is available as
 * CURRENT_KEY_VERSION.
 */
export function encrypt(plaintext: Buffer | string): Buffer {
  const key = getMasterKey(CURRENT_KEY_VERSION);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const input =
    typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, encrypted]);
}

/**
 * Decrypts an AES-256-GCM ciphertext. `keyVersion` defaults to the current
 * write key; callers with row-level `key_version` columns should pass the
 * stored value so rotated rows still decrypt.
 */
export function decrypt(
  ciphertext: Buffer,
  keyVersion: number = CURRENT_KEY_VERSION,
): Buffer {
  const key = getMasterKey(keyVersion);
  const nonce = ciphertext.subarray(0, 12);
  const tag = ciphertext.subarray(12, 28);
  const payload = ciphertext.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload), decipher.final()]);
}

/**
 * Returns the SHA-256 hex digest of a token string.
 * This is what gets stored in the database — never the plaintext.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Generates a new agent token: 'agt_' + 32 random bytes (base64url).
 * Show to the caller exactly once; store only the hash.
 */
export function generateToken(): string {
  return 'agt_' + randomBytes(32).toString('base64url');
}
