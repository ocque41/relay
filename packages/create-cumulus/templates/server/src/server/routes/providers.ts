import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { bearerAuth, type AppEnv } from '../auth';
import { readRateLimit } from '../rate-limit';
import { getProviderSummary, listProviders } from '../providers/index';

const app = new OpenAPIHono<AppEnv>();

const ProviderListItem = z
  .object({
    id: z.string().openapi({ example: 'neon' }),
    kind: z.enum(['builtin', 'tenant']),
    displayName: z.string(),
    description: z.string().nullable(),
    docsUrl: z.string().url().nullable(),
    homepage: z.string().url().nullable(),
    npmPackage: z.string().nullable(),
    categories: z.array(z.string()),
    pricingModel: z
      .enum(['free', 'free-tier', 'paid', 'usage-based', 'freemium'])
      .nullable(),
    pricingUrl: z.string().url().nullable(),
    freeTierSummary: z.string().nullable(),
    capabilities: z.array(z.string()),
    inputSchema: z
      .record(z.string(), z.unknown())
      .openapi({ description: 'JSON Schema describing the provider input.' }),
    tenantId: z.string().uuid().optional(),
    needsEmailVerification: z.boolean().optional(),
  })
  .openapi('Provider');

const ProviderListResponse = z.array(ProviderListItem).openapi('ProviderList');

const listRoute = createRoute({
  method: 'get',
  path: '/v1/providers',
  tags: ['providers'],
  summary: 'List registered providers',
  description:
    'Returns every public provider currently registered on the server, with JSON Schema input + discovery metadata. Pass ?include=demo to also surface internal demo providers (Neon/Vercel/Resend operator self-service); demos are hidden by default so the public catalog reflects the real product surface.',
  security: [{ bearerAuth: [] }],
  middleware: [bearerAuth, readRateLimit] as const,
  request: {
    query: z.object({
      include: z
        .enum(['demo'])
        .optional()
        .openapi({
          description:
            'Pass `demo` to include internal operator-self-service providers in the response.',
        }),
    }),
  },
  responses: {
    200: {
      description: 'Registered providers.',
      content: { 'application/json': { schema: ProviderListResponse } },
    },
    401: {
      description: 'Missing or invalid bearer token.',
      content: {
        'application/json': { schema: z.object({ error: z.string() }) },
      },
    },
    429: {
      description: 'Rate limit exceeded.',
      content: {
        'application/json': {
          schema: z.object({ error: z.string(), retryAfter: z.number() }),
        },
      },
    },
  },
});

function serialize(p: Awaited<ReturnType<typeof listProviders>>[number]) {
  return {
    id: p.id,
    kind: p.kind,
    displayName: p.displayName,
    description: p.description,
    docsUrl: p.docsUrl,
    homepage: p.homepage,
    npmPackage: p.npmPackage,
    categories: p.categories,
    pricingModel: p.pricingModel,
    pricingUrl: p.pricingUrl,
    freeTierSummary: p.freeTierSummary,
    capabilities: p.capabilities,
    inputSchema: (p.inputSchema ?? {}) as Record<string, unknown>,
    ...(p.tenantId ? { tenantId: p.tenantId } : {}),
    ...(p.needsEmailVerification !== undefined
      ? { needsEmailVerification: p.needsEmailVerification }
      : {}),
  };
}

app.openapi(listRoute, async (c) => {
  const { include } = c.req.valid('query');
  const providers = await listProviders({ includeDemo: include === 'demo' });
  return c.json(providers.map(serialize), 200);
});

const getRoute = createRoute({
  method: 'get',
  path: '/v1/providers/{id}',
  tags: ['providers'],
  summary: 'Get a provider by id',
  description:
    'Returns a single provider with full metadata + input JSON Schema. 404 if no static provider or tenant_providers row matches.',
  security: [{ bearerAuth: [] }],
  middleware: [bearerAuth, readRateLimit] as const,
  request: {
    params: z.object({
      id: z.string().openapi({ example: 'neon', param: { name: 'id', in: 'path' } }),
    }),
  },
  responses: {
    200: {
      description: 'Provider metadata + input JSON Schema.',
      content: { 'application/json': { schema: ProviderListItem } },
    },
    401: {
      description: 'Missing or invalid bearer token.',
      content: {
        'application/json': { schema: z.object({ error: z.string() }) },
      },
    },
    404: {
      description: 'No provider registered with that id.',
      content: {
        'application/json': { schema: z.object({ error: z.string() }) },
      },
    },
    429: {
      description: 'Rate limit exceeded.',
      content: {
        'application/json': {
          schema: z.object({ error: z.string(), retryAfter: z.number() }),
        },
      },
    },
  },
});

app.openapi(getRoute, async (c) => {
  const { id } = c.req.valid('param');
  const p = await getProviderSummary(id);
  if (!p) {
    return c.json({ error: 'provider_not_found' }, 404);
  }
  return c.json(serialize(p), 200);
});

export default app;
