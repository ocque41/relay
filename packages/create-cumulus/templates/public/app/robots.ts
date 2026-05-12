import type { MetadataRoute } from 'next';

const BASE =
  process.env.APP_BASE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.replace(/^https?:\/\//, '')}`
    : 'https://relay.cumulush.com');

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: [
          '/',
          '/AGENTS.md',
          '/CLAUDE.md',
          '/llms.txt',
          '/llms-full.txt',
          '/openapi.json',
          '/docs',
          '/.well-known/',
        ],
        disallow: ['/me/', '/dev/', '/share/', '/v1/', '/mcp'],
      },
    ],
    sitemap: [`${BASE}/sitemap.xml`, `${BASE}/openapi.json`],
    host: BASE,
  };
}
