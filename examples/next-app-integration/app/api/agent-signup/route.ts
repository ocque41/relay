/**
 * Relay agent-signup webhook handler.
 *
 * This single file is the entire Relay integration. Drop it into your existing
 * Next.js app — your login flow, user model, and database stay untouched.
 */
import { relay } from '@cumulus/server';
import * as userDb from '@/lib/user-db';

export const POST = relay.webhook({
  secret: process.env.RELAY_WEBHOOK_SECRET!,

  /**
   * An AI agent initiated a signup on behalf of a human user. Create the
   * user in your DB + issue an API key. Return the ids so Relay can store
   * them and hand the key to the agent once.
   */
  onSignup: async ({ email, input, signupId }) => {
    const user = await userDb.createUser({
      email,
      name: (input.name as string | undefined) ?? null,
      source: `relay:${signupId}`,
    });
    const apiKey = await userDb.issueApiKey(user.id, 'initial');
    return { accountId: user.id, apiKey };
  },

  /**
   * Optional: mint additional API keys post-signup.
   */
  onCreateApiKey: async ({ account_id, label }) => {
    const key = await userDb.issueApiKey(account_id, label);
    return { key };
  },

  /**
   * Optional: revoke keys.
   */
  onRevokeApiKey: async ({ account_id, key_id }) => {
    await userDb.revokeApiKey(account_id, key_id);
  },

  /**
   * Optional: called when the user deletes the account from Relay.
   */
  onTeardown: async ({ account_id }) => {
    await userDb.deleteUser(account_id);
  },
});
