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
import { agentAuthModes, buildFiles, templateNames, type RenderOptions } from './templates';

function options(
  template: RenderOptions['template'],
  agentAuth: RenderOptions['agentAuth'],
): RenderOptions {
  return {
    projectName: 'my-acme',
    packageName: 'my-acme',
    companyName: 'Acme Inc',
    template,
    agentAuth,
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
});

describe('naming', () => {
  it('normalizes project names into package names', () => {
    expect(packageNameFromProject('Acme Agent App')).toBe('acme-agent-app');
    expect(packageNameFromProject('@scope/demo')).toBe('demo');
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

        if (agentAuth === 'self-hosted') {
          expect(files.has('app/v1/[[...path]]/route.ts')).toBe(true);
          expect(files.has('app/mcp/route.ts')).toBe(true);
          expect(files.has('app/openapi.json/route.ts')).toBe(true);
          expect(files.has('src/server/app.ts')).toBe(true);
          expect(files.has('src/mcp/server.ts')).toBe(true);
          expect(files.has('migrations/0000_empty_morgan_stark.sql')).toBe(true);
        }

        if (template === 'full' || template === 'inside') {
          expect(files.has('app/(user)/me/page.tsx')).toBe(true);
          expect(files.has('app/(dev)/dev/page.tsx')).toBe(true);
          expect(files.has('app/dashboard/page.tsx')).toBe(true);
        } else {
          expect(files.has('app/(user)/me/page.tsx')).toBe(false);
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
    expect(allContent).not.toContain('__COMPANY_NAME__');
    expect(allContent).not.toContain('__PROJECT_NAME__');
  });

  it('includes binary brand font assets', () => {
    const files = buildFiles(options('agent-auth', 'hosted'));
    const font = files.get('public/fonts/PlusJakartaSans/PlusJakartaSans-Regular.ttf');
    expect(font).toBeInstanceOf(Uint8Array);
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
