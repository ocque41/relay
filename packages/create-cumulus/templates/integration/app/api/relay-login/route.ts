import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { NextResponse } from 'next/server';
import { appConfig } from '@/src/lib/config';
import { SESSION_COOKIE, signAppSession } from '@/src/lib/auth';

type RelayClaims = JWTPayload & {
  sub?: string;
  email?: string;
  act?: 'agent' | 'human';
  rel_user_id?: string;
};

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(appConfig.relayJwksUri));
  }
  return jwks;
}

function error(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { jwt?: string } | null;
  const token = body?.jwt?.trim();
  if (!token) return error('jwt is required');

  let claims: RelayClaims;
  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: appConfig.relayIssuer,
      audience: appConfig.relayTenantId,
    });
    claims = payload as RelayClaims;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid token';
    return error(`relay attestation rejected: ${message}`, 401);
  }

  if (!claims.sub || !claims.email) {
    return error('attestation missing sub or email', 401);
  }

  const session = await signAppSession({
    externalUserId: claims.sub,
    relayUserId: claims.rel_user_id,
    email: claims.email,
    actor: claims.act ?? 'agent',
  });

  const response = NextResponse.json({
    ok: true,
    externalUserId: claims.sub,
    email: claims.email,
    actor: claims.act ?? 'agent',
  });
  response.cookies.set(SESSION_COOKIE, session, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
  return response;
}
