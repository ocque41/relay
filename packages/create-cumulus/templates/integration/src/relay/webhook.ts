export interface SignupPayload {
  kind: 'signup';
  signupId: string;
  email: string;
  input: Record<string, unknown>;
  provider_slug: string;
}

export interface CreateApiKeyPayload {
  kind: 'create_api_key';
  account_id: string;
  label: string;
}

export interface RevokeApiKeyPayload {
  kind: 'revoke_api_key';
  account_id: string;
  key_id: string;
}

export interface TeardownPayload {
  kind: 'teardown';
  account_id: string;
}

export type RelayWebhookPayload =
  | SignupPayload
  | CreateApiKeyPayload
  | RevokeApiKeyPayload
  | TeardownPayload;

export interface SignupResult {
  accountId: string;
  apiKey: string;
  externalId?: string;
}

export interface CreateApiKeyResult {
  key: string;
  providerKeyId?: string;
}

export interface WebhookOptions {
  secret: string;
  onSignup: (payload: SignupPayload) => Promise<SignupResult> | SignupResult;
  onCreateApiKey?: (
    payload: CreateApiKeyPayload,
  ) => Promise<CreateApiKeyResult> | CreateApiKeyResult;
  onRevokeApiKey?: (payload: RevokeApiKeyPayload) => Promise<void> | void;
  onTeardown?: (payload: TeardownPayload) => Promise<void> | void;
  onUnknown?: (payload: unknown) => Promise<Response> | Response;
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

async function verifySignature(
  body: string,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!header) return false;
  const provided = header.startsWith('sha256=') ? header.slice(7) : header;
  if (!/^[0-9a-f]+$/i.test(provided)) return false;
  const expected = await hmacHex(secret, body);
  return timingSafeEqual(provided.toLowerCase(), expected);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function webhook(options: WebhookOptions) {
  return async function relayWebhook(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return jsonResponse(405, { error: 'method_not_allowed' });
    }

    const rawBody = await req.text();
    const sig = req.headers.get('x-relay-signature');
    if (!(await verifySignature(rawBody, sig, options.secret))) {
      return jsonResponse(401, { error: 'invalid_signature' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return jsonResponse(400, { error: 'invalid_json' });
    }

    const p = payload as Partial<RelayWebhookPayload>;
    try {
      switch (p.kind) {
        case 'signup': {
          if (typeof p.email !== 'string' || typeof p.signupId !== 'string') {
            return jsonResponse(400, { error: 'missing_fields' });
          }
          const result = await options.onSignup(p as SignupPayload);
          if (!result?.accountId || !result?.apiKey) {
            return jsonResponse(500, { error: 'handler_returned_invalid_result' });
          }
          return jsonResponse(200, result);
        }
        case 'create_api_key': {
          if (!options.onCreateApiKey) {
            return jsonResponse(501, { error: 'create_api_key_not_supported' });
          }
          if (typeof p.account_id !== 'string' || typeof p.label !== 'string') {
            return jsonResponse(400, { error: 'missing_fields' });
          }
          const result = await options.onCreateApiKey(p as CreateApiKeyPayload);
          return jsonResponse(200, result);
        }
        case 'revoke_api_key': {
          if (!options.onRevokeApiKey) {
            return jsonResponse(501, { error: 'revoke_api_key_not_supported' });
          }
          if (typeof p.account_id !== 'string' || typeof p.key_id !== 'string') {
            return jsonResponse(400, { error: 'missing_fields' });
          }
          await options.onRevokeApiKey(p as RevokeApiKeyPayload);
          return jsonResponse(200, { revoked: true });
        }
        case 'teardown': {
          if (!options.onTeardown) {
            return jsonResponse(501, { error: 'teardown_not_supported' });
          }
          if (typeof p.account_id !== 'string') {
            return jsonResponse(400, { error: 'missing_fields' });
          }
          await options.onTeardown(p as TeardownPayload);
          return jsonResponse(200, { deleted: true });
        }
        default: {
          if (options.onUnknown) return options.onUnknown(payload);
          return jsonResponse(400, { error: `unknown_kind:${String(p.kind)}` });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(500, { error: message });
    }
  };
}

export const relay = { webhook };
