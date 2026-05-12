// Forward /docs/api to the Hono-served Swagger UI. Swagger UI ships as a
// single HTML page that points at /openapi.json, so this lets us serve it
// from the same handler that already generates the spec.
export { GET, HEAD, OPTIONS } from '@/src/server/next-handler';
