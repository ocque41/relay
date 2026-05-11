export type ProviderCredential = string | Record<string, unknown>;

export interface DeliveredCredential {
  initialApiKey?: string;
  initialCredentials?: Record<string, unknown>;
}

const ENVELOPE_KEY = '__relay_credentials_v1';

export function encodeProviderCredential(credential: ProviderCredential): string {
  if (typeof credential === 'string') return credential;
  return JSON.stringify({ [ENVELOPE_KEY]: credential });
}

export function decodeProviderCredential(raw: string): DeliveredCredential {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      ENVELOPE_KEY in parsed
    ) {
      const credential = (parsed as Record<string, unknown>)[ENVELOPE_KEY];
      if (credential && typeof credential === 'object' && !Array.isArray(credential)) {
        return { initialCredentials: credential as Record<string, unknown> };
      }
    }
  } catch {
    // Legacy plaintext key.
  }
  return { initialApiKey: raw };
}
