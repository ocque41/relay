/**
 * Register Cumulus Database as a Relay tenant provider.
 *
 * Usage:
 *   npx tsx scripts/register-cumulus-database-provider.ts --tenant-id <uuid>
 *
 * Required env:
 *   CUMULUS_DB_PUBLIC_URL=https://db.example.com
 *
 * Prints the provider webhook secret exactly once. Save it into the Cumulus
 * Database service as CUMULUS_DB_RELAY_WEBHOOK_SECRET.
 */
export {};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const tenantId = arg('tenant-id');
  const publicUrl = (process.env.CUMULUS_DB_PUBLIC_URL ?? '').replace(/\/$/, '');
  if (!tenantId || !publicUrl) {
    console.error('Usage: CUMULUS_DB_PUBLIC_URL=https://... npx tsx scripts/register-cumulus-database-provider.ts --tenant-id <uuid>');
    process.exit(2);
  }

  const { registerTenantProduct } = await import('../src/server/dev/products');
  const result = await registerTenantProduct({
    tenantId,
    slug: 'cumulus-database',
    displayName: 'Cumulus Database',
    signupWebhookUrl: `${publicUrl}/v1/relay/signup`,
    teardownWebhookUrl: `${publicUrl}/v1/relay/signup`,
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        agent_id: { type: 'string' },
        purpose: { type: 'string' },
      },
      required: ['email'],
      additionalProperties: true,
    },
    description: 'Agent-owned memory, records, key-value data, secrets, and hybrid search.',
    docsUrl: `${publicUrl}/docs`,
    homepage: publicUrl,
    categories: ['ai', 'database'],
    pricingModel: 'free-tier',
    pricingUrl: `${publicUrl}/pricing`,
    freeTierSummary: 'MVP workspace for agent memory and database handoff.',
    capabilities: [
      'agent-memory',
      'key-value',
      'hybrid-search',
      'secrets',
      'mcp',
      'rest-api',
    ],
    verificationMode: 'none',
  });

  console.log(`PROVIDER_ID=${result.id}`);
  console.log(`PROVIDER_SLUG=${result.slug}`);
  console.log(`RELAY_WEBHOOK_SECRET=${result.webhook_secret}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
