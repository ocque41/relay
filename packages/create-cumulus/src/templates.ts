export const templateNames = ['full', 'marketing', 'inside', 'agent-auth'] as const;
export const agentAuthModes = ['hosted', 'self-hosted'] as const;
export const packageManagers = ['npm', 'pnpm', 'yarn', 'bun'] as const;

export type TemplateName = (typeof templateNames)[number];
export type AgentAuthMode = (typeof agentAuthModes)[number];
export type PackageManager = (typeof packageManagers)[number];

export interface RenderOptions {
  projectName: string;
  packageName: string;
  companyName: string;
  template: TemplateName;
  agentAuth: AgentAuthMode;
  packageManager: PackageManager;
}

export type FileMap = Map<string, string>;

export function isTemplateName(value: string): value is TemplateName {
  return (templateNames as readonly string[]).includes(value);
}

export function isAgentAuthMode(value: string): value is AgentAuthMode {
  return (agentAuthModes as readonly string[]).includes(value);
}

export function isPackageManager(value: string): value is PackageManager {
  return (packageManagers as readonly string[]).includes(value);
}

function js(value: string): string {
  return JSON.stringify(value);
}

function titleFor(template: TemplateName): string {
  switch (template) {
    case 'full':
      return 'Full Cumulus Project';
    case 'marketing':
      return 'Cumulus Outer Site';
    case 'inside':
      return 'Cumulus Inner App';
    case 'agent-auth':
      return 'Cumulus Agent Auth Starter';
  }
}

function publicTemplateName(template: TemplateName): string {
  switch (template) {
    case 'marketing':
      return 'outer';
    case 'inside':
      return 'inner';
    default:
      return template;
  }
}

function hasMarketing(template: TemplateName): boolean {
  return template === 'full' || template === 'marketing';
}

function hasDashboard(template: TemplateName): boolean {
  return template === 'full' || template === 'inside';
}

function hasPlayground(template: TemplateName): boolean {
  return template === 'full' || template === 'inside' || template === 'agent-auth';
}

function packageJson(o: RenderOptions): string {
  const dependencies: Record<string, string> = {
    jose: '^6.2.2',
    next: '^16.2.4',
    react: '^19.2.5',
    'react-dom': '^19.2.5',
  };
  if (o.agentAuth === 'self-hosted') {
    dependencies['@hono/zod-openapi'] = '^1.3.0';
    dependencies.hono = '^4.12.14';
    dependencies.zod = '^4.3.6';
  }

  const devDependencies: Record<string, string> = {
    '@types/node': '^25.6.0',
    '@types/react': '^19.2.14',
    '@types/react-dom': '^19.2.3',
    typescript: '^5.9.3',
  };

  return `${JSON.stringify(
    {
      name: o.packageName,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        dev: 'next dev',
        build: 'next build',
        start: 'next start',
        typecheck: 'tsc --noEmit',
      },
      dependencies,
      devDependencies,
    },
    null,
    2,
  )}\n`;
}

function tsconfig(): string {
  return `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
`;
}

function envExample(o: RenderOptions): string {
  const relayDefaults =
    o.agentAuth === 'self-hosted'
      ? `# Self-hosted Relay-style API lives in this app.
RELAY_ENDPOINT=http://localhost:3000/v1
RELAY_ISSUER=http://localhost:3000
RELAY_JWKS_URI=http://localhost:3000/.well-known/jwks.json
`
      : `# Hosted Relay.
RELAY_ENDPOINT=https://relay.cumulush.com/v1
RELAY_ISSUER=https://relay.cumulush.com
RELAY_JWKS_URI=https://relay.cumulush.com/.well-known/jwks.json
`;

  const selfHosted =
    o.agentAuth === 'self-hosted'
      ? `
# Self-hosted persistence and provider settings.
DATABASE_URL=postgres://user:password@host:5432/cumulus
MASTER_KEY=replace-with-32-byte-base64
CATCHALL_DOMAIN=inbox.example.com
EMAIL_SENDGRID_SECRET=replace-me
NEON_API_KEY=
VERCEL_API_TOKEN=
RESEND_API_KEY=
`
      : '';

  return `# ${o.companyName}
APP_BASE_URL=http://localhost:3000
SESSION_SECRET=replace-with-at-least-32-random-characters

${relayDefaults}RELAY_TENANT_ID=replace-with-relay-tenant-id
RELAY_TENANT_SLUG=${o.packageName}
RELAY_WEBHOOK_SECRET=replace-with-relay-product-webhook-secret
RELAY_ACTIONS_SECRET=replace-with-relay-action-webhook-secret
${selfHosted}`;
}

function readme(o: RenderOptions): string {
  const authMode =
    o.agentAuth === 'hosted'
      ? 'Hosted Relay handles agent identity, attestation, signup dispatch, and action dispatch.'
      : 'This app includes a local Relay-style API/MCP surface for agent identity, signup, discovery, and actions.';

  return `# ${o.companyName}

Generated by \`create-cumulus\`.

## What this starter includes

- Template: \`${publicTemplateName(o.template)}\` (${titleFor(o.template)})
- Agent auth mode: \`${o.agentAuth}\`
- Relay-compatible discovery at \`/.well-known/relay.json\`
- Agent attestation login at \`/api/relay-login\`
- Signup webhook at \`/api/agent-signup\`
- Action webhook at \`/api/actions\`
${o.agentAuth === 'self-hosted' ? '- Local API at `/v1/*`, MCP placeholder at `/mcp`, and OpenAPI at `/openapi.json`\n' : ''}
${hasDashboard(o.template) ? '- Dashboard, /me workspace, settings, and playground pages\n' : ''}
${hasMarketing(o.template) ? '- Public marketing/docs pages\n' : ''}

${authMode}

## Start

\`\`\`bash
${o.packageManager} install
${o.packageManager === 'npm' ? 'npm run dev' : `${o.packageManager} dev`}
\`\`\`

Open http://localhost:3000.

## Configure

1. Copy \`.env.example\` to \`.env.local\`.
2. Fill the Relay and session values.
3. For hosted mode, register this project in Relay and paste the webhook secrets.
4. For self-hosted mode, connect a database before replacing the in-memory starter storage.

## Agent Flow

1. An agent reads \`/.well-known/relay.json\`.
2. The agent obtains an attestation JWT from Relay or the self-hosted API.
3. The agent posts that JWT to \`/api/relay-login\`.
4. Your app issues its own session cookie.
5. Relay signs signup and action webhooks to your server.

## License

MIT.
`;
}

function layout(o: RenderOptions): string {
  return `import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: ${js(o.companyName)},
  description: 'A Cumulus project with Relay-ready agent authentication.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">${o.companyName}</Link>
          <nav>
            ${hasDashboard(o.template) ? '<Link href="/dashboard">Dashboard</Link>' : ''}
            ${hasDashboard(o.template) ? '<Link href="/me">Me</Link>' : ''}
            ${hasPlayground(o.template) ? '<Link href="/playground">Playground</Link>' : ''}
            ${hasMarketing(o.template) ? '<Link href="/docs">Docs</Link>' : ''}
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
`;
}

function globals(): string {
  return `:root {
  color-scheme: light;
  --paper: #f7f4ef;
  --ink: #171717;
  --muted: #68625a;
  --line: #ded8cf;
  --accent: #8c4b32;
  --panel: #fffaf3;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

a {
  color: inherit;
  text-decoration: none;
}

main {
  min-height: calc(100vh - 72px);
}

.topbar {
  align-items: center;
  border-bottom: 1px solid var(--line);
  display: flex;
  height: 72px;
  justify-content: space-between;
  padding: 0 clamp(20px, 4vw, 56px);
}

.brand {
  font-weight: 700;
}

nav {
  display: flex;
  gap: 18px;
  color: var(--muted);
  font-size: 14px;
}

.page {
  margin: 0 auto;
  max-width: 1120px;
  padding: clamp(32px, 7vw, 96px) clamp(20px, 4vw, 56px);
}

.hero {
  display: grid;
  gap: 28px;
}

.kicker {
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .18em;
  text-transform: uppercase;
}

h1 {
  font-size: clamp(44px, 8vw, 96px);
  letter-spacing: 0;
  line-height: .92;
  margin: 0;
  max-width: 980px;
}

h2 {
  font-size: clamp(28px, 5vw, 48px);
  letter-spacing: 0;
  line-height: 1;
  margin: 0 0 18px;
}

p {
  color: var(--muted);
  font-size: 18px;
  line-height: 1.6;
  margin: 0;
  max-width: 720px;
}

.grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  margin-top: 34px;
}

.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 22px;
}

.card h3 {
  margin: 0 0 10px;
}

.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 26px;
}

.button {
  background: var(--ink);
  border: 1px solid var(--ink);
  border-radius: 6px;
  color: var(--paper);
  display: inline-flex;
  font-weight: 700;
  padding: 12px 16px;
}

.button.secondary {
  background: transparent;
  color: var(--ink);
}

code,
pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

pre {
  background: #171717;
  border-radius: 8px;
  color: #f7f4ef;
  overflow: auto;
  padding: 18px;
}
`;
}

function homePage(o: RenderOptions): string {
  const headline =
    o.template === 'marketing'
      ? 'A Cumulus site ready for agent signups.'
      : o.template === 'inside'
        ? 'Your internal Cumulus workspace.'
        : o.template === 'agent-auth'
          ? 'Agent authentication, ready to wire in.'
          : 'A complete Cumulus project for agent-ready products.';

  return `import Link from 'next/link';

const cards = [
  ['Agent auth', 'Relay-compatible discovery, attestation login, signup, and action webhooks.'],
  ['Clean starter', 'Small files, typed routes, and simple places to add product logic.'],
  ['Scale path', 'Start hosted, then move to self-hosted Relay surfaces when you need ownership.'],
];

export default function HomePage() {
  return (
    <section className="page hero">
      <div className="kicker">Cumulus starter</div>
      <h1>${headline}</h1>
      <p>
        ${o.companyName} ships with the agent-facing bootstrap surfaces that
        let AI agents sign users in, start signups, and invoke actions without
        replacing your product code.
      </p>
      <div className="button-row">
        ${hasDashboard(o.template) ? '<Link className="button" href="/dashboard">Open dashboard</Link>' : '<Link className="button" href="/api/relay-login">View auth route</Link>'}
        ${hasPlayground(o.template) ? '<Link className="button secondary" href="/playground">Open playground</Link>' : '<Link className="button secondary" href="/.well-known/relay.json">Agent discovery</Link>'}
      </div>
      <div className="grid">
        {cards.map(([title, body]) => (
          <article className="card" key={title}>
            <h3>{title}</h3>
            <p>{body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
`;
}

function dashboardPage(o: RenderOptions): string {
  return `import { readAppSession } from '@/src/lib/auth';

export default async function DashboardPage() {
  const session = await readAppSession();

  return (
    <section className="page">
      <div className="kicker">Inside</div>
      <h1>${o.companyName} dashboard</h1>
      <p>
        This is the inside surface for account state, product actions, and
        agent-created resources.
      </p>
      <div className="grid">
        <article className="card">
          <h3>Session</h3>
          <p>{session ? \`Signed in as \${session.email}\` : 'No app session yet. Post a Relay attestation JWT to /api/relay-login.'}</p>
        </article>
        <article className="card">
          <h3>Agent auth</h3>
          <p>${o.agentAuth === 'hosted' ? 'Hosted Relay mode.' : 'Self-hosted Relay-style mode.'}</p>
        </article>
        <article className="card">
          <h3>Next action</h3>
          <p>Replace the demo signup and action handlers with your product logic.</p>
        </article>
      </div>
    </section>
  );
}
`;
}

function mePage(o: RenderOptions): string {
  return `import { readAppSession } from '@/src/lib/auth';

export default async function MePage() {
  const session = await readAppSession();

  return (
    <section className="page">
      <div className="kicker">Me</div>
      <h1>My ${o.companyName} workspace</h1>
      <p>
        This is the user-facing inside workspace. Add account state, user
        settings, connected agents, and personal API key surfaces here.
      </p>
      <div className="grid">
        <article className="card">
          <h3>Identity</h3>
          <p>{session ? session.email : 'No app session yet.'}</p>
        </article>
        <article className="card">
          <h3>Agent access</h3>
          <p>Use Relay attestation login to bind an agent session to this app.</p>
        </article>
      </div>
    </section>
  );
}
`;
}

function playgroundPage(): string {
  return `export default function PlaygroundPage() {
  return (
    <section className="page">
      <div className="kicker">Playground</div>
      <h1>Agent bootstrap checks</h1>
      <p>
        Use these URLs while wiring an agent client or Relay tenant.
      </p>
      <div className="grid">
        <article className="card">
          <h3>Discovery</h3>
          <pre>curl http://localhost:3000/.well-known/relay.json</pre>
        </article>
        <article className="card">
          <h3>Signup webhook</h3>
          <pre>POST /api/agent-signup</pre>
        </article>
        <article className="card">
          <h3>Actions webhook</h3>
          <pre>POST /api/actions</pre>
        </article>
      </div>
    </section>
  );
}
`;
}

function docsPage(o: RenderOptions): string {
  return `export default function DocsPage() {
  return (
    <section className="page">
      <div className="kicker">Docs</div>
      <h1>Agent integration</h1>
      <p>
        ${o.companyName} exposes standard Relay-compatible endpoints so agents
        can discover the app, authenticate, create accounts, and call actions.
      </p>
      <div className="grid">
        <article className="card">
          <h3>Discovery</h3>
          <p>GET /.well-known/relay.json</p>
        </article>
        <article className="card">
          <h3>Login</h3>
          <p>POST /api/relay-login with an attestation JWT.</p>
        </article>
        <article className="card">
          <h3>Webhooks</h3>
          <p>Relay signs signup and action requests with HMAC.</p>
        </article>
      </div>
    </section>
  );
}
`;
}

function settingsPage(): string {
  return `export default function SettingsPage() {
  return (
    <section className="page">
      <div className="kicker">Settings</div>
      <h1>Project settings</h1>
      <p>Add tenant settings, billing controls, and product configuration here.</p>
    </section>
  );
}
`;
}

function configFile(o: RenderOptions): string {
  return `export const appConfig = {
  companyName: ${js(o.companyName)},
  agentAuthMode: ${js(o.agentAuth)},
  relayTenantSlug: process.env.RELAY_TENANT_SLUG ?? ${js(o.packageName)},
  relayTenantId: process.env.RELAY_TENANT_ID ?? 'replace-with-relay-tenant-id',
  relayEndpoint: process.env.RELAY_ENDPOINT ?? '${o.agentAuth === 'self-hosted' ? 'http://localhost:3000/v1' : 'https://relay.cumulush.com/v1'}',
  relayIssuer: process.env.RELAY_ISSUER ?? '${o.agentAuth === 'self-hosted' ? 'http://localhost:3000' : 'https://relay.cumulush.com'}',
  relayJwksUri: process.env.RELAY_JWKS_URI ?? '${o.agentAuth === 'self-hosted' ? 'http://localhost:3000/.well-known/jwks.json' : 'https://relay.cumulush.com/.well-known/jwks.json'}',
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
};

export function publicBaseUrl(request?: Request): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\\/+$/, '');
  if (!request) return appConfig.appBaseUrl;
  const url = new URL(request.url);
  return url.origin;
}
`;
}

function authFile(): string {
  return `import { cookies } from 'next/headers';
import { jwtVerify, SignJWT } from 'jose';

export const SESSION_COOKIE = 'cumulus_session';

export interface AppSession {
  externalUserId: string;
  relayUserId?: string;
  email: string;
  actor: 'agent' | 'human';
}

function sessionSecret(): Uint8Array {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters');
  }
  return new TextEncoder().encode(value);
}

export async function signAppSession(session: AppSession): Promise<string> {
  return new SignJWT({ ...session })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(sessionSecret());
}

export async function verifyAppSession(token: string | undefined): Promise<AppSession | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionSecret());
    if (typeof payload.externalUserId !== 'string' || typeof payload.email !== 'string') {
      return null;
    }
    return {
      externalUserId: payload.externalUserId,
      relayUserId: typeof payload.relayUserId === 'string' ? payload.relayUserId : undefined,
      email: payload.email,
      actor: payload.actor === 'human' ? 'human' : 'agent',
    };
  } catch {
    return null;
  }
}

export async function readAppSession(): Promise<AppSession | null> {
  const jar = await cookies();
  return verifyAppSession(jar.get(SESSION_COOKIE)?.value);
}
`;
}

function relayDiscoveryRoute(o: RenderOptions): string {
  return `import { appConfig, publicBaseUrl } from '@/src/lib/config';

export async function GET(request: Request) {
  const base = publicBaseUrl(request);
  const relayEndpoint =
    appConfig.agentAuthMode === 'self-hosted' ? \`\${base}/v1\` : appConfig.relayEndpoint;
  const relayBase = relayEndpoint.replace(/\\/v1\\/?$/, '');

  return Response.json({
    owner: 'Cumulus',
    app: appConfig.companyName,
    template: ${js(o.template)},
    agentAuthMode: appConfig.agentAuthMode,
    tenantSlug: appConfig.relayTenantSlug,
    tenantId: appConfig.relayTenantId,
    relayEndpoint,
    jwksUri:
      appConfig.agentAuthMode === 'self-hosted'
        ? \`\${base}/.well-known/jwks.json\`
        : appConfig.relayJwksUri || \`\${relayBase}/.well-known/jwks.json\`,
    loginUrl: \`\${base}/api/relay-login\`,
    signupWebhookUrl: \`\${base}/api/agent-signup\`,
    actionsWebhookUrl: \`\${base}/api/actions\`,
  });
}
`;
}

function relayLoginRoute(): string {
  return `import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { NextResponse } from 'next/server';
import { appConfig } from '@/src/lib/config';
import { SESSION_COOKIE, signAppSession } from '@/src/lib/auth';

type RelayClaims = JWTPayload & {
  sub?: string;
  email?: string;
  act?: 'agent' | 'human';
  rel_user_id?: string;
};

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(appConfig.relayJwksUri));
  }
  return jwks;
}

function error(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { jwt?: string } | null;
  const token = body?.jwt?.trim();
  if (!token) return error('jwt is required');

  let claims: RelayClaims;
  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: appConfig.relayIssuer,
      audience: appConfig.relayTenantId,
    });
    claims = payload as RelayClaims;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid token';
    return error(\`relay attestation rejected: \${message}\`, 401);
  }

  if (!claims.sub || !claims.email) {
    return error('attestation missing sub or email', 401);
  }

  const session = await signAppSession({
    externalUserId: claims.sub,
    relayUserId: claims.rel_user_id,
    email: claims.email,
    actor: claims.act ?? 'agent',
  });

  const response = NextResponse.json({
    ok: true,
    externalUserId: claims.sub,
    email: claims.email,
    actor: claims.act ?? 'agent',
  });
  response.cookies.set(SESSION_COOKIE, session, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
  return response;
}
`;
}

function agentSignupRoute(): string {
  return `import { randomBytes, randomUUID } from 'node:crypto';
import { relay } from '@/src/relay/webhook';

function demoApiKey() {
  return 'ck_' + randomBytes(24).toString('base64url');
}

export const POST = relay.webhook({
  secret: process.env.RELAY_WEBHOOK_SECRET ?? 'dev-only-replace-me',
  onSignup: async ({ email, input }) => {
    // Replace this with your real user/account creation code.
    const name = typeof input.name === 'string' ? input.name : email;
    return {
      accountId: \`acct_\${randomUUID()}\`,
      apiKey: demoApiKey(),
      externalId: name,
    };
  },
  onCreateApiKey: async () => {
    return { key: demoApiKey() };
  },
  onRevokeApiKey: async () => {
    return;
  },
  onTeardown: async () => {
    return;
  },
});
`;
}

function relayWebhookHelper(): string {
  return `export interface SignupPayload {
  kind: 'signup';
  signupId: string;
  email: string;
  input: Record<string, unknown>;
  provider_slug: string;
}

export interface CreateApiKeyPayload {
  kind: 'create_api_key';
  account_id: string;
  label: string;
}

export interface RevokeApiKeyPayload {
  kind: 'revoke_api_key';
  account_id: string;
  key_id: string;
}

export interface TeardownPayload {
  kind: 'teardown';
  account_id: string;
}

export type RelayWebhookPayload =
  | SignupPayload
  | CreateApiKeyPayload
  | RevokeApiKeyPayload
  | TeardownPayload;

export interface SignupResult {
  accountId: string;
  apiKey: string;
  externalId?: string;
}

export interface CreateApiKeyResult {
  key: string;
  providerKeyId?: string;
}

export interface WebhookOptions {
  secret: string;
  onSignup: (payload: SignupPayload) => Promise<SignupResult> | SignupResult;
  onCreateApiKey?: (
    payload: CreateApiKeyPayload,
  ) => Promise<CreateApiKeyResult> | CreateApiKeyResult;
  onRevokeApiKey?: (payload: RevokeApiKeyPayload) => Promise<void> | void;
  onTeardown?: (payload: TeardownPayload) => Promise<void> | void;
  onUnknown?: (payload: unknown) => Promise<Response> | Response;
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function verifySignature(
  body: string,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!header) return false;
  const provided = header.startsWith('sha256=') ? header.slice(7) : header;
  if (!/^[0-9a-f]+$/i.test(provided)) return false;
  const expected = await hmacHex(secret, body);
  return timingSafeEqual(provided.toLowerCase(), expected);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function webhook(options: WebhookOptions) {
  return async function relayWebhook(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return jsonResponse(405, { error: 'method_not_allowed' });
    }

    const rawBody = await req.text();
    const sig = req.headers.get('x-relay-signature');
    if (!(await verifySignature(rawBody, sig, options.secret))) {
      return jsonResponse(401, { error: 'invalid_signature' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return jsonResponse(400, { error: 'invalid_json' });
    }

    const p = payload as Partial<RelayWebhookPayload>;
    try {
      switch (p.kind) {
        case 'signup': {
          if (typeof p.email !== 'string' || typeof p.signupId !== 'string') {
            return jsonResponse(400, { error: 'missing_fields' });
          }
          const result = await options.onSignup(p as SignupPayload);
          if (!result?.accountId || !result?.apiKey) {
            return jsonResponse(500, { error: 'handler_returned_invalid_result' });
          }
          return jsonResponse(200, result);
        }
        case 'create_api_key': {
          if (!options.onCreateApiKey) {
            return jsonResponse(501, { error: 'create_api_key_not_supported' });
          }
          if (typeof p.account_id !== 'string' || typeof p.label !== 'string') {
            return jsonResponse(400, { error: 'missing_fields' });
          }
          const result = await options.onCreateApiKey(p as CreateApiKeyPayload);
          return jsonResponse(200, result);
        }
        case 'revoke_api_key': {
          if (!options.onRevokeApiKey) {
            return jsonResponse(501, { error: 'revoke_api_key_not_supported' });
          }
          if (typeof p.account_id !== 'string' || typeof p.key_id !== 'string') {
            return jsonResponse(400, { error: 'missing_fields' });
          }
          await options.onRevokeApiKey(p as RevokeApiKeyPayload);
          return jsonResponse(200, { revoked: true });
        }
        case 'teardown': {
          if (!options.onTeardown) {
            return jsonResponse(501, { error: 'teardown_not_supported' });
          }
          if (typeof p.account_id !== 'string') {
            return jsonResponse(400, { error: 'missing_fields' });
          }
          await options.onTeardown(p as TeardownPayload);
          return jsonResponse(200, { deleted: true });
        }
        default: {
          if (options.onUnknown) return options.onUnknown(payload);
          return jsonResponse(400, { error: \`unknown_kind:\${String(p.kind)}\` });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(500, { error: message });
    }
  };
}

export const relay = { webhook };
`;
}

function actionsRoute(): string {
  return `interface ActionPayload {
  requestId: string;
  actionSlug: string;
  externalUserId: string;
  relayUserId: string;
  input: Record<string, unknown>;
}

function json(status: number, body: unknown) {
  return Response.json(body, { status });
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function verify(body: string, signature: string | null): Promise<boolean> {
  const secret = process.env.RELAY_ACTIONS_SECRET ?? 'dev-only-replace-me';
  if (!signature) return false;
  const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  if (!/^[0-9a-f]+$/i.test(provided)) return false;
  const expected = await hmacHex(secret, body);
  return timingSafeEqual(provided.toLowerCase(), expected);
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (!(await verify(rawBody, request.headers.get('x-relay-signature')))) {
    return json(401, { ok: false, error: 'invalid_signature' });
  }

  const payload = JSON.parse(rawBody) as ActionPayload;
  if (payload.actionSlug === 'echo') {
    return json(200, { ok: true, output: payload.input ?? {} });
  }
  if (payload.actionSlug === 'create_project') {
    const title =
      typeof payload.input?.title === 'string' ? payload.input.title : 'Untitled project';
    return json(200, {
      ok: true,
      output: {
        projectId: \`project_\${payload.externalUserId.slice(0, 8)}\`,
        title,
        createdFor: payload.externalUserId,
      },
    });
  }

  return json(404, { ok: false, error: \`unknown_action:\${payload.actionSlug}\` });
}
`;
}

function selfHostedRouteExports(): string {
  return `export {
  GET,
  POST,
  PUT,
  PATCH,
  DELETE,
  OPTIONS,
  HEAD,
} from '@/src/relay-self-hosted/next-handler';
`;
}

function selfHostedNextHandler(): string {
  return `import { handle } from 'hono/vercel';
import app from './server';

const h = handle(app);

export const GET = h;
export const POST = h;
export const PUT = h;
export const PATCH = h;
export const DELETE = h;
export const OPTIONS = h;
export const HEAD = h;
`;
}

function selfHostedServer(): string {
  return `import { randomBytes, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';

type Env = Record<string, never>;
type Signup = {
  id: string;
  provider: string;
  input: Record<string, unknown>;
  status: 'complete';
  initialApiKey: string;
  createdAt: string;
};

const app = new OpenAPIHono<Env>();
const signups = new Map<string, Signup>();

const providers = [
  {
    id: 'demo',
    kind: 'tenant',
    displayName: 'Demo Provider',
    description: 'In-memory self-hosted starter provider.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
      },
    },
  },
];

let keyPair: Awaited<ReturnType<typeof generateKeyPair>> | null = null;

async function keys() {
  if (!keyPair) {
    keyPair = await generateKeyPair('RS256', { extractable: true });
  }
  return keyPair;
}

async function jwks() {
  const { publicKey } = await keys();
  const jwk = await exportJWK(publicKey);
  return { keys: [{ ...jwk, kid: 'dev-key-1', alg: 'RS256', use: 'sig' }] };
}

function apiKey() {
  return 'ck_' + randomBytes(24).toString('base64url');
}

app.openapi(
  createRoute({
    method: 'get',
    path: '/health',
    tags: ['meta'],
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: z.object({ status: z.literal('ok') }) } },
      },
    },
  }),
  (c) => c.json({ status: 'ok' as const }),
);

app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/providers',
    tags: ['providers'],
    responses: {
      200: {
        description: 'Providers',
        content: { 'application/json': { schema: z.array(z.record(z.string(), z.unknown())) } },
      },
    },
  }),
  (c) => c.json(providers),
);

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/signups',
    tags: ['signups'],
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              provider: z.string(),
              input: z.record(z.string(), z.unknown()).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Signup created',
        content: {
          'application/json': {
            schema: z.object({
              id: z.string(),
              status: z.literal('complete'),
              initial_api_key: z.string(),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    const signup: Signup = {
      id: randomUUID(),
      provider: body.provider,
      input: body.input ?? {},
      status: 'complete',
      initialApiKey: apiKey(),
      createdAt: new Date().toISOString(),
    };
    signups.set(signup.id, signup);
    return c.json({
      id: signup.id,
      status: signup.status,
      initial_api_key: signup.initialApiKey,
    });
  },
);

app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/signups/{id}',
    tags: ['signups'],
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        description: 'Signup',
        content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
      },
      404: {
        description: 'Missing',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
    },
  }),
  (c) => {
    const row = signups.get(c.req.valid('param').id);
    if (!row) return c.json({ error: 'signup_not_found' }, 404);
    return c.json({
      id: row.id,
      provider: row.provider,
      input: row.input,
      status: row.status,
      initial_api_key: row.initialApiKey,
      created_at: row.createdAt,
    }, 200);
  },
);

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/integrator/auth/attest',
    tags: ['integrator', 'auth'],
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              email: z.string().email(),
              externalUserId: z.string().optional(),
              tenantId: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Attestation',
        content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
      },
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    const { privateKey } = await keys();
    const issuer = process.env.RELAY_ISSUER ?? new URL(c.req.url).origin;
    const tenantId = body.tenantId ?? process.env.RELAY_TENANT_ID ?? 'local-tenant';
    const externalUserId = body.externalUserId ?? randomUUID();
    const jwt = await new SignJWT({
      email: body.email,
      act: 'agent',
      rel_user_id: externalUserId,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'dev-key-1' })
      .setSubject(externalUserId)
      .setIssuer(issuer)
      .setAudience(tenantId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    return c.json({
      jwt,
      externalUserId,
      tenantId,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
  },
);

app.get('/.well-known/jwks.json', async (c) => {
  return c.json(await jwks(), 200, { 'Cache-Control': 'public, max-age=3600' });
});

app.all('/mcp', (c) =>
  c.json({
    name: 'cumulus-self-hosted-mcp',
    transport: 'streamable-http',
    status: 'starter',
    next: 'Replace this placeholder with @modelcontextprotocol/sdk tools when you add durable actions.',
  }),
);

app.doc('/openapi.json', {
  openapi: '3.1.0',
  info: {
    title: 'Cumulus Self-Hosted Agent API',
    version: '0.1.0',
    description: 'Starter Relay-compatible API for agent auth, signups, and actions.',
  },
});

export default app;
`;
}

function selfHostedSchema(): string {
  return `// Replace this starter with your Drizzle schema when you connect DATABASE_URL.
export interface AgentTokenRow {
  id: string;
  tokenHash: string;
  userId: string;
  createdAt: Date;
}

export interface SignupJobRow {
  id: string;
  provider: string;
  status: 'pending' | 'complete' | 'failed';
  input: Record<string, unknown>;
  createdAt: Date;
  completedAt?: Date;
}
`;
}

function selfHostedWorkflow(): string {
  return `export interface SignupWorkflowInput {
  provider: string;
  input: Record<string, unknown>;
}

export async function signupWorkflow(input: SignupWorkflowInput) {
  // This starter keeps signup synchronous and in-memory.
  // Replace this with Workflow DevKit steps when you need retries,
  // email waits, or long-running provider work.
  return {
    status: 'complete' as const,
    provider: input.provider,
    input: input.input,
  };
}
`;
}

function selfHostedMigration(): string {
  return `-- Cumulus self-hosted agent auth starter.
-- Apply this only after replacing the in-memory starter with real persistence.

CREATE TABLE IF NOT EXISTS agent_tokens (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signup_jobs (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  status text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
`;
}

export function buildFiles(o: RenderOptions): FileMap {
  const files: FileMap = new Map();

  files.set('package.json', packageJson(o));
  files.set('README.md', readme(o));
  files.set('LICENSE', `MIT License\n\nCopyright (c) 2026 ${o.companyName}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`);
  files.set('.gitignore', `node_modules/\n.next/\nout/\ndist/\n.env\n.env.local\n.env.*.local\n!.env.example\n.DS_Store\n*.tsbuildinfo\n`);
  files.set('.env.example', envExample(o));
  files.set('tsconfig.json', tsconfig());
  files.set('next.config.ts', `import type { NextConfig } from 'next';\n\nconst nextConfig: NextConfig = {};\n\nexport default nextConfig;\n`);
  files.set('app/layout.tsx', layout(o));
  files.set('app/globals.css', globals());
  files.set('app/page.tsx', homePage(o));
  files.set('src/lib/config.ts', configFile(o));
  files.set('src/lib/auth.ts', authFile());
  files.set('src/relay/webhook.ts', relayWebhookHelper());
  files.set('app/.well-known/relay.json/route.ts', relayDiscoveryRoute(o));
  files.set('app/api/relay-login/route.ts', relayLoginRoute());
  files.set('app/api/agent-signup/route.ts', agentSignupRoute());
  files.set('app/api/actions/route.ts', actionsRoute());

  if (hasDashboard(o.template)) {
    files.set('app/dashboard/page.tsx', dashboardPage(o));
    files.set('app/me/page.tsx', mePage(o));
    files.set('app/settings/page.tsx', settingsPage());
  }
  if (hasPlayground(o.template)) {
    files.set('app/playground/page.tsx', playgroundPage());
  }
  if (hasMarketing(o.template)) {
    files.set('app/docs/page.tsx', docsPage(o));
  }
  if (o.agentAuth === 'self-hosted') {
    files.set('app/v1/[[...path]]/route.ts', selfHostedRouteExports());
    files.set('app/mcp/route.ts', selfHostedRouteExports());
    files.set('app/openapi.json/route.ts', selfHostedRouteExports());
    files.set('app/.well-known/jwks.json/route.ts', selfHostedRouteExports());
    files.set('src/relay-self-hosted/next-handler.ts', selfHostedNextHandler());
    files.set('src/relay-self-hosted/server.ts', selfHostedServer());
    files.set('src/relay-self-hosted/db/schema.ts', selfHostedSchema());
    files.set('workflows/signup.ts', selfHostedWorkflow());
    files.set('migrations/0000_cumulus_agent_auth.sql', selfHostedMigration());
  }

  return files;
}
