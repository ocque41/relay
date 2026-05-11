/**
 * Shared Hono-to-Next.js adapter. Every route.ts file in `app/` that forwards
 * to Hono imports from this module so we keep a single source of truth for
 * which HTTP methods are accepted.
 */
import { handle } from 'hono/vercel';
import app from './app';

const h = handle(app);

export const GET = h;
export const POST = h;
export const PUT = h;
export const PATCH = h;
export const DELETE = h;
export const OPTIONS = h;
export const HEAD = h;
