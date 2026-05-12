/**
 * Email OTP: 6-digit code, hashed at rest, 10-minute TTL, rate-limited per email.
 *
 * Flow:
 *   - `generateAndSendOtp(email)` → inserts a row, sends email via Resend, returns nothing secret.
 *   - `verifyOtp(email, code)` → returns { userId, email, created } on success, or an error code.
 *
 * Rate limits:
 *   - Max 5 active (non-used, non-expired) OTPs per email at any time.
 *   - Max 5 verify attempts per OTP row before it's invalidated.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { email_otps, users } from '../db/schema';

/**
 * Generate a user-friendly inbox alias from the user's email local part + 4-char
 * random suffix. Example: "ocquema-a7bf". Collisions are retried up to 5 times.
 */
async function generateUniqueInboxAlias(email: string): Promise<string> {
  const local =
    email
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 20) || 'user';
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `${local}-${randomBytes(2).toString('hex')}`;
    const clash = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.inbox_alias, candidate))
      .limit(1);
    if (!clash[0]) return candidate;
  }
  // Fall back to pure-random alias if the local part is unlucky.
  return `user-${randomBytes(4).toString('hex')}`;
}

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ACTIVE_PER_EMAIL = 5;
const MAX_VERIFY_ATTEMPTS = 5;

export type OtpPurpose = 'login' | 'signup';

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function generateCode(): string {
  // 6-digit zero-padded decimal, cryptographically uniform on [0, 1_000_000).
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Send an OTP to the given email. Returns the plaintext code so the caller
 * can render the email body (we do NOT log or return it elsewhere).
 *
 * If rate-limited, throws with { kind: 'rate_limit' }.
 */
export async function generateOtp(
  email: string,
  purpose: OtpPurpose = 'login',
): Promise<{ code: string; expiresAt: Date }> {
  const normalized = email.trim().toLowerCase();
  const now = new Date();

  const activeRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(email_otps)
    .where(
      and(
        eq(email_otps.email, normalized),
        isNull(email_otps.used_at),
        gt(email_otps.expires_at, now),
      ),
    );

  if ((activeRows[0]?.count ?? 0) >= MAX_ACTIVE_PER_EMAIL) {
    const err = new Error('too many active OTPs for this email');
    (err as unknown as { kind: string }).kind = 'rate_limit';
    throw err;
  }

  const code = generateCode();
  const code_hash = hashCode(code);
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);

  await db.insert(email_otps).values({
    email: normalized,
    code_hash,
    purpose,
    expires_at: expiresAt,
  });

  return { code, expiresAt };
}

export type VerifyResult =
  | { ok: true; userId: string; email: string; created: boolean }
  | { ok: false; reason: 'not_found' | 'expired' | 'too_many_attempts' | 'invalid_code' };

/**
 * Verify an OTP code. On success, upserts the user row and returns userId.
 * One-shot: a successful verification marks the row `used_at = now`.
 */
export async function verifyOtp(email: string, code: string): Promise<VerifyResult> {
  const normalized = email.trim().toLowerCase();
  const now = new Date();

  // Find the most recent unused, unexpired OTP for this email.
  const rows = await db
    .select()
    .from(email_otps)
    .where(and(eq(email_otps.email, normalized), isNull(email_otps.used_at)))
    .orderBy(desc(email_otps.created_at))
    .limit(1);

  const otp = rows[0];
  if (!otp) return { ok: false, reason: 'not_found' };

  if (otp.expires_at.getTime() < now.getTime()) {
    return { ok: false, reason: 'expired' };
  }

  if (otp.attempts >= MAX_VERIFY_ATTEMPTS) {
    // Invalidate so future attempts don't keep trying.
    await db.update(email_otps).set({ used_at: now }).where(eq(email_otps.id, otp.id));
    return { ok: false, reason: 'too_many_attempts' };
  }

  const expected = hashCode(code);
  if (expected !== otp.code_hash) {
    await db
      .update(email_otps)
      .set({ attempts: otp.attempts + 1 })
      .where(eq(email_otps.id, otp.id));
    return { ok: false, reason: 'invalid_code' };
  }

  // Mark used.
  await db.update(email_otps).set({ used_at: now }).where(eq(email_otps.id, otp.id));

  // Upsert user.
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalized))
    .limit(1);

  let userId: string;
  let created = false;
  if (existing[0]) {
    userId = existing[0].id;
    await db
      .update(users)
      .set({ last_login_at: now })
      .where(eq(users.id, userId));
  } else {
    const inbox_alias = await generateUniqueInboxAlias(normalized);
    const inserted = await db
      .insert(users)
      .values({ email: normalized, last_login_at: now, inbox_alias })
      .returning({ id: users.id });
    userId = inserted[0].id;
    created = true;
  }

  // Every user has at least one personal workspace. The default workspace
  // inherits the user's `inbox_alias` so older readers and the per-workspace
  // inbox resolver agree on the alias. Idempotent so repeat logins are cheap.
  if (created) {
    const { ensureDefaultUserWorkspace } = await import('../user-workspaces');
    const [u] = await db
      .select({ inbox_alias: users.inbox_alias })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    await ensureDefaultUserWorkspace(
      userId,
      normalized,
      u?.inbox_alias ?? undefined,
    );
  }

  // Integrator-only revenue: new users get no token grant.
  return { ok: true, userId, email: normalized, created };
}
