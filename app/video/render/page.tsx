import type { Metadata } from 'next';
import { RenderFrame } from './RenderFrame';

export const metadata: Metadata = {
  title: 'Relay video — frame renderer',
  robots: { index: false, follow: false },
};

export default function VideoRenderPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  return <RenderFrameAsync searchParamsPromise={searchParams} />;
}

async function RenderFrameAsync({
  searchParamsPromise,
}: {
  searchParamsPromise: Promise<{ t?: string }>;
}) {
  const sp = await searchParamsPromise;
  const t = Number.parseFloat(sp.t ?? '0');
  const time = Number.isFinite(t) ? t : 0;
  return <RenderFrame time={time} />;
}
