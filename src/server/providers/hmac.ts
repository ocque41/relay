/**
 * Shared HMAC-signed outbound HTTP POST to an integrator endpoint.
 *
 * Every integrator call Relay makes — tenant_providers webhooks (signup,
 * create_api_key, …) and Actions API dispatch — goes through this function
 * so the signature format, timeout, and error handling stay identical.
 *
 * Signature:
 *   X-Relay-Signature: sha256=<hex-hmac-sha256(raw_body, secret)>
 *   X-Relay-Provider:  <slug>          (optional, legacy — tenant providers set it)
 *   X-Relay-Action:    <slug>          (optional — Actions API sets it)
 *   Content-Type:      application/json
 *   User-Agent:        relay/1.0
 *
 * Returns a non-throwing result envelope so callers can record the attempt
 * with `status: 'succeeded' | 'failed' | 'unknown'` in their own ledger. The
 * legacy tenant.ts consumer wraps this in a throw-on-!ok helper to preserve
 * workflow retry semantics.
 */
import { createHmac } from 'node:crypto';

export interface HmacPostArgs {
  url: string;
  secret: string;
  body: Record<string, unknown> | unknown[];
  /** Extra headers (X-Relay-Provider, X-Relay-Action, etc.). */
  headers?: Record<string, string>;
  /** Milliseconds before we give up. Defaults to 30 000 (matches tenant.ts). */
  timeoutMs?: number;
  /** HTTP method. Defaults to 'POST'. */
  method?: string;
  /** For logging — a short identifier of the target (tenant_provider slug, action slug…). */
  label?: string;
}

export interface HmacPostResult {
  /** `true` iff the response status was 2xx AND the body parsed as JSON. */
  ok: boolean;
  /** HTTP status code, or 0 when the request never reached the server. */
  status: number;
  /** Parsed JSON response body (or `{}` for empty / `{ error: ... }` for non-JSON). */
  data: unknown;
  /** Round-trip time in ms. */
  latencyMs: number;
  /** 'timeout' | 'network' | 'http_4xx' | 'http_5xx' | 'non_json' | null */
  failure: 'timeout' | 'network' | 'http_4xx' | 'http_5xx' | 'non_json' | null;
  /** Human-readable error when `ok: false`. Empty string on success. */
  error: string;
}

/**
 * Dispatch a single HMAC-signed request. Never throws — every failure surface
 * is encoded in the returned struct.
 */
export async function hmacPost(args: HmacPostArgs): Promise<HmacPostResult> {
  const body = JSON.stringify(args.body);
  const signature = createHmac('sha256', args.secret).update(body).digest('hex');
  const timeoutMs = args.timeoutMs ?? 30_000;
  const method = args.method ?? 'POST';

  const started = Date.now();
  let status = 0;
  let text = '';
  try {
    const res = await fetch(args.url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Signature': `sha256=${signature}`,
        'User-Agent': 'relay/1.0',
        ...(args.headers ?? {}),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    text = await res.text();
  } catch (err: unknown) {
    const latencyMs = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    // `AbortSignal.timeout` throws `TimeoutError` (Node 20+) — treat same as
    // DOMException 'TimeoutError'. Everything else is 'network'.
    const isTimeout =
      (err instanceof Error && err.name === 'TimeoutError') ||
      /timeout|timed out/i.test(msg);
    return {
      ok: false,
      status: 0,
      data: { error: msg },
      latencyMs,
      failure: isTimeout ? 'timeout' : 'network',
      error: msg,
    };
  }

  const latencyMs = Date.now() - started;
  let data: unknown = {};
  let parsedOk = true;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      parsedOk = false;
      data = { error: `invalid JSON response: ${text.slice(0, 200)}` };
    }
  }

  if (status >= 200 && status < 300 && parsedOk) {
    return { ok: true, status, data, latencyMs, failure: null, error: '' };
  }

  const bodyError =
    typeof data === 'object' && data !== null && 'error' in data
      ? String((data as { error: unknown }).error)
      : `${status} ${text.slice(0, 200)}`;

  const failure: HmacPostResult['failure'] = !parsedOk
    ? 'non_json'
    : status >= 500
      ? 'http_5xx'
      : status >= 400
        ? 'http_4xx'
        : 'http_5xx';

  const label = args.label ? `[${args.label}] ` : '';
  return {
    ok: false,
    status,
    data,
    latencyMs,
    failure,
    error: `${label}${bodyError || `http ${status}`}`,
  };
}

/**
 * Legacy wrapper used by tenant.ts — throws on failure, returns parsed body
 * on success. Keeps the `dispatch()` contract intact for the WDK workflow
 * which relies on thrown exceptions for retry / fail routing.
 */
export async function hmacPostOrThrow(args: HmacPostArgs): Promise<unknown> {
  const result = await hmacPost(args);
  if (!result.ok) {
    throw new Error(result.error || `http ${result.status}`);
  }
  return result.data;
}
