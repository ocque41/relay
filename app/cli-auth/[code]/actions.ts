'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { readSessionFromToken, SESSION_COOKIE } from '@/src/server/auth/session';
import {
  DEFAULT_AGENT_TOKEN_DAYS,
  mintAgentToken,
  type ExpiryPolicy,
} from '@/src/server/auth/mint-token';
import { db } from '@/src/server/db/index';
import { audit_log, cli_auth_codes } from '@/src/server/db/schema';

type ExpiryChoice = '30' | '90' | '365' | 'never';

/**
 * Approve a CLI device code: mint a new agent token for the authenticated
 * user, store its plaintext in cli_auth_codes so the waiting CLI can pick it
 * up via `GET /v1/cli/poll`, and mark approved_at.
 *
 * `expiry` defaults to 30 days (the secure default). The UI surfaces 30/90/365
 * radio options plus a gated "Never" option that requires explicit confirmation
 * from the human user.
 */
export async function approveCliDeviceCodeAction(
  deviceCode: string,
  expiryChoice: ExpiryChoice = '30',
  confirmNever = false,
) {
  const jar = await cookies();
  const session = await readSessionFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');

  const [row] = await db
    .select()
    .from(cli_auth_codes)
    .where(eq(cli_auth_codes.device_code, deviceCode))
    .limit(1);
  if (!row) throw new Error('unknown device code');
  if (row.expires_at.getTime() < Date.now()) throw new Error('device code expired');
  if (row.approved_at) redirect(`/cli-auth/${deviceCode}`); // idempotent

  let expiry: ExpiryPolicy = { days: DEFAULT_AGENT_TOKEN_DAYS };
  let userRequestedNever = false;
  if (expiryChoice === 'never') {
    if (!confirmNever) {
      throw new Error(
        'Tick the confirmation box to authorize a non-expiring token.',
      );
    }
    expiry = 'never';
    userRequestedNever = true;
  } else {
    const days = Number.parseInt(expiryChoice, 10);
    expiry = { days };
  }

  const minted = await mintAgentToken({
    userId: session.userId,
    label: `cli-${new Date().toISOString().slice(0, 10)}`,
    scopes: ['*'],
    expiry,
    userRequestedNever,
  });

  await db
    .update(cli_auth_codes)
    .set({
      user_id: session.userId,
      agent_id: minted.agentId,
      agent_token_plaintext: minted.token,
      approved_at: new Date(),
    })
    .where(eq(cli_auth_codes.id, row.id));

  await db.insert(audit_log).values({
    agent_id: minted.agentId,
    action: 'key_create',
    target: minted.agentId,
    metadata: {
      via: 'cli-login',
      device_code_last4: deviceCode.slice(-4),
      expires_at: minted.expiresAt ? minted.expiresAt.toISOString() : null,
    },
  });

  redirect(`/cli-auth/${deviceCode}`);
}
