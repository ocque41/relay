/**
 * WebAuthn / passkey register + authenticate ceremonies.
 *
 * Uses @simplewebauthn/server. Challenges are stored in the
 * `webauthn_challenges` table (5-minute TTL) and consumed on verify.
 */
import { and, eq, gt } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { db } from '../db/index';
import { passkeys, users, webauthn_challenges } from '../db/schema';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function rpId(): string {
  return process.env.WEBAUTHN_RP_ID ?? 'localhost';
}

function rpName(): string {
  return process.env.WEBAUTHN_RP_NAME ?? 'Relay';
}

function expectedOrigin(): string | string[] {
  const o = process.env.WEBAUTHN_ORIGIN;
  if (!o) return ['http://localhost:3000'];
  // Comma-separated list allowed for supporting multiple subdomains.
  return o.split(',').map((s) => s.trim());
}

// ---------------------------------------------------------------------------
// Registration (requires an already-signed-in user)
// ---------------------------------------------------------------------------
export async function beginRegistration(userId: string): Promise<ReturnType<typeof generateRegistrationOptions>> {
  const userRows = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const user = userRows[0];
  if (!user) throw new Error('user not found');

  const existing = await db
    .select({ credential_id: passkeys.credential_id })
    .from(passkeys)
    .where(eq(passkeys.user_id, userId));

  const options = await generateRegistrationOptions({
    rpName: rpName(),
    rpID: rpId(),
    userName: user.email,
    userID: Buffer.from(userId),
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    excludeCredentials: existing.map((p) => ({
      id: Buffer.from(p.credential_id).toString('base64url'),
    })),
  });

  await db.insert(webauthn_challenges).values({
    subject: userId,
    challenge: Buffer.from(options.challenge, 'base64url'),
    purpose: 'register',
    expires_at: new Date(Date.now() + CHALLENGE_TTL_MS),
  });

  return options;
}

export async function finishRegistration(
  userId: string,
  response: RegistrationResponseJSON,
  name?: string,
): Promise<{ ok: true; passkeyId: string } | { ok: false; reason: string }> {
  const now = new Date();
  const rows = await db
    .select()
    .from(webauthn_challenges)
    .where(
      and(
        eq(webauthn_challenges.subject, userId),
        eq(webauthn_challenges.purpose, 'register'),
        gt(webauthn_challenges.expires_at, now),
      ),
    )
    .orderBy(webauthn_challenges.created_at);

  const challengeRow = rows.at(-1);
  if (!challengeRow) return { ok: false, reason: 'no_challenge' };

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challengeRow.challenge.toString('base64url'),
      expectedOrigin: expectedOrigin(),
      expectedRPID: rpId(),
    });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'verify_failed' };
  }

  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, reason: 'not_verified' };
  }

  const info = verification.registrationInfo;
  const cred = info.credential;
  const inserted = await db
    .insert(passkeys)
    .values({
      user_id: userId,
      credential_id: Buffer.from(cred.id, 'base64url'),
      public_key: Buffer.from(cred.publicKey),
      counter: cred.counter,
      transports: (cred.transports ?? []) as unknown as string[],
      name: name ?? null,
    })
    .returning({ id: passkeys.id });

  // Clean up the challenge.
  await db.delete(webauthn_challenges).where(eq(webauthn_challenges.id, challengeRow.id));

  return { ok: true, passkeyId: inserted[0].id };
}

// ---------------------------------------------------------------------------
// Authentication (login)
// ---------------------------------------------------------------------------
export async function beginAuthentication(email?: string): Promise<ReturnType<typeof generateAuthenticationOptions>> {
  // If email given, narrow to that user's passkeys; else allow any (conditional UI).
  let allowCredentials: { id: string }[] | undefined;
  let subject = email?.trim().toLowerCase() ?? '__anonymous__';
  if (email) {
    const userRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, subject))
      .limit(1);
    const user = userRows[0];
    if (user) {
      const creds = await db
        .select({ credential_id: passkeys.credential_id })
        .from(passkeys)
        .where(eq(passkeys.user_id, user.id));
      allowCredentials = creds.map((c) => ({
        id: Buffer.from(c.credential_id).toString('base64url'),
      }));
    }
  }

  const options = await generateAuthenticationOptions({
    rpID: rpId(),
    allowCredentials,
    userVerification: 'preferred',
  });

  await db.insert(webauthn_challenges).values({
    subject,
    challenge: Buffer.from(options.challenge, 'base64url'),
    purpose: 'login',
    expires_at: new Date(Date.now() + CHALLENGE_TTL_MS),
  });

  return options;
}

export async function finishAuthentication(
  response: AuthenticationResponseJSON,
  email?: string,
): Promise<{ ok: true; userId: string; email: string } | { ok: false; reason: string }> {
  const subject = email?.trim().toLowerCase() ?? '__anonymous__';
  const now = new Date();

  const rows = await db
    .select()
    .from(webauthn_challenges)
    .where(
      and(
        eq(webauthn_challenges.subject, subject),
        eq(webauthn_challenges.purpose, 'login'),
        gt(webauthn_challenges.expires_at, now),
      ),
    )
    .orderBy(webauthn_challenges.created_at);

  const challengeRow = rows.at(-1);
  if (!challengeRow) return { ok: false, reason: 'no_challenge' };

  // Find passkey by credential id
  const credIdBuf = Buffer.from(response.id, 'base64url');
  const pkRows = await db.select().from(passkeys).where(eq(passkeys.credential_id, credIdBuf)).limit(1);
  const passkey = pkRows[0];
  if (!passkey) return { ok: false, reason: 'unknown_credential' };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeRow.challenge.toString('base64url'),
      expectedOrigin: expectedOrigin(),
      expectedRPID: rpId(),
      credential: {
        id: Buffer.from(passkey.credential_id).toString('base64url'),
        publicKey: new Uint8Array(passkey.public_key),
        counter: passkey.counter,
        transports: (passkey.transports as unknown as string[]) as unknown as undefined,
      },
    });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'verify_failed' };
  }

  if (!verification.verified) return { ok: false, reason: 'not_verified' };

  // Update counter + last_used_at
  await db
    .update(passkeys)
    .set({
      counter: verification.authenticationInfo.newCounter,
      last_used_at: now,
    })
    .where(eq(passkeys.id, passkey.id));

  // Fetch user email
  const userRows = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, passkey.user_id))
    .limit(1);
  const user = userRows[0];
  if (!user) return { ok: false, reason: 'user_missing' };

  await db.update(users).set({ last_login_at: now }).where(eq(users.id, passkey.user_id));

  // Clean up the challenge.
  await db.delete(webauthn_challenges).where(eq(webauthn_challenges.id, challengeRow.id));

  return { ok: true, userId: passkey.user_id, email: user.email };
}
