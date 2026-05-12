import type { ProviderCredential } from './envelope';

export function credentialForAccountStorage(params: {
  tenantId: string | null;
  credential: ProviderCredential | null | undefined;
}): ProviderCredential | null {
  if (params.tenantId !== null) return null;
  return params.credential ?? null;
}
