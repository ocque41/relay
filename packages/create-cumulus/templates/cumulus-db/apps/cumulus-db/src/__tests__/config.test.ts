// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

const masterKey = Buffer.alloc(32, 8).toString('base64');

describe('loadConfig', () => {
  it('uses Render PORT when CUMULUS_DB_PORT is not set', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      CUMULUS_DB_MASTER_KEY: masterKey,
      PORT: '10000',
    });

    expect(config.port).toBe(10000);
  });

  it('lets CUMULUS_DB_PORT override PORT', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      CUMULUS_DB_MASTER_KEY: masterKey,
      CUMULUS_DB_PORT: '12000',
      PORT: '10000',
    });

    expect(config.port).toBe(12000);
  });

  it('accepts narrow env objects in tests and generated code', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      CUMULUS_DB_MASTER_KEY: masterKey,
    });

    expect(config.port).toBe(4317);
  });
});
