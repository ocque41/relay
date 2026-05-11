import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../crypto';
import { tenantProviderFromRow } from './tenant';

const masterKey = Buffer.alloc(32, 11).toString('base64');

describe('tenantProviderFromRow', () => {
  const originalMasterKey = process.env.MASTER_KEY;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.MASTER_KEY = masterKey;
  });

  afterEach(() => {
    if (originalMasterKey === undefined) delete process.env.MASTER_KEY;
    else process.env.MASTER_KEY = originalMasterKey;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends the Relay signup job id to no-verification tenant providers', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    global.fetch = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          accountId: 'db_123',
          externalId: 'db_123',
          credentials: { endpoint: 'https://db.example.com' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const provider = tenantProviderFromRow({
      slug: 'cumulus-database',
      tenant_id: 'tenant-1',
      signup_webhook_url: 'https://provider.example.test/signup',
      teardown_webhook_url: null,
      webhook_secret_enc: encrypt('secret'),
      needs_email_verification: false,
      display_name: 'Cumulus Database',
    } as never);

    const signupJobId = '11111111-1111-4111-8111-111111111111';
    await provider.signup(
      { db: {} as never },
      { email: 'test@example.com' },
      `signup-${signupJobId}@inbox.cumulush.com`,
    );

    expect(bodies[0]?.signupId).toBe(signupJobId);
  });
});
