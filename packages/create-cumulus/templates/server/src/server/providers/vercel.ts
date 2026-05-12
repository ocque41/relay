import { z } from 'zod';
import type {
  Provider,
  ProviderCtx,
  SignupOutcome,
  CreateApiKeyResult,
} from './types';

const VERCEL_API_BASE = 'https://api.vercel.com';

// ---------------------------------------------------------------------------
// Schema & types
// ---------------------------------------------------------------------------

export const vercelInputSchema = z.object({
  name: z.string().min(1).max(52).describe('Vercel project name (globally unique)'),
  teamId: z.string().optional().describe('Vercel team slug or ID (optional)'),
});

export type VercelInput = z.infer<typeof vercelInputSchema>;

export type VercelAccount = {
  projectId: string;
  projectName: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function vercelFetch<T = unknown>(
  path: string,
  init?: RequestInit,
  teamId?: string,
): Promise<T | null> {
  const apiToken = process.env.VERCEL_API_TOKEN;
  if (!apiToken) {
    throw new Error('VERCEL_API_TOKEN environment variable is not set');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiToken}`,
    ...(teamId ? { 'x-vercel-team-id': teamId } : {}),
    ...((init?.headers as Record<string, string>) ?? {}),
  };

  const res = await fetch(`${VERCEL_API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)');
    throw new Error(`Vercel API ${res.status} on ${path}: ${body}`);
  }

  if (res.status === 204) return null;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export const vercelProvider: Provider<VercelInput, VercelAccount> = {
  id: 'vercel',
  visibility: 'demo',
  displayName: 'Vercel',
  description: 'Operator self-service — provisions a Vercel project INSIDE the Relay operator\'s own Vercel account (auth: VERCEL_API_TOKEN env) and mints a scoped API token. Not an end-user signup on Vercel.',
  docsUrl: 'https://vercel.com/docs',
  homepage: 'https://vercel.com',
  npmPackage: 'vercel',
  categories: ['hosting'],
  capabilities: [
    'frontend',
    'fluid-compute',
    'edge',
    'cron',
    'queues',
    'preview-deployments',
    'nextjs',
  ],
  pricingModel: 'free-tier',
  pricingUrl: 'https://vercel.com/pricing',
  freeTierSummary:
    'Hobby plan includes generous bandwidth + build minutes for personal, non-commercial projects.',
  envVar: 'VERCEL_TOKEN',

  defaultInputForIntent({ workspaceSlug, alias, workspaceId }) {
    const base = workspaceSlug ?? workspaceId.slice(0, 8);
    const tail = alias ?? 'primary';
    // Vercel project names cap at 52 chars.
    const name = `${base}-${tail}`.slice(0, 52);
    return { name };
  },

  inputSchema: vercelInputSchema,

  /**
   * Creates a Vercel project via the Management API.
   * Signup completes synchronously (no email verification required).
   */
  async signup(
    _ctx: ProviderCtx,
    input: VercelInput,
    _emailAddress: string,
  ): Promise<SignupOutcome<VercelAccount>> {
    const data = await vercelFetch<{ id: string; name: string }>(
      '/v10/projects',
      {
        method: 'POST',
        body: JSON.stringify({ name: input.name, framework: null }),
      },
      input.teamId,
    );

    if (!data) throw new Error('Vercel API returned empty response for project creation');

    return {
      needsEmail: false,
      account: { projectId: data.id, projectName: data.name },
      externalId: data.id,
      credentials: JSON.stringify({ projectId: data.id, projectName: data.name }),
    };
  },

  /**
   * Mints a Vercel user token and returns both the plaintext token
   * and the token ID (stored as provider_key_id for later revocation).
   */
  async createApiKey(
    _ctx: ProviderCtx,
    _account: VercelAccount,
    label: string,
  ): Promise<CreateApiKeyResult> {
    // POST /v3/user/tokens returns:
    //   { token: { id, name, type, ... }, bearerToken: "<plaintext>" }
    const data = await vercelFetch<{
      token: { id: string; name: string };
      bearerToken: string;
    }>(
      '/v3/user/tokens',
      {
        method: 'POST',
        body: JSON.stringify({ name: `${label}-${Date.now()}` }),
      },
    );

    if (!data) throw new Error('Vercel API returned empty response for token creation');

    return { key: data.bearerToken, providerKeyId: data.token.id };
  },

  /**
   * Revokes a Vercel user token by its token ID (provider_key_id).
   */
  async revokeApiKey(
    _ctx: ProviderCtx,
    _account: VercelAccount,
    keyId: string,
  ): Promise<void> {
    await vercelFetch(`/v3/user/tokens/${keyId}`, { method: 'DELETE' });
  },

  /**
   * Permanently deletes the Vercel project and all its resources.
   */
  async teardown(_ctx: ProviderCtx, account: VercelAccount): Promise<void> {
    await vercelFetch(`/v9/projects/${account.projectId}`, { method: 'DELETE' });
  },
};
