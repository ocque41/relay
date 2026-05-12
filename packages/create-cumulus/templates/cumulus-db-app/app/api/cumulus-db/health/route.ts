import { cumulusDbPublicFetch } from '@/src/lib/cumulus-db/server';

export async function GET() {
  return cumulusDbPublicFetch('/health');
}
