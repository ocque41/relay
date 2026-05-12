import { randomBytes, randomUUID } from 'node:crypto';
import { relay } from '@/src/relay/webhook';

function demoApiKey() {
  return 'ck_' + randomBytes(24).toString('base64url');
}

export const POST = relay.webhook({
  secret: process.env.RELAY_WEBHOOK_SECRET ?? 'dev-only-replace-me',
  onSignup: async ({ email, input }) => {
    const name = typeof input.name === 'string' ? input.name : email;
    return {
      accountId: `acct_${randomUUID()}`,
      apiKey: demoApiKey(),
      externalId: name,
    };
  },
  onCreateApiKey: async () => {
    return { key: demoApiKey() };
  },
  onRevokeApiKey: async () => {
    return;
  },
  onTeardown: async () => {
    return;
  },
});
