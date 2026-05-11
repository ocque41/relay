/**
 * Production smoke — checks the public surface after a deploy.
 *
 * Fires HEAD/GET against the public marketing, docs, health, OpenAPI, JWKS,
 * and MCP routes. Exits non-zero if anything unexpected returns 4xx/5xx.
 *
 * Usage:
 *   npx tsx scripts/smoke-prod.ts
 *   BASE=https://relay.cumulush.com npx tsx scripts/smoke-prod.ts
 *   BASE=http://localhost:3000 npx tsx scripts/smoke-prod.ts   # dev smoke
 *
 * This script does NOT exercise authenticated flows — those live in the
 * full smoke matrix and require a browser session + a Stripe test card.
 */
export {};

const BASE = (process.env.BASE ?? 'https://relay.cumulush.com').replace(/\/+$/, '');

type Check = { name: string; url: string; ok: boolean; detail: string };
const results: Check[] = [];

async function check(name: string, url: string, opts?: RequestInit & { expect?: number | number[] }): Promise<void> {
  const expect = opts?.expect ?? 200;
  const expected = Array.isArray(expect) ? expect : [expect];
  const start = Date.now();
  try {
    const res = await fetch(url, opts);
    const ms = Date.now() - start;
    const ok = expected.includes(res.status);
    results.push({
      name,
      url,
      ok,
      detail: `${res.status} ${res.statusText} (${ms}ms)${ok ? '' : ` — expected ${expected.join('|')}`}`,
    });
  } catch (err) {
    results.push({
      name,
      url,
      ok: false,
      detail: `fetch failed — ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function main() {
  console.log(`→ Smoke against ${BASE}\n`);

  // 1. Liveness + openapi
  await check('health',      `${BASE}/health`);
  await check('openapi',     `${BASE}/openapi.json`);
  await check('jwks',        `${BASE}/.well-known/jwks.json`);

  // 2. Public marketing pages
  await check('landing',     `${BASE}/`);
  await check('pricing',     `${BASE}/pricing`);
  await check('docs root',   `${BASE}/docs`);
  await check('docs developer', `${BASE}/docs/developer`);
  await check('docs agent builders', `${BASE}/docs/agent-builders`);
  await check('docs api',    `${BASE}/docs/api`);
  await check('privacy',     `${BASE}/legal/privacy`);
  await check('terms',       `${BASE}/legal/terms`);
  await check('security',    `${BASE}/security`);
  await check('trust',       `${BASE}/trust`);

  // 3. Indexability
  await check('sitemap',     `${BASE}/sitemap.xml`);
  await check('robots',      `${BASE}/robots.txt`);

  // 4. MCP endpoint — the Streamable HTTP transport requires
  //    `Accept: application/json, text/event-stream` per the MCP spec.
  //    A bare GET correctly fails with 406 (Not Acceptable). Accept any
  //    of the well-known "I'm alive but you didn't speak MCP" responses
  //    so the smoke proves the route is mounted, not that we know how
  //    to negotiate.
  await check(
    'mcp (GET)',
    `${BASE}/mcp`,
    { method: 'GET', expect: [200, 400, 405, 406] },
  );

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗';
    console.log(`  ${icon} ${r.name.padEnd(24)} ${r.detail}`);
  }

  console.log();
  if (failed.length === 0) {
    console.log(`OK: ${results.length}/${results.length} checks passed.`);
  } else {
    console.error(`FAIL: ${failed.length}/${results.length} checks failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('smoke-prod crashed:', err);
  process.exit(2);
});
