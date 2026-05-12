export const appConfig = {
  companyName: '__COMPANY_NAME__',
  templateName: '__TEMPLATE_NAME__',
  agentAuthMode: '__AGENT_AUTH_MODE__',
  relayTenantSlug: process.env.RELAY_TENANT_SLUG ?? '__PACKAGE_NAME__',
  relayTenantId: process.env.RELAY_TENANT_ID ?? 'replace-with-relay-tenant-id',
  relayEndpoint: process.env.RELAY_ENDPOINT ?? '__RELAY_ENDPOINT__',
  relayIssuer: process.env.RELAY_ISSUER ?? '__RELAY_ISSUER__',
  relayJwksUri: process.env.RELAY_JWKS_URI ?? '__RELAY_JWKS_URI__',
  appBaseUrl: process.env.APP_BASE_URL ?? '__APP_BASE_URL__',
};

export function publicBaseUrl(request?: Request): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/+$/, '');
  if (!request) return appConfig.appBaseUrl;
  const url = new URL(request.url);
  return url.origin;
}
