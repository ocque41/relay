import type { Metadata } from 'next';
import { Video } from './Video';

export const metadata: Metadata = {
  title: 'Relay — Product video',
  description:
    "60 seconds: how providers register their product and how users' AI agents sign them up.",
};

export default function VideoPage() {
  return <Video />;
}
