import { db } from '../db/index';
import { activations, signup_jobs } from '../db/schema';

type SignupJob = typeof signup_jobs.$inferSelect;

export async function recordRelayHandoffActivation(
  job: SignupJob,
  occurredAt: Date,
): Promise<void> {
  if (!job.tenant_id) return;
  await db
    .insert(activations)
    .values({
      tenant_id: job.tenant_id,
      signup_id: job.id,
      account_id: job.account_id ?? null,
      external_user_id: null,
      provider_key_id: null,
      event_name: 'relay_handoff',
      occurred_at: occurredAt,
      idempotency_key: `relay_handoff:${job.id}`,
      metadata_redacted: {
        source: 'relay',
        provider: job.provider_slug,
      },
      is_24h: true,
      is_7d: true,
    })
    .onConflictDoNothing({
      target: [activations.tenant_id, activations.idempotency_key],
    });
}
