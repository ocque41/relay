import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const templateNames = ['full', 'marketing', 'inside', 'agent-auth'] as const;
export const agentAuthModes = ['hosted', 'self-hosted'] as const;
export const packageManagers = ['npm', 'pnpm', 'yarn', 'bun'] as const;

export type TemplateName = (typeof templateNames)[number];
export type AgentAuthMode = (typeof agentAuthModes)[number];
export type PackageManager = (typeof packageManagers)[number];
export type FileContent = string | Uint8Array;
export type FileMap = Map<string, FileContent>;

export interface RenderOptions {
  projectName: string;
  packageName: string;
  companyName: string;
  template: TemplateName;
  agentAuth: AgentAuthMode;
  packageManager: PackageManager;
}

type TokenMap = Record<string, string>;

const templateRoot = join(fileURLToPath(new URL('..', import.meta.url)), 'templates');

const textExtensions = new Set([
  '',
  '.css',
  '.env',
  '.example',
  '.gitignore',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.sql',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

const textBasenames = new Set([
  '.env.example',
  '.gitignore',
  '.vercelignore',
  'LICENSE',
  'README',
]);

export function isTemplateName(value: string): value is TemplateName {
  return (templateNames as readonly string[]).includes(value);
}

export function isAgentAuthMode(value: string): value is AgentAuthMode {
  return (agentAuthModes as readonly string[]).includes(value);
}

export function isPackageManager(value: string): value is PackageManager {
  return (packageManagers as readonly string[]).includes(value);
}

export function publicTemplateName(template: TemplateName): string {
  if (template === 'marketing') return 'outer';
  if (template === 'inside') return 'inner';
  return template;
}

function hasMarketing(template: TemplateName): boolean {
  return template === 'full' || template === 'marketing';
}

function hasInside(template: TemplateName): boolean {
  return template === 'full' || template === 'inside';
}

function usesLocalRelayStack(o: RenderOptions): boolean {
  return hasInside(o.template) || o.agentAuth === 'self-hosted';
}

function generatedLicense(o: RenderOptions): 'AGPL-3.0-only' | 'MIT' {
  return usesLocalRelayStack(o) ? 'AGPL-3.0-only' : 'MIT';
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function tokenMap(o: RenderOptions): TokenMap {
  const publicTemplate = publicTemplateName(o.template);
  const baseUrl = 'http://localhost:3000';
  const relayBase =
    o.agentAuth === 'self-hosted' ? baseUrl : 'https://relay.cumulush.com';

  return {
    __PROJECT_NAME__: o.projectName,
    __PACKAGE_NAME__: o.packageName,
    __COMPANY_NAME__: o.companyName,
    __TEMPLATE_NAME__: publicTemplate,
    __AGENT_AUTH_MODE__: o.agentAuth,
    __APP_BASE_URL__: baseUrl,
    __RELAY_ENDPOINT__: `${relayBase}/v1`,
    __RELAY_ISSUER__: relayBase,
    __RELAY_JWKS_URI__: `${relayBase}/.well-known/jwks.json`,
  };
}

function replaceTokens(content: string, tokens: TokenMap): string {
  let out = content;
  for (const [token, value] of Object.entries(tokens)) {
    out = out.split(token).join(value);
  }
  return out;
}

function isTextFile(filePath: string): boolean {
  const name = basename(filePath);
  if (textBasenames.has(name)) return true;
  return textExtensions.has(extname(name));
}

function toProjectPath(path: string): string {
  return path.split(sep).join('/');
}

function readTemplateDir(name: string, tokens: TokenMap): FileMap {
  const dir = join(templateRoot, name);
  const files: FileMap = new Map();
  if (!existsSync(dir)) return files;

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.DS_Store') continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      const projectPath = toProjectPath(relative(dir, absolute));
      const raw = readFileSync(absolute);
      files.set(
        projectPath,
        isTextFile(projectPath)
          ? replaceTokens(raw.toString('utf8'), tokens)
          : new Uint8Array(raw),
      );
    }
  };

  walk(dir);
  return files;
}

function merge(files: FileMap, incoming: FileMap): void {
  for (const [path, content] of incoming) {
    files.set(path, content);
  }
}

function relayDependencies(): Record<string, string> {
  return {
    '@hono/node-server': '^1.19.14',
    '@hono/zod-openapi': '^1.3.0',
    '@modelcontextprotocol/sdk': '^1.29.0',
    '@neondatabase/serverless': '^1.0.2',
    '@sentry/node': '^10.49.0',
    '@simplewebauthn/browser': '^13.3.0',
    '@simplewebauthn/server': '^13.3.0',
    ajv: '^8.18.0',
    'ajv-formats': '^3.0.1',
    'drizzle-orm': '^0.45.2',
    hono: '^4.12.14',
    jose: '^6.2.2',
    next: '^16.2.4',
    pino: '^10.3.1',
    react: '^19.2.5',
    'react-dom': '^19.2.5',
    stripe: '^22.0.2',
    workflow: '^4.2.2',
    zod: '^4.3.6',
  };
}

function hostedDependencies(): Record<string, string> {
  return {
    jose: '^6.2.2',
    next: '^16.2.4',
    react: '^19.2.5',
    'react-dom': '^19.2.5',
  };
}

function relayDevDependencies(): Record<string, string> {
  return {
    '@tailwindcss/postcss': '^4.2.2',
    '@types/node': '^25.6.0',
    '@types/react': '^19.2.14',
    '@types/react-dom': '^19.2.3',
    '@vercel/config': '^0.2.0',
    'drizzle-kit': '^0.31.10',
    'pino-pretty': '^13.1.3',
    postcss: '^8.5.12',
    tailwindcss: '^4.2.2',
    tsx: '^4.21.0',
    typescript: '^5.9.3',
    vitest: '^4.1.4',
  };
}

function hostedDevDependencies(): Record<string, string> {
  return {
    '@tailwindcss/postcss': '^4.2.2',
    '@types/node': '^25.6.0',
    '@types/react': '^19.2.14',
    '@types/react-dom': '^19.2.3',
    postcss: '^8.5.12',
    tailwindcss: '^4.2.2',
    typescript: '^5.9.3',
    vitest: '^4.1.4',
  };
}

function packageJson(o: RenderOptions): string {
  const localRelay = usesLocalRelayStack(o);
  return `${json({
    name: o.packageName,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'next dev',
      build: 'next build',
      start: 'next start',
      typecheck: 'tsc --noEmit',
      test: 'vitest run --passWithNoTests',
      ...(localRelay
        ? {
            'db:migrate': 'tsx scripts/apply-pending-migrations.ts',
            'db:check': 'tsx scripts/check-schema.ts',
          }
        : {}),
    },
    dependencies: localRelay ? relayDependencies() : hostedDependencies(),
    devDependencies: localRelay ? relayDevDependencies() : hostedDevDependencies(),
    license: generatedLicense(o),
  })}\n`;
}

function tsconfig(o: RenderOptions): string {
  const plugins = [{ name: 'next' }];
  if (usesLocalRelayStack(o)) plugins.push({ name: 'workflow' });
  return `${json({
    compilerOptions: {
      target: 'ES2022',
      lib: ['dom', 'dom.iterable', 'esnext'],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: 'react-jsx',
      incremental: true,
      plugins,
      paths: { '@/*': ['./*'] },
    },
    include: [
      'next-env.d.ts',
      '**/*.ts',
      '**/*.tsx',
      '.next/types/**/*.ts',
      '.next/dev/types/**/*.ts',
    ],
    exclude: ['node_modules', '.next', '.vercel'],
  })}\n`;
}

function nextConfig(o: RenderOptions): string {
  if (!usesLocalRelayStack(o)) {
    return `import type { NextConfig } from 'next';\n\nconst nextConfig: NextConfig = {};\n\nexport default nextConfig;\n`;
  }

  return `import type { NextConfig } from 'next';\nimport { withWorkflow } from 'workflow/next';\n\nconst nextConfig: NextConfig = {\n  webpack: (config) => {\n    config.resolve = config.resolve ?? {};\n    config.resolve.extensionAlias = {\n      ...(config.resolve.extensionAlias as Record<string, string[]> | undefined),\n      '.js': ['.ts', '.tsx', '.js', '.jsx'],\n    };\n    return config;\n  },\n  turbopack: {\n    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.mjs'],\n    resolveAlias: {},\n  },\n  serverExternalPackages: ['workflow', '@workflow/next'],\n};\n\nexport default withWorkflow(nextConfig);\n`;
}

function envExample(o: RenderOptions): string {
  const localRelay = usesLocalRelayStack(o);
  const shared = `# ${o.companyName} — generated by create-cumulus\nAPP_BASE_URL=http://localhost:3000\nSESSION_SECRET=\n\n# Relay agent-auth bootstrap\nRELAY_ENDPOINT=${o.agentAuth === 'self-hosted' ? 'http://localhost:3000/v1' : 'https://relay.cumulush.com/v1'}\nRELAY_TENANT_ID=\nRELAY_TENANT_SLUG=${o.packageName}\nRELAY_ISSUER=${o.agentAuth === 'self-hosted' ? 'http://localhost:3000' : 'https://relay.cumulush.com'}\nRELAY_JWKS_URI=${o.agentAuth === 'self-hosted' ? 'http://localhost:3000/.well-known/jwks.json' : 'https://relay.cumulush.com/.well-known/jwks.json'}\nRELAY_WEBHOOK_SECRET=\nRELAY_ACTIONS_SECRET=\n`;

  if (!localRelay) return `${shared}\n`;

  return `${shared}\n# Local Relay control plane\nDATABASE_URL=\nMASTER_KEY=\nRELAY_JWT_PRIVATE_KEY=\nEMAIL_SENDGRID_SECRET=\nCATCHALL_DOMAIN=inbox.example.com\nRESEND_API_KEY=\nRELAY_FROM_ADDRESS=noreply@example.com\nWEBAUTHN_RP_ID=localhost\nWEBAUTHN_RP_NAME=Relay\nWEBAUTHN_ORIGIN=http://localhost:3000\n\n# Optional built-in providers\nNEON_API_KEY=\nVERCEL_API_TOKEN=\n\n# Optional billing\nSTRIPE_SECRET_KEY=\nSTRIPE_WEBHOOK_SECRET=\nSTRIPE_PRICE_BUILDER=\nSTRIPE_PRICE_STARTER=\nSTRIPE_PRICE_GROWTH=\nSTRIPE_PRICE_SCALE=\nBILLING_ENFORCEMENT=off\nBILLING_FAIRNESS=on\nABUSE_ENFORCEMENT=warn\nUSER_SIGNUP_MONTHLY_LIMIT=50\nLOG_LEVEL=\nSENTRY_DSN=\nSENTRY_TRACES_SAMPLE_RATE=0.1\n`;
}

function readme(o: RenderOptions): string {
  const publicTemplate = publicTemplateName(o.template);
  const localRelay = usesLocalRelayStack(o);
  const devCommand = o.packageManager === 'npm' ? 'npm run dev' : `${o.packageManager} dev`;
  const migrateCommand =
    o.packageManager === 'npm' ? 'npm run db:migrate' : `${o.packageManager} db:migrate`;
  const modeText =
    o.agentAuth === 'hosted'
      ? 'Hosted mode connects those surfaces to hosted Cumulus Cloud by default.'
      : "Self-hosted mode points those surfaces at this app's local Relay API/MCP service.";
  const localRelayText = localRelay
    ? `## Self Hosting

This template includes the Relay API, MCP server, Drizzle schema, migrations, workflows, dashboards, and auth surfaces. Fill \`DATABASE_URL\`, \`MASTER_KEY\`, \`SESSION_SECRET\`, and \`RELAY_JWT_PRIVATE_KEY\`, then run:

\`\`\`bash
${migrateCommand}
\`\`\`
`
    : `## Hosted Integration

This template is intentionally small. It keeps Relay-branded UI and app-side webhook endpoints while hosted Cumulus Cloud runs the agent-auth control plane.
`;

  return `# ${o.companyName}

Generated with \`create-cumulus\`.

- Template: \`${publicTemplate}\`
- Agent auth mode: \`${o.agentAuth}\`
- License: \`${generatedLicense(o)}\`

This scaffold keeps the Relay/Cumulus user experience, theme, components, and agent-auth shape.

## Run

\`\`\`bash
${o.packageManager} install
cp .env.example .env.local
${devCommand}
\`\`\`

Open http://localhost:3000.

## Agent Auth

The app exposes:

- \`/.well-known/relay.json\`
- \`/api/relay-login\`
- \`/api/agent-signup\`
- \`/api/actions\`

${modeText}

${localRelayText}
`;
}

function gitignore(): string {
  return `node_modules/\n.next/\nout/\ndist/\n.env\n.env.local\n.env.*.local\n!.env.example\n.DS_Store\n*.tsbuildinfo\n`;
}

function mitLicense(o: RenderOptions): string {
  return `MIT License\n\nCopyright (c) 2026 ${o.companyName}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`;
}

function license(o: RenderOptions, tokens: TokenMap): string {
  if (generatedLicense(o) === 'MIT') return mitLicense(o);
  const agpl = readTemplateDir('licenses', tokens).get('AGPL-3.0-only.txt');
  if (typeof agpl !== 'string') {
    throw new Error('missing AGPL license template');
  }
  return agpl;
}

export function buildFiles(o: RenderOptions): FileMap {
  const tokens = tokenMap(o);
  const files: FileMap = new Map();

  merge(files, readTemplateDir('common', tokens));

  if (hasMarketing(o.template)) {
    merge(files, readTemplateDir('public', tokens));
  }

  if (hasInside(o.template)) {
    merge(files, readTemplateDir('inside', tokens));
  }

  if (usesLocalRelayStack(o)) {
    merge(files, readTemplateDir('server', tokens));
  }

  merge(files, readTemplateDir('integration', tokens));

  if (o.template === 'inside') {
    merge(files, readTemplateDir('overrides/inside', tokens));
  }

  if (o.template === 'agent-auth') {
    merge(files, readTemplateDir('overrides/agent-auth', tokens));
  }

  files.set('package.json', packageJson(o));
  files.set('README.md', readme(o));
  files.set('LICENSE', license(o, tokens));
  files.set('.gitignore', gitignore());
  files.set('.env.example', envExample(o));
  files.set('tsconfig.json', tsconfig(o));
  files.set('next.config.ts', nextConfig(o));

  return files;
}
