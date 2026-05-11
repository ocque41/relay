import { and, eq, isNull } from 'drizzle-orm';
import { recordAudit } from '../audit';
import { db } from '../db/index';
import { api_keys, signup_jobs } from '../db/schema';
import { decrypt } from '../crypto';
import { decodeProviderCredential } from '../credentials/envelope';
import { recordRelayHandoffActivation } from '../activations/handoff';

type SignupJob = typeof signup_jobs.$inferSelect;

export interface SignupCredentialHandoff {
  delivered: boolean;
  initialApiKey?: string;
  initialCredentials?: Record<string, unknown>;
}

/**
 * Deliver the signup credential buffer exactly once.
 *
 * Providers can return either a legacy single API key or a structured
 * credential object. The workflow stores that value encrypted in
 * signup_jobs.pending_credentials_enc. This helper decrypts it, formats the
 * public response field, clears the encrypted buffer, and stamps handoff_at.
 */
export async function deliverSignupCredentialsOnce(params: {
  job: SignupJob;
  callingAgentId: string;
  callerUserId: string | null;
  via: 'rest' | 'mcp';
  deliveredAt?: Date;
}): Promise<SignupCredentialHandoff> {
  const { job, callingAgentId, callerUserId, via } = params;
  if (
    job.status !== 'complete' ||
    !job.pending_credentials_enc ||
    job.credentials_delivered_at ||
    callerUserId !== job.user_id
  ) {
    return { delivered: false };
  }

  const decoded = decodeProviderCredential(
    decrypt(job.pending_credentials_enc).toString('utf8'),
  );
  const deliveredAt = params.deliveredAt ?? new Date();

  await db
    .update(signup_jobs)
    .set({
      pending_credentials_enc: null,
      credentials_delivered_at: deliveredAt,
      handoff_at: deliveredAt,
    })
    .where(eq(signup_jobs.id, job.id));

  if (job.account_id) {
    await db
      .update(api_keys)
      .set({ last_used_at: deliveredAt })
      .where(and(eq(api_keys.account_id, job.account_id), isNull(api_keys.revoked_at)));
  }

  await recordAudit(
    callingAgentId,
    'key_deliver',
    job.id,
    { provider: job.provider_slug, via },
    { user_id: job.user_id, tenant_id: job.tenant_id },
  );
  await recordRelayHandoffActivation(job, deliveredAt);

  return {
    delivered: true,
    initialApiKey: decoded.initialApiKey,
    initialCredentials: decoded.initialCredentials,
  };
}
