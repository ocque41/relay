/**
 * Attestation JWT: Relay → integrator.
 *
 * The integrator keeps its own auth. Relay hands it a short-lived, publicly
 * verifiable JWT that identifies the Relay-side caller (human + optional
 * agent) and pins the token to a specific tenant (aud). The integrator
 * verifies via Relay's JWKS, matches aud against its own tenantId, and then
 * issues its OWN session cookie. Relay never sets cookies on integrator
 * domains.
 *
 * Signing: RS256. Asymmetric is non-negotiable here — an HMAC secret would
 * have to be shared with every integrator, which defeats the whole model.
 *
 * Key material: `RELAY_JWT_PRIVATE_KEY` is a base64-encoded PKCS#8 PEM. The
 * matching public key is derived via jose's exportJWK and published at
 * /.well-known/jwks.json. One active key; rotation is a future concern.
 *
 * Generate a keypair once and paste the private key into the env:
 *   openssl genpkey -algorithm RSA -pkcs8 -out relay-jwt.pem \
 *     -pkeyopt rsa_keygen_bits:2048
 *   base64 -i relay-jwt.pem | tr -d '\n'
 */
import { SignJWT, importPKCS8, exportJWK, type JWK } from 'jose';
import { createHash } from 'node:crypto';

const ALG = 'RS256';
const TTL_SECONDS = 5 * 60; // 5 minutes — short enough to be single-use in practice.
const ISSUER = 'https://relay.cumulush.com';

export type AttestActor = 'agent' | 'human';

export interface AttestationPayload {
  /** tenants.id — becomes the JWT `aud`. */
  tenantId: string;
  /** Integrator-local user ID (user_external_identities.external_user_id). */
  externalUserId: string;
  /** relay users.id. */
  relayUserId: string;
  /** Human email if known. */
  email?: string | null;
  /** Which actor triggered the attest. */
  actor: AttestActor;
  /** agents.id when actor === 'agent'. */
  agentId?: string | null;
}

export interface AttestationClaims {
  iss: string;
  aud: string;
  sub: string;
  rel_user_id: string;
  email?: string;
  act: AttestActor;
  agent_id?: string;
  iat: number;
  exp: number;
}

// ---------------------------------------------------------------------------
// Key loading + caching
// ---------------------------------------------------------------------------

interface LoadedKey {
  privatePem: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
  kid: string;
}

let cached: LoadedKey | null = null;

function getPrivatePem(): string {
  const raw = process.env.RELAY_JWT_PRIVATE_KEY;
  if (!raw) throw new Error('RELAY_JWT_PRIVATE_KEY is not set');
  const pem = Buffer.from(raw, 'base64').toString('utf8').trim();
  if (!pem.includes('BEGIN PRIVATE KEY')) {
    throw new Error('RELAY_JWT_PRIVATE_KEY must decode to a PKCS#8 PEM');
  }
  return pem;
}

async function loadKey(): Promise<LoadedKey> {
  if (cached) return cached;
  const pem = getPrivatePem();
  const privateKey = await importPKCS8(pem, ALG, { extractable: true });
  const publicJwk = await exportJWK(privateKey);
  // Strip the private half: exportJWK on a private key returns every component.
  // The public JWK for RSA is only { kty, n, e }.
  const pub: JWK = { kty: publicJwk.kty!, n: publicJwk.n!, e: publicJwk.e! };
  const kid = createHash('sha256')
    .update(`${pub.n}|${pub.e}`)
    .digest('base64url')
    .slice(0, 16);
  const jwkWithMeta: JWK = { ...pub, kid, alg: ALG, use: 'sig' };
  cached = { privatePem: pem, privateKey, publicJwk: jwkWithMeta, kid };
  return cached;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sign a short-lived attestation JWT for an integrator to verify.
 * Returns the compact JWT string.
 */
export async function signAttestation(
  payload: AttestationPayload,
): Promise<{ jwt: string; claims: AttestationClaims }> {
  const key = await loadKey();
  const now = Math.floor(Date.now() / 1000);
  const claims: AttestationClaims = {
    iss: ISSUER,
    aud: payload.tenantId,
    sub: payload.externalUserId,
    rel_user_id: payload.relayUserId,
    ...(payload.email ? { email: payload.email } : {}),
    act: payload.actor,
    ...(payload.agentId ? { agent_id: payload.agentId } : {}),
    iat: now,
    exp: now + TTL_SECONDS,
  };

  const jwt = await new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: ALG, kid: key.kid, typ: 'JWT' })
    .sign(key.privateKey);

  return { jwt, claims };
}

/**
 * Return the JWKS document served at GET /.well-known/jwks.json.
 * Integrators fetch this, cache it, and verify attestation JWTs offline.
 */
export async function getJwks(): Promise<{ keys: JWK[] }> {
  const key = await loadKey();
  return { keys: [key.publicJwk] };
}

/** For test harnesses that want to swap keys between runs. */
export function resetAttestationCacheForTests(): void {
  cached = null;
}
