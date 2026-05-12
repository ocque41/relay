import { cumulusDbPublicFetch } from '@/src/lib/cumulus-db/server';

export async function GET() {
  return cumulusDbPublicFetch('/mcp');
}

export async function POST(request: Request) {
  return cumulusDbPublicFetch('/mcp', {
    method: 'POST',
    body: await request.text(),
  });
}
