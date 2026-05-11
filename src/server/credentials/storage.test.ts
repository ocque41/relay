import { describe, expect, it } from 'vitest';
import { credentialForAccountStorage } from './storage';

describe('credentialForAccountStorage', () => {
  it('keeps built-in provider credentials encrypted on the account row', () => {
    expect(
      credentialForAccountStorage({
        tenantId: null,
        credential: 'postgres://example',
      }),
    ).toBe('postgres://example');
  });

  it('does not persist tenant legacy apiKey credentials on the account row', () => {
    expect(
      credentialForAccountStorage({
        tenantId: 'tenant-1',
        credential: 'legacy_api_key',
      }),
    ).toBeNull();
  });

  it('does not persist tenant structured Cumulus credentials on the account row', () => {
    expect(
      credentialForAccountStorage({
        tenantId: 'tenant-1',
        credential: {
          endpoint: 'https://db.cumulush.com',
          database_id: 'db_123',
          data_token: 'cdb_data_123',
          admin_token: 'cdb_admin_123',
        },
      }),
    ).toBeNull();
  });
});
