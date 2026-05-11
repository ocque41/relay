/**
 * Rotate MASTER_KEY by re-encrypting every bytea column in the database.
 *
 * Required env:
 *   DATABASE_URL     Neon connection string (same as the app)
 *   MASTER_KEY_OLD   Base64, 32 bytes — the key rows are currently encrypted under
 *   MASTER_KEY       Base64, 32 bytes — the new key we're rotating to
 *
 * Usage:
 *   npx tsx scripts/rotate-master-key.ts            # rotate for real
 *   npx tsx scripts/rotate-master-key.ts --dry-run  # preview only, no writes
 *
 * Idempotent: rows that already decrypt under MASTER_KEY are detected and skipped,
 * so re-running after a partial failure is safe.
 *
 * Columns rotated:
 *   - accounts.credentials_enc
 *   - api_keys.key_enc
 *
 * Strategy (one row at a time):
 *   1. Try to decrypt with MASTER_KEY_OLD.
 *   2. If that fails, try MASTER_KEY — if it works, row is already migrated; skip.
 *   3. If both fail, abort with the row id (likely key corruption / unrelated ciphertext).
 *   4. Re-encrypt the decrypted plaintext under MASTER_KEY and UPDATE the row.
 *
 * Notes:
 *   - The Neon HTTP driver does not support multi-statement transactions, so updates
 *     are per-row. Partial progress is always safe to resume.
 *   - Never logs plaintext. Only counts and row ids.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq, isNotNull } from 'drizzle-orm';
import { db } from '../src/server/db/index';
import { accounts, api_keys } from '../src/server/db/schema';

// -----------------------------------------------------------------------------
// .env loader (tsx does not auto-load)
// -----------------------------------------------------------------------------
function loadDotEnv(path: string): void {
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // .env is optional
  }
}
loadDotEnv(resolve(process.cwd(), '.env'));

// -----------------------------------------------------------------------------
// Key loading + crypto (mirrors src/server/crypto.ts but parameterized on key)
// -----------------------------------------------------------------------------
function readKey(envVar: string): Buffer {
  const raw = process.env[envVar];
  if (!raw) throw new Error(`${envVar} is not set`);
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`${envVar} must decode to 32 bytes; got ${key.length}`);
  }
  return key;
}

function tryDecrypt(ciphertext: Buffer, key: Buffer): Buffer | null {
  try {
    if (ciphertext.length < 28) return null;
    const nonce = ciphertext.subarray(0, 12);
    const tag = ciphertext.subarray(12, 28);
    const payload = ciphertext.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]);
  } catch {
    return null;
  }
}

function encryptWith(plaintext: Buffer, key: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, encrypted]);
}

// -----------------------------------------------------------------------------
// Main rotation
// -----------------------------------------------------------------------------
const DRY_RUN = process.argv.includes('--dry-run');

async function rotateTable<T extends { id: string }>(
  name: string,
  rows: T[],
  getCiphertext: (row: T) => Buffer | null,
  updateRow: (id: string, newCipher: Buffer) => Promise<unknown>,
  oldKey: Buffer,
  newKey: Buffer,
): Promise<{ migrated: number; skipped: number; failed: string[] }> {
  let migrated = 0;
  let skipped = 0;
  const failed: string[] = [];

  for (const row of rows) {
    const ct = getCiphertext(row);
    if (!ct) {
      skipped++;
      continue;
    }

    const fromOld = tryDecrypt(ct, oldKey);
    if (fromOld) {
      const newCipher = encryptWith(fromOld, newKey);
      if (!DRY_RUN) await updateRow(row.id, newCipher);
      migrated++;
      continue;
    }

    const fromNew = tryDecrypt(ct, newKey);
    if (fromNew) {
      skipped++;
      continue;
    }

    failed.push(row.id);
  }

  console.log(
    `  ${name}: migrated=${migrated} skipped(already-new)=${skipped} failed=${failed.length}`,
  );
  if (failed.length) {
    console.log(`  ${name} failed ids: ${failed.join(', ')}`);
  }
  return { migrated, skipped, failed };
}

async function main(): Promise<void> {
  const oldKey = readKey('MASTER_KEY_OLD');
  const newKey = readKey('MASTER_KEY');
  if (oldKey.equals(newKey)) {
    throw new Error('MASTER_KEY and MASTER_KEY_OLD are identical — nothing to rotate.');
  }

  console.log(`Rotating MASTER_KEY${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`);

  console.log('\naccounts.credentials_enc:');
  const accountRows = await db
    .select({ id: accounts.id, credentials_enc: accounts.credentials_enc })
    .from(accounts)
    .where(isNotNull(accounts.credentials_enc));
  const accountsResult = await rotateTable(
    'accounts',
    accountRows,
    (r) => r.credentials_enc,
    (id, newCipher) =>
      db.update(accounts).set({ credentials_enc: newCipher }).where(eq(accounts.id, id)),
    oldKey,
    newKey,
  );

  console.log('\napi_keys.key_enc:');
  const apiKeyRows = await db
    .select({ id: api_keys.id, key_enc: api_keys.key_enc })
    .from(api_keys)
    .where(isNotNull(api_keys.key_enc));
  const apiKeysResult = await rotateTable(
    'api_keys',
    apiKeyRows,
    (r) => r.key_enc,
    (id, newCipher) =>
      db.update(api_keys).set({ key_enc: newCipher }).where(eq(api_keys.id, id)),
    oldKey,
    newKey,
  );

  const totalFailed = accountsResult.failed.length + apiKeysResult.failed.length;
  console.log(
    `\nTotal: migrated=${accountsResult.migrated + apiKeysResult.migrated} ` +
      `skipped=${accountsResult.skipped + apiKeysResult.skipped} ` +
      `failed=${totalFailed}` +
      (DRY_RUN ? ' (dry run — no rows written)' : ''),
  );

  if (totalFailed > 0) {
    console.error(
      '\nOne or more rows could not be decrypted with either key. Investigate before removing MASTER_KEY_OLD.',
    );
    process.exit(2);
  }

  if (!DRY_RUN) {
    console.log(
      '\nRotation complete. You can now remove MASTER_KEY_OLD from the environment.',
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('rotate-master-key failed:', err);
    process.exit(1);
  });
