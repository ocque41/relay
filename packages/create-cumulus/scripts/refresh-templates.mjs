#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageDir, '..', '..');
const templatesDir = join(packageDir, 'templates');

const tracked = execFileSync('git', ['ls-files'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

function isTestFile(path) {
  return /\.(test|spec)\.tsx?$/.test(path);
}

function copyGroup(group, files) {
  const targetRoot = join(templatesDir, group);
  for (const file of files) {
    const from = join(repoRoot, file);
    const to = join(targetRoot, file);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
}

function exact(...files) {
  const wanted = new Set(files);
  return tracked.filter((file) => wanted.has(file));
}

function prefix(...prefixes) {
  return tracked.filter((file) => prefixes.some((p) => file.startsWith(p)));
}

function without(files, predicate) {
  return files.filter((file) => !predicate(file));
}

mkdirSync(templatesDir, { recursive: true });
for (const group of ['common', 'public', 'inside', 'server', 'licenses']) {
  rmSync(join(templatesDir, group), { recursive: true, force: true });
}

copyGroup('common', [
  ...prefix('app/components/', 'public/fonts/'),
  ...exact(
    'app/fonts.ts',
    'app/globals.css',
    'app/layout.tsx',
    'app/router.ts',
    'app/theme.ts',
    'postcss.config.mjs',
    'public/.gitkeep',
    'public/favicon.ico',
  ),
]);

copyGroup('public', [
  ...without(prefix('app/docs/'), (file) => file === 'app/docs/api/route.ts'),
  ...prefix('app/legal/', 'app/partner/', 'app/pricing/'),
  ...exact(
    'app/opengraph-image.tsx',
    'app/page.tsx',
    'app/robots.ts',
    'app/security/page.tsx',
    'app/sitemap.ts',
    'app/trust/page.tsx',
    'app/twitter-image.tsx',
  ),
]);

copyGroup('inside', [
  ...prefix(
    'app/(dev)/',
    'app/(share)/',
    'app/(user)/',
    'app/cli-auth/',
    'app/dashboard/',
  ),
  ...exact(
    'app/WorkspaceSwitcher.tsx',
    'app/login/page.tsx',
    'app/router.ts',
    'app/workspace-actions.ts',
  ),
]);

copyGroup('server', [
  ...without(prefix('src/'), isTestFile),
  ...prefix('migrations/', 'workflows/'),
  ...exact(
    'app/.well-known/jwks.json/route.ts',
    'app/.well-known/relay.json/route.ts',
    'app/AGENTS.md/route.ts',
    'app/CLAUDE.md/route.ts',
    'app/docs/api/route.ts',
    'app/health/route.ts',
    'app/llms-full.txt/route.ts',
    'app/llms.txt/route.ts',
    'app/mcp/route.ts',
    'app/openapi.json/route.ts',
    'app/v1/[[...path]]/route.ts',
    'drizzle.config.ts',
    'instrumentation.ts',
    'scripts/apply-migration.ts',
    'scripts/apply-pending-migrations.ts',
    'scripts/check-schema.ts',
    'scripts/create-demo-accounts.ts',
    'scripts/register-cumulus-database-provider.ts',
    'scripts/register-cumulus-tenant.ts',
    'scripts/rotate-master-key.ts',
    'vercel.ts',
  ),
]);

copyGroup('licenses', exact('LICENSE'));
mkdirSync(join(templatesDir, 'licenses'), { recursive: true });
cpSync(join(templatesDir, 'licenses', 'LICENSE'), join(templatesDir, 'licenses', 'AGPL-3.0-only.txt'));
rmSync(join(templatesDir, 'licenses', 'LICENSE'), { force: true });

console.log('create-cumulus templates refreshed from tracked Relay files.');
