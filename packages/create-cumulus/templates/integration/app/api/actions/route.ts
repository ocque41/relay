interface ActionPayload {
  requestId: string;
  actionSlug: string;
  externalUserId: string;
  relayUserId: string;
  input: Record<string, unknown>;
}

function json(status: number, body: unknown) {
  return Response.json(body, { status });
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function verify(body: string, signature: string | null): Promise<boolean> {
  const secret = process.env.RELAY_ACTIONS_SECRET ?? 'dev-only-replace-me';
  if (!signature) return false;
  const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  if (!/^[0-9a-f]+$/i.test(provided)) return false;
  const expected = await hmacHex(secret, body);
  return timingSafeEqual(provided.toLowerCase(), expected);
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (!(await verify(rawBody, request.headers.get('x-relay-signature')))) {
    return json(401, { ok: false, error: 'invalid_signature' });
  }

  const payload = JSON.parse(rawBody) as ActionPayload;
  if (payload.actionSlug === 'echo') {
    return json(200, { ok: true, output: payload.input ?? {} });
  }
  if (payload.actionSlug === 'create_project') {
    const title =
      typeof payload.input?.title === 'string' ? payload.input.title : 'Untitled project';
    return json(200, {
      ok: true,
      output: {
        projectId: `project_${payload.externalUserId.slice(0, 8)}`,
        title,
        createdFor: payload.externalUserId,
      },
    });
  }

  return json(404, { ok: false, error: `unknown_action:${payload.actionSlug}` });
}
