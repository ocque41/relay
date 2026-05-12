import { z } from 'zod';
import type { Provider, ProviderCtx, SignupOutcome, CreateApiKeyResult } from './types';
import { logger } from '../logger';

const NEON_API_BASE = 'https://console.neon.tech/api/v2';

// ---------------------------------------------------------------------------
// Schema & types
// ---------------------------------------------------------------------------

export const neonInputSchema = z.object({
  name: z.string().min(1).describe('Display name for the Neon project'),
  regionId: z.string().optional().describe('Neon region slug, e.g. "aws-us-east-2"'),
});

export type NeonInput = z.infer<typeof neonInputSchema>;

export type NeonAccount = {
  projectId: string;
  name: string;
  connectionUri: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function neonFetch<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T | null> {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) {
    throw new Error('NEON_API_KEY environment variable is not set');
  }

  const res = await fetch(`${NEON_API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(options?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)');
    throw new Error(`Neon API ${res.status} on ${path}: ${body}`);
  }

  if (res.status === 204) return null;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export const neonProvider: Provider<NeonInput, NeonAccount> = {
  id: 'neon',
  visibility: 'demo',
  displayName: 'Neon',
  description: 'Operator self-service — provisions a serverless Postgres project INSIDE the Relay operator\'s own Neon account (auth: NEON_API_KEY env) and returns its connection URI. Not an end-user signup on Neon.',
  docsUrl: 'https://neon.tech/docs',
  homepage: 'https://neon.tech',
  npmPackage: '@neondatabase/serverless',
  categories: ['database'],
  capabilities: [
    'postgres',
    'serverless',
    'branching',
    'read-replicas',
    'autoscaling',
  ],
  pricingModel: 'free-tier',
  pricingUrl: 'https://neon.tech/pricing',
  freeTierSummary:
    '0.5 GB storage and ~190 compute hours per month on the Free plan.',
  envVar: 'DATABASE_URL',

  defaultInputForIntent({ workspaceSlug, alias, workspaceId }) {
    const base = workspaceSlug ?? workspaceId.slice(0, 8);
    const tail = alias ?? 'primary';
    // Neon project names cap at 63 chars; trim defensively.
    const name = `${base}-${tail}`.slice(0, 60);
    return { name };
  },

  inputSchema: neonInputSchema,

  /**
   * Creates a Neon project via the Management API.
   * This path never requires email verification — signup completes synchronously.
   */
  async signup(
    _ctx: ProviderCtx,
    input: NeonInput,
    _emailAddress: string,
  ): Promise<SignupOutcome<NeonAccount>> {
    const projectPayload: Record<string, unknown> = { name: input.name };
    if (input.regionId) projectPayload.region_id = input.regionId;

    const data = await neonFetch<{
      project: { id: string; name: string };
      connection_uris: Array<{ connection_uri: string }>;
    }>('/projects', {
      method: 'POST',
      body: JSON.stringify({ project: projectPayload }),
    });

    if (!data) throw new Error('Neon API returned empty response for project creation');

    const projectId = data.project.id;
    const projectName = data.project.name;
    const connectionUri = data.connection_uris?.[0]?.connection_uri ?? '';

    return {
      needsEmail: false,
      account: { projectId, name: projectName, connectionUri },
      externalId: projectId,
      credentials: connectionUri,
    };
  },

  /**
   * Returns the project connection URI as the API key.
   *
   * NOTE: Full per-key management (Neon API keys tied to individual projects)
   * is out of scope for this provider. For production use, provision a Neon
   * API key scoped to the project and return that instead.
   */
  async createApiKey(
    _ctx: ProviderCtx,
    account: NeonAccount,
    _label: string,
  ): Promise<CreateApiKeyResult> {
    return { key: account.connectionUri };
  },

  /**
   * No-op — Neon does not support revoking individual connection URIs.
   *
   * WARNING: Calling this does NOT invalidate the connection string. To
   * truly revoke access, reset the project's database password via the
   * Neon Console or Management API.
   */
  async revokeApiKey(
    _ctx: ProviderCtx,
    _account: NeonAccount,
    keyId: string,
  ): Promise<void> {
    logger.debug(
      { provider: 'neon', keyId },
      'neon.revoke_api_key.noop — connection URI revocation is not supported; reset the database password via the Neon Console to invalidate access',
    );
  },

  /**
   * Permanently deletes the Neon project and all its data.
   */
  async teardown(_ctx: ProviderCtx, account: NeonAccount): Promise<void> {
    await neonFetch(`/projects/${account.projectId}`, { method: 'DELETE' });
  },
};
