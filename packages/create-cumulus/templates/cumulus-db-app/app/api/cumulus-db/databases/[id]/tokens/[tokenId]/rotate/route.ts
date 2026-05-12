import { cumulusDbTokenFetch } from '@/src/lib/cumulus-db/server';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; tokenId: string }> },
) {
  const { id, tokenId } = await params;
  return cumulusDbTokenFetch(
    request,
    `/v1/databases/${encodeURIComponent(id)}/tokens/${encodeURIComponent(tokenId)}/rotate`,
    { method: 'POST' },
  );
}
