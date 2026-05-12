import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  createProject,
  packageNameFromProject,
  parseCliArgs,
  resolveCreateOptions,
} from './core';
import {
  agentAuthModes,
  buildFiles,
  defaultCumulusDbMode,
  templateNames,
  type RenderOptions,
} from './templates';

function options(
  template: RenderOptions['template'],
  agentAuth: RenderOptions['agentAuth'],
  cumulusDb = defaultCumulusDbMode(template),
): RenderOptions {
  return {
    projectName: 'my-acme',
    packageName: 'my-acme',
    companyName: 'Acme Inc',
    template,
    agentAuth,
    cumulusDb,
    packageManager: 'npm',
  };
}

describe('parseCliArgs', () => {
  it('parses the documented non-interactive interface', () => {
    expect(
      parseCliArgs([
        'my-acme',
        '--template',
        'full',
        '--agent-auth',
        'self-hosted',
        '--cumulus-db',
        'both',
        '--company',
        'Acme Inc',
        '--package-manager',
        'pnpm',
        '--no-install',
        '--git',
      ]),
    ).toEqual({
      projectName: 'my-acme',
      template: 'full',
      agentAuth: 'self-hosted',
      cumulusDb: 'both',
      companyName: 'Acme Inc',
      packageManager: 'pnpm',
      install: false,
      git: true,
      help: false,
    });
  });

  it('accepts public template names and legacy aliases', () => {
    expect(parseCliArgs(['demo', '--template', 'outer']).template).toBe('marketing');
    expect(parseCliArgs(['demo', '--template', 'inner']).template).toBe('inside');
    expect(parseCliArgs(['demo', '--template', 'marketing']).template).toBe('marketing');
    expect(parseCliArgs(['demo', '--template', 'inside']).template).toBe('inside');
  });

  it('rejects unknown templates before writing files', () => {
    expect(() => parseCliArgs(['demo', '--template', 'unknown'])).toThrow(
      /invalid --template/,
    );
  });

  it('rejects unknown Cumulus DB modes before writing files', () => {
    expect(() => parseCliArgs(['demo', '--cumulus-db', 'embedded'])).toThrow(
      /invalid --cumulus-db/,
    );
  });

  it('rejects unknown flags instead of silently ignoring them', () => {
    expect(() => parseCliArgs(['demo', '--cwd', '/tmp/out'])).toThrow(
      /unknown option --cwd/,
    );
  });
});

describe('naming', () => {
  it('normalizes project names into package names', () => {
    expect(packageNameFromProject('Acme Agent App')).toBe('acme-agent-app');
    expect(packageNameFromProject('@scope/demo')).toBe('demo');
  });

  it('uses --company as the real project name when the positional name is a placeholder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'create-cumulus-'));
    const parsed = parseCliArgs([
      'my-acme',
      '--company',
      'Launch Labs',
      '--no-install',
      '--no-git',
    ]);
    const createOptions = await resolveCreateOptions(parsed, root);

    expect(createOptions.projectName).toBe('launch-labs');
    expect(createOptions.packageName).toBe('launch-labs');
    expect(createOptions.companyName).toBe('Launch Labs');
    expect(createOptions.cumulusDb).toBe('both');
    expect(createOptions.targetDir).toBe(join(root, 'launch-labs'));
  });

  it('defaults outer projects to hosted Cumulus DB only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'create-cumulus-'));
    const parsed = parseCliArgs([
      'outer-demo',
      '--template',
      'outer',
      '--no-install',
      '--no-git',
    ]);
    const createOptions = await resolveCreateOptions(parsed, root);

    expect(createOptions.template).toBe('marketing');
    expect(createOptions.cumulusDb).toBe('cloud');
  });

  it('preserves explicit non-placeholder directories when --company is different', async () => {
    const root = await mkdtemp(join(tmpdir(), 'create-cumulus-'));
    const parsed = parseCliArgs([
      'custom-relay-dir',
      '--company',
      'Launch Labs',
      '--no-install',
      '--no-git',
    ]);
    const createOptions = await resolveCreateOptions(parsed, root);

    expect(createOptions.projectName).toBe('custom-relay-dir');
    expect(createOptions.packageName).toBe('custom-relay-dir');
    expect(createOptions.companyName).toBe('Launch Labs');
    expect(createOptions.targetDir).toBe(join(root, 'custom-relay-dir'));
  });

  it('derives the folder and package from --company when no positional name is provided', async () => {
    const root = await mkdtemp(join(tmpdir(), 'create-cumulus-'));
    const parsed = parseCliArgs(['--company', 'Launch Labs', '--no-install', '--no-git']);
    const createOptions = await resolveCreateOptions(parsed, root);

    expect(createOptions.projectName).toBe('launch-labs');
    expect(createOptions.packageName).toBe('launch-labs');
    expect(createOptions.targetDir).toBe(join(root, 'launch-labs'));
  });
});

describe('buildFiles', () => {
  it('renders all template/auth combinations', () => {
    for (const template of templateNames) {
      for (const agentAuth of agentAuthModes) {
        const files = buildFiles(options(template, agentAuth));
        const publicTemplate =
          template === 'marketing' ? 'outer' : template === 'inside' ? 'inner' : template;
        expect(files.get('README.md')).toContain(`Template: \`${publicTemplate}\``);
        expect(files.get('README.md')).toContain(`Agent auth mode: \`${agentAuth}\``);
        expect(files.get('README.md')).toContain('Cumulus DB mode: `');
        expect(files.get('package.json')).not.toContain('@cumulus/server');
        expect(files.get('app/globals.css')).toContain('@import "tailwindcss"');
        expect(files.get('app/components/DashboardShell.tsx')).toContain('relay-app');
        expect(files.get('src/relay/webhook.ts')).toContain('export const relay');
        expect(files.get('app/.well-known/relay.json/route.ts')).toContain(
          'signupWebhookUrl',
        );
        expect(files.get('app/api/relay-login/route.ts')).toContain('jwtVerify');
        expect(files.get('app/api/agent-signup/route.ts')).toContain('relay.webhook');
        expect(files.get('app/api/actions/route.ts')).toContain('ActionPayload');
        expect(files.get('app/api/actions/route.ts')).toContain('invalid_json');
        expect(files.get('app/api/actions/route.ts')).toContain(
          'actions_secret_not_configured',
        );
        expect(files.get('src/relay/webhook.ts')).toContain(
          'webhook_secret_not_configured',
        );

        if (agentAuth === 'self-hosted') {
          expect(files.has('app/v1/[[...path]]/route.ts')).toBe(true);
          expect(files.has('app/mcp/route.ts')).toBe(true);
          expect(files.has('app/openapi.json/route.ts')).toBe(true);
          expect(files.has('src/server/app.ts')).toBe(true);
          expect(files.has('src/mcp/server.ts')).toBe(true);
          expect(files.get('src/server/db/index.ts')).toContain('resolveDatabaseDriver');
          expect(files.get('src/server/db/index.ts')).toContain("drizzle-orm/postgres-js");
          expect(files.has('migrations/0000_empty_morgan_stark.sql')).toBe(true);
        }

        if (template === 'full' || template === 'inside' || agentAuth === 'self-hosted') {
          expect(files.get('scripts/apply-migration.ts')).toContain('configured Relay');
          expect(files.get('scripts/apply-migration.ts')).toContain('db.execute');
          expect(files.get('scripts/check-schema.ts')).toContain('db.execute');
          expect(files.get('scripts/register-cumulus-tenant.ts')).toContain('db.execute');
          expect(files.get('scripts/apply-migration.ts')).not.toContain('@neondatabase/serverless');
          expect(files.get('scripts/check-schema.ts')).not.toContain('@neondatabase/serverless');
          expect(files.get('scripts/register-cumulus-tenant.ts')).not.toContain('@neondatabase/serverless');
        }

        if (template === 'full' || template === 'inside') {
          expect(files.has('app/(user)/me/page.tsx')).toBe(true);
          expect(files.has('app/(dev)/dev/page.tsx')).toBe(true);
          expect(files.has('app/dashboard/page.tsx')).toBe(true);
          expect(files.has('app/(user)/me/database/page.tsx')).toBe(true);
        } else {
          expect(files.has('app/(user)/me/page.tsx')).toBe(false);
        }

        if (template === 'full' || template === 'inside' || template === 'agent-auth') {
          expect(files.has('app/api/cumulus-db/env/parse/route.ts')).toBe(true);
          expect(files.has('app/api/cumulus-db/health/route.ts')).toBe(true);
          expect(files.has('app/api/cumulus-db/mcp/route.ts')).toBe(true);
          expect(files.has('app/api/cumulus-db/databases/[id]/events/route.ts')).toBe(true);
          expect(files.has('app/api/cumulus-db/databases/[id]/kv/[key]/route.ts')).toBe(true);
          expect(files.has('app/api/cumulus-db/databases/[id]/tokens/route.ts')).toBe(true);
          expect(files.has('app/api/cumulus-db/databases/[id]/backups/route.ts')).toBe(true);
          expect(files.has('app/api/cumulus-db/databases/[id]/compact/route.ts')).toBe(true);
          expect(files.has('src/lib/cumulus-db/server.ts')).toBe(true);
          expect(files.get('app/components/CumulusDatabasePanel.tsx')).toContain('Token management');
          expect(files.get('app/components/CumulusDatabasePanel.tsx')).toContain('Backup and compact');
          expect(files.get('app/components/CumulusDatabasePanel.tsx')).toContain('placeholder="Scoped token"');
        }

        if (template === 'agent-auth') {
          expect(files.has('app/database/page.tsx')).toBe(true);
        }

        if (template === 'marketing') {
          expect(files.has('apps/cumulus-db/package.json')).toBe(false);
          expect(files.has('app/api/cumulus-db/env/parse/route.ts')).toBe(false);
        } else {
          expect(files.has('apps/cumulus-db/package.json')).toBe(true);
          expect(files.has('apps/cumulus-db/LICENSE')).toBe(true);
          expect(files.has('apps/cumulus-db/NOTICE')).toBe(true);
          expect(files.has('scripts/create-cumulus-db-workspace.ts')).toBe(true);
          expect(files.get('package.json')).toContain('cumulus-db:workspace');
          expect(files.get('apps/cumulus-db/src/config.ts')).toContain('CumulusDbConfigEnv');
        }

        if (template === 'full' || template === 'marketing') {
          expect(files.has('app/docs/page.tsx')).toBe(true);
          expect(files.has('app/pricing/page.tsx')).toBe(true);
        }
      }
    }
  });

  it('replaces company text and leaves no template placeholders', () => {
    const files = buildFiles(options('full', 'hosted'));
    const allContent = [...files.values()]
      .filter((value): value is string => typeof value === 'string')
      .join('\n---file---\n');
    expect(allContent).toContain('Acme Inc');
    expect(files.get('app/layout.tsx')).toContain('Acme Inc');
    expect(files.get('app/legal/privacy/page.tsx')).toContain(
      'Operator: Acme Inc',
    );
    expect(files.get('app/legal/terms/page.tsx')).toContain(
      'operated by Acme Inc',
    );
    expect(allContent).not.toContain('__COMPANY_NAME__');
    expect(allContent).not.toContain('__PROJECT_NAME__');
  });

  it('does not ship official Cumulus legal contacts in generated public pages', () => {
    const files = buildFiles(options('full', 'self-hosted'));
    const publicPages = [
      files.get('app/legal/privacy/page.tsx'),
      files.get('app/legal/terms/page.tsx'),
      files.get('app/security/page.tsx'),
      files.get('app/trust/page.tsx'),
    ].join('\n');

    expect(publicPages).not.toContain('5757 Woodway Drive');
    expect(publicPages).not.toContain('security@cumulush.com');
    expect(publicPages).not.toContain('privacy@cumulush.com');
    expect(publicPages).not.toContain('generated app templates are MIT-licensed');
  });

  it('includes binary brand font assets', () => {
    const files = buildFiles(options('agent-auth', 'hosted'));
    const font = files.get('public/fonts/PlusJakartaSans/PlusJakartaSans-Regular.ttf');
    expect(font).toBeInstanceOf(Uint8Array);
  });

  it('keeps cloud-only agent auth MIT and excludes local Cumulus DB files', () => {
    const files = buildFiles(options('agent-auth', 'hosted', 'cloud'));

    expect(files.get('package.json')).toContain('"license": "MIT"');
    expect(files.has('apps/cumulus-db/package.json')).toBe(false);
    expect(files.has('scripts/create-cumulus-db-workspace.ts')).toBe(false);
    expect(files.has('app/database/page.tsx')).toBe(true);
    expect(files.get('.env.example')).toContain('CUMULUS_DB_PUBLIC_URL=https://db.cumulush.com');
  });

  it('emits safer dependency pins and env defaults for local Relay templates', () => {
    const files = buildFiles(options('full', 'hosted', 'both'));
    const packageJson = files.get('package.json');

    expect(packageJson).toContain('"postgres": "^3.4.9"');
    expect(packageJson).toContain('"workflow": "^4.2.4"');
    expect(packageJson).toContain('"devalue": "^5.8.0"');
    expect(packageJson).toContain('"esbuild": "^0.28.0"');
    expect(packageJson).toContain('"undici": "^7.25.0"');
    expect(files.get('.env.example')).toContain('DATABASE_DRIVER=');
    expect(files.get('.env.example')).toContain('LOG_LEVEL=info');
  });

  it('documents AGPL cloud-only full and inner templates clearly', () => {
    const files = buildFiles(options('full', 'hosted', 'cloud'));

    expect(files.get('package.json')).toContain('"license": "AGPL-3.0-only"');
    expect(files.get('README.md')).toContain('Cloud-only does not always mean MIT');
  });

  it('adds local Cumulus DB service files, scripts, env, and AGPL license', () => {
    const files = buildFiles(options('agent-auth', 'hosted', 'both'));
    const packageJson = files.get('package.json');

    expect(files.has('apps/cumulus-db/package.json')).toBe(true);
    expect(files.has('apps/cumulus-db/src/server.ts')).toBe(true);
    expect(files.has('apps/cumulus-db/src/__tests__/http.test.ts')).toBe(true);
    expect(files.get('apps/cumulus-db/package.json')).toContain(
      '"license": "AGPL-3.0-only"',
    );
    expect(packageJson).toContain('"license": "AGPL-3.0-only"');
    expect(packageJson).toContain('"cumulus-db:build"');
    expect(packageJson).toContain('"cumulus-db:workspace"');
    expect(files.get('.env.example')).toContain('CUMULUS_DB_MASTER_KEY');
    expect(files.get('.env.example')).toContain('CUMULUS_DB_DATA_DIR');
    expect(files.get('README.md')).toContain('Relay Postgres');
    expect(files.get('README.md')).toContain('AGPL-3.0-only');
  });

  it('does not persist Cumulus DB bearer tokens in generated browser storage', () => {
    const files = buildFiles(options('agent-auth', 'hosted', 'both'));
    const panel = files.get('app/components/CumulusDatabasePanel.tsx');

    expect(panel).toContain("headers.set('Authorization', `Bearer ${token}`)");
    expect(panel).toContain('JSON.stringify({ databaseId: id })');
    expect(panel).not.toContain('token: scopedToken');
  });

  it('documents local Cumulus DB when outer projects explicitly request it', () => {
    const files = buildFiles(options('marketing', 'hosted', 'local'));

    expect(files.has('apps/cumulus-db/package.json')).toBe(true);
    expect(files.has('app/api/cumulus-db/env/parse/route.ts')).toBe(false);
    expect(files.get('.env.example')).toContain('CUMULUS_DB_MASTER_KEY');
    expect(files.get('README.md')).toContain('Cumulus DB mode: `local`');
    expect(files.get('package.json')).toContain('"license": "AGPL-3.0-only"');
  });
});

describe('createProject', () => {
  it('writes a hosted project and refuses to overwrite non-empty directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'create-cumulus-'));
    const parsed = parseCliArgs([
      'demo',
      '--template',
      'agent-auth',
      '--agent-auth',
      'hosted',
      '--company',
      'Demo Co',
      '--no-install',
      '--no-git',
    ]);
    const createOptions = await resolveCreateOptions(parsed, root);
    const result = await createProject(createOptions);

    expect(result.filesWritten).toContain('package.json');
    expect(result.filesWritten).toContain('app/api/relay-login/route.ts');
    await expect(createProject(createOptions)).rejects.toThrow(/not empty/);
  });

  it('refuses an existing non-empty target before writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'create-cumulus-'));
    const target = join(root, 'existing');
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'do not overwrite');

    const parsed = parseCliArgs(['existing', '--no-install', '--no-git']);
    const createOptions = await resolveCreateOptions(parsed, root);
    await expect(createProject(createOptions)).rejects.toThrow(/not empty/);
  });
});
