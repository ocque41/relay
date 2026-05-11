/**
 * Local development server — used by `npm run dev` via `vercel dev`.
 * Starts the Hono app directly with @hono/node-server so `vercel dev`
 * doesn't recurse into itself.
 */
import { serve } from '@hono/node-server';
import app from './server/app';

const port = parseInt(process.env.PORT ?? '3001', 10);
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`[dev] Hono app listening on http://localhost:${port}`);
});

// Graceful shutdown
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
