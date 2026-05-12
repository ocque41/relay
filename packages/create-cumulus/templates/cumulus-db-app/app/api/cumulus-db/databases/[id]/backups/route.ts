import { cumulusDbTokenFetch } from '@/src/lib/cumulus-db/server';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return cumulusDbTokenFetch(request, `/v1/databases/${encodeURIComponent(id)}/backups`, {
    method: 'POST',
  });
}
