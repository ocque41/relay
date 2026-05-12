import type { MetadataRoute } from 'next';

const BASE =
  process.env.APP_BASE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.replace(/^https?:\/\//, '')}`
    : 'https://relay.cumulush.com');

const paths = [
  '/',
  '/pricing',
  '/docs',
  '/docs/developer',
  '/docs/user',
  '/docs/agent-builders',
  '/docs/api',
  '/security',
  '/trust',
  '/legal/privacy',
  '/legal/terms',
];

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return paths.map((path) => ({
    url: `${BASE}${path}`,
    lastModified: now,
    changeFrequency: 'weekly' as const,
    priority: path === '/' ? 1 : path === '/pricing' ? 0.9 : 0.7,
  }));
}
