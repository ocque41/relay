/**
 * @cumulus/server — drop a webhook into your existing auth and accept
 * agent-driven signups for your app.
 *
 * Usage (framework-agnostic, returns a `(Request) => Promise<Response>` handler):
 *
 * ```ts
 * import { relay } from '@cumulus/server';
 *
 * export const POST = relay.webhook({
 *   secret: process.env.RELAY_WEBHOOK_SECRET!,
 *   onSignup: async ({ email, input }) => {
 *     const user = await myAuth.createUser({ email });
 *     const apiKey = await myAuth.issueApiKey(user.id);
 *     return { accountId: user.id, apiKey };
 *   },
 * });
 * ```
 *
 * Works with Next.js App Router route handlers, Hono (via `c.req.raw`),
 * Bun, Deno, and anywhere else Web-Standard Request/Response is available.
 *
 * For Node/Express, wrap the handler via `toNodeHandler(handler)` — see
 * the README for a 5-line snippet.
 */

/**
 * Incoming webhook payloads, discriminated by `kind`.
 * Relay's tenant factory sends one of these to the integrator.
 */
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

/** onSignup response — fulfilled signup: account + first API key. */
export interface SignupResult {
  accountId: string;
  apiKey: string;
  externalId?: string;
}

export interface CreateApiKeyResult {
  key: string;
  providerKeyId?: string;
}

/** Handler interface — the integrator implements the callbacks they care about. */
export interface WebhookOptions {
  /** HMAC-SHA256 shared secret. MUST match the one configured on Relay. */
  secret: string;

  /** Called for `kind: "signup"`. Return a SignupResult to complete, or throw on error. */
  onSignup: (p: SignupPayload) => Promise<SignupResult> | SignupResult;

  /** Optional — mint a second (or Nth) key for an existing account. */
  onCreateApiKey?: (p: CreateApiKeyPayload) => Promise<CreateApiKeyResult> | CreateApiKeyResult;

  /** Optional — revoke a specific key. */
  onRevokeApiKey?: (p: RevokeApiKeyPayload) => Promise<void> | void;

  /** Optional — delete/close the account on your side. */
  onTeardown?: (p: TeardownPayload) => Promise<void> | void;

  /** Optional — called for unrecognized `kind` values; defaults to 400. */
  onUnknown?: (p: unknown) => Promise<Response> | Response;
}

// ---------------------------------------------------------------------------
// HMAC verification (Web Crypto — works everywhere Request/Response does)
// ---------------------------------------------------------------------------
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
    .map((b) => b.toString(16).padStart(2, '0'))
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

// ---------------------------------------------------------------------------
// Webhook handler factory
// ---------------------------------------------------------------------------
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build a framework-agnostic Request → Response handler.
 */
function webhook(options: WebhookOptions) {
  const handler = async (req: Request): Promise<Response> => {
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
            return jsonResponse(501, { error: 'create_api_key not supported' });
          }
          if (typeof p.account_id !== 'string' || typeof p.label !== 'string') {
            return jsonResponse(400, { error: 'missing_fields' });
          }
          const result = await options.onCreateApiKey(p as CreateApiKeyPayload);
          return jsonResponse(200, result);
        }
        case 'revoke_api_key': {
          if (!options.onRevokeApiKey) {
            return jsonResponse(501, { error: 'revoke_api_key not supported' });
          }
          if (typeof p.account_id !== 'string' || typeof p.key_id !== 'string') {
            return jsonResponse(400, { error: 'missing_fields' });
          }
          await options.onRevokeApiKey(p as RevokeApiKeyPayload);
          return jsonResponse(200, { revoked: true });
        }
        case 'teardown': {
          if (!options.onTeardown) {
            return jsonResponse(501, { error: 'teardown not supported' });
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
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(500, { error: msg });
    }
  };

  // Return a function that's directly assignable to Next.js `POST` exports,
  // Hono `app.post(path, handler)`, Bun serve, etc. All expect `(Request) => Response|Promise<Response>`.
  return handler;
}

// ---------------------------------------------------------------------------
// Actions API handler (1.1.0)
// ---------------------------------------------------------------------------

/** Payload Relay POSTs to your registered `endpoint_url` on every invocation. */
export interface ActionInvocationPayload {
  requestId: string;
  actionSlug: string;
  externalUserId: string;
  relayUserId: string;
  input: Record<string, unknown>;
  nonce: string;
  /** Unix seconds at dispatch time. */
  ts: number;
}

/** Context passed to every handler — the identity of the caller for this invocation. */
export interface ActionContext {
  requestId: string;
  externalUserId: string;
  relayUserId: string;
  actionSlug: string;
}

/** Handlers should return one of these shapes. `ok: true` → 200, `ok: false` → 4xx. */
export type ActionResult =
  | { ok: true; output?: unknown }
  | { ok: false; error: string; status?: number };

export type ActionHandler<TInput = Record<string, unknown>> = (
  ctx: ActionContext,
  input: TInput,
) => Promise<ActionResult> | ActionResult;

export interface ActionsOptions {
  /** HMAC-SHA256 shared secret. The plaintext `webhook_secret` from POST /v1/integrator/actions. */
  secret: string;
  /** Named handlers keyed by action slug. Missing slug → 404. */
  handlers: Record<string, ActionHandler>;
  /** Optional hook for unknown slugs — defaults to 404. */
  onUnknown?: (slug: string, payload: ActionInvocationPayload) => Promise<Response> | Response;
}

/**
 * Build a framework-agnostic handler for the Actions API — verifies the
 * HMAC, decodes the payload, dispatches to the named handler. Return a
 * 200 on success (with `output`), a 4xx when you reject, and throw to
 * 500. Relay folds the `output` back into the response to the agent.
 *
 * Wire it up once per route, then add handlers as you introduce new
 * actions. Handlers can be plain functions with `(ctx, input) => …`
 * shape; multi-action dispatch is built in.
 *
 * Example (Next.js App Router):
 *
 * ```ts
 * export const POST = relay.actions({
 *   secret: process.env.RELAY_ACTIONS_SECRET!,
 *   handlers: {
 *     publish_post: async (ctx, input: { title: string; body: string }) => {
 *       const post = await db.posts.create({
 *         userId: ctx.externalUserId,
 *         ...input,
 *       });
 *       return { ok: true, output: { postId: post.id } };
 *     },
 *   },
 * });
 * ```
 */
function actions(options: ActionsOptions) {
  const handler = async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'method_not_allowed' });
    }

    const rawBody = await req.text();
    const sig = req.headers.get('x-relay-signature');
    if (!(await verifySignature(rawBody, sig, options.secret))) {
      return jsonResponse(401, { ok: false, error: 'invalid_signature' });
    }

    let payload: ActionInvocationPayload;
    try {
      payload = JSON.parse(rawBody) as ActionInvocationPayload;
    } catch {
      return jsonResponse(400, { ok: false, error: 'invalid_json' });
    }

    const slug = payload.actionSlug;
    if (typeof slug !== 'string' || !slug) {
      return jsonResponse(400, { ok: false, error: 'missing_action_slug' });
    }

    const fn = options.handlers[slug];
    if (!fn) {
      if (options.onUnknown) return options.onUnknown(slug, payload);
      return jsonResponse(404, { ok: false, error: `unknown_action:${slug}` });
    }

    const ctx: ActionContext = {
      requestId: payload.requestId,
      externalUserId: payload.externalUserId,
      relayUserId: payload.relayUserId,
      actionSlug: slug,
    };

    try {
      const result = await fn(ctx, payload.input ?? {});
      if (!result || typeof result !== 'object' || !('ok' in result)) {
        return jsonResponse(500, { ok: false, error: 'handler_returned_invalid_result' });
      }
      if (result.ok) {
        return jsonResponse(200, { ok: true, output: result.output ?? null });
      }
      return jsonResponse(result.status ?? 400, { ok: false, error: result.error });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(500, { ok: false, error: msg });
    }
  };

  return handler;
}

// ---------------------------------------------------------------------------
// Outbound client — server-side calls to Relay that don't fit the webhook-
// receiver pattern. Only the surfaces integrators typically need from their
// own backend live here; full API access still goes through the CLI or REST.
// ---------------------------------------------------------------------------

export interface ClientOptions {
  /** Agent bearer token. Server-side only — never expose in browsers. */
  agentToken: string;
  /** Defaults to `https://relay.cumulush.com`. */
  baseUrl?: string;
  /** Optional custom fetch (for tests). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface AgentGuide {
  content: string;
  updated_at: string | null;
  bytes: number;
}

export interface AgentGuideWriteResult {
  updated_at: string;
  bytes: number;
}

async function clientRequest<T>(
  opts: ClientOptions,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const base = opts.baseUrl ?? 'https://relay.cumulush.com';
  const doFetch = opts.fetch ?? fetch;
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${opts.agentToken}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await doFetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let data: unknown;
  try {
    data = text.length ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return data as T;
}

export function client(opts: ClientOptions) {
  return {
    agentGuide: {
      async get(): Promise<AgentGuide> {
        return clientRequest<AgentGuide>(opts, '/v1/agent-guide');
      },
      async put(content: string): Promise<AgentGuideWriteResult> {
        return clientRequest<AgentGuideWriteResult>(opts, '/v1/agent-guide', {
          method: 'PUT',
          body: JSON.stringify({ content }),
        });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export const relay = {
  webhook,
  actions,
  client,
};

export default relay;
