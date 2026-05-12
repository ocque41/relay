import { cumulusDbTokenFetch } from '@/src/lib/cumulus-db/server';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; key: string }> },
) {
  const { id, key } = await params;
  return cumulusDbTokenFetch(
    request,
    `/v1/databases/${encodeURIComponent(id)}/kv/${encodeURIComponent(key)}`,
  );
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; key: string }> },
) {
  const { id, key } = await params;
  return cumulusDbTokenFetch(
    request,
    `/v1/databases/${encodeURIComponent(id)}/kv/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      body: await request.text(),
    },
  );
}
