import { appConfig, publicBaseUrl } from '@/src/lib/config';

export async function GET(request: Request) {
  const base = publicBaseUrl(request);
  const relayEndpoint =
    appConfig.agentAuthMode === 'self-hosted' ? `${base}/v1` : appConfig.relayEndpoint;
  const relayBase = relayEndpoint.replace(/\/v1\/?$/, '');

  return Response.json({
    owner: 'Cumulus',
    app: appConfig.companyName,
    template: appConfig.templateName,
    agentAuthMode: appConfig.agentAuthMode,
    tenantSlug: appConfig.relayTenantSlug,
    tenantId: appConfig.relayTenantId,
    relayEndpoint,
    jwksUri:
      appConfig.agentAuthMode === 'self-hosted'
        ? `${base}/.well-known/jwks.json`
        : appConfig.relayJwksUri || `${relayBase}/.well-known/jwks.json`,
    loginUrl: `${base}/api/relay-login`,
    signupWebhookUrl: `${base}/api/agent-signup`,
    actionsWebhookUrl: `${base}/api/actions`,
  });
}
