import { describe, expect, it } from 'vitest';
import {
  decodeProviderCredential,
  encodeProviderCredential,
} from './envelope';

describe('provider credential envelope', () => {
  it('keeps legacy API keys as initial_api_key', () => {
    expect(decodeProviderCredential('legacy_key')).toEqual({
      initialApiKey: 'legacy_key',
    });
  });

  it('round-trips structured handoff credentials', () => {
    const encoded = encodeProviderCredential({
      endpoint: 'https://db.example',
      database_id: 'db_123',
      data_token: 'cdb_data_123',
      admin_token: 'cdb_admin_123',
    });
    expect(decodeProviderCredential(encoded)).toEqual({
      initialCredentials: {
        endpoint: 'https://db.example',
        database_id: 'db_123',
        data_token: 'cdb_data_123',
        admin_token: 'cdb_admin_123',
      },
    });
  });
});
