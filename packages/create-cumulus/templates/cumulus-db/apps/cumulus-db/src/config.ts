// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

export interface CumulusDbConfig {
  dataDir: string;
  publicUrl: string;
  adminSecret: string | null;
  masterKey: Buffer;
  relayWebhookSecret: string | null;
  port: number;
  embeddings: {
    baseUrl: string | null;
    apiKey: string | null;
    model: string | null;
  };
}

export type CumulusDbConfigEnv = Record<string, string | undefined>;

function envValue(env: CumulusDbConfigEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function parseMasterKey(raw: string | undefined, isProduction: boolean): Buffer {
  if (!raw) {
    if (isProduction) {
      throw new Error('CUMULUS_DB_MASTER_KEY is required in production');
    }
    return Buffer.alloc(32, 7);
  }

  const asBase64 = Buffer.from(raw, 'base64');
  if (asBase64.length === 32) return asBase64;

  const asUtf8 = Buffer.from(raw, 'utf8');
  if (asUtf8.length >= 32) return asUtf8.subarray(0, 32);

  throw new Error('CUMULUS_DB_MASTER_KEY must decode to at least 32 bytes');
}

export function randomMasterKey(): string {
  return randomBytes(32).toString('base64');
}

export function loadConfig(env: CumulusDbConfigEnv = process.env): CumulusDbConfig {
  const dataDir = resolve(envValue(env, 'CUMULUS_DB_DATA_DIR') ?? '.cumulus-db-data');
  const publicUrl = (envValue(env, 'CUMULUS_DB_PUBLIC_URL') ?? 'http://localhost:4317').replace(/\/$/, '');
  const port = Number(envValue(env, 'CUMULUS_DB_PORT') ?? envValue(env, 'PORT') ?? '4317');
  const masterKey = envValue(env, 'CUMULUS_DB_MASTER_KEY');
  const isProduction = envValue(env, 'NODE_ENV') === 'production';
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('CUMULUS_DB_PORT or PORT must be a valid TCP port');
  }

  return {
    dataDir,
    publicUrl,
    adminSecret: masterKey ?? null,
    masterKey: parseMasterKey(masterKey, isProduction),
    relayWebhookSecret: envValue(env, 'CUMULUS_DB_RELAY_WEBHOOK_SECRET') ?? null,
    port,
    embeddings: {
      baseUrl: envValue(env, 'OPENAI_COMPAT_EMBEDDINGS_BASE_URL') ?? null,
      apiKey: envValue(env, 'OPENAI_COMPAT_EMBEDDINGS_API_KEY') ?? null,
      model: envValue(env, 'OPENAI_COMPAT_EMBEDDINGS_MODEL') ?? null,
    },
  };
}
