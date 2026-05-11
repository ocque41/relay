#!/usr/bin/env node
/**
 * @cumulus/cli — first-class command surface for Relay.
 *
 * Zero runtime dependencies. Subcommands dispatched from `main()` into
 * per-command modules below. Every command prints either a human table
 * (default) or JSON (`--json`). `--verbose` enables HTTP tracing.
 *
 *   relay login | logout | whoami
 *   relay workspace list | switch <slug|id>       (dev/tenant shell)
 *   relay workspaces list                         (personal workspaces)
 *   relay workspaces create <name> [--slug S] [--no-switch]
 *   relay workspaces rename <slug> <new name>
 *   relay workspaces delete <slug> [--yes]
 *
 *   relay accounts [--provider <id>] [--json]
 *   relay keys [--account <id>] [--json]
 *   relay signups [--status <s>] [--since 7d] [--json]
 *   relay inbox [--limit N] [--json]
 *   relay share [--ttl 10m] [--uses N]
 *
 *   relay subscription [--tenant <id>] [--json]
 *   relay subscribe [--plan founders|builder|starter|growth|scale]
 *                   [--yes] [--tenant <id>] [--json]
 *
 *   relay products [--json]
 *   relay products show <slug>
 *   relay products rotate <slug>
 *   relay stats [--since 7d]
 *   relay users [--json]
 *   relay logs [--limit N]
 *   relay scan <slug> [--full] [--i-know]
 *
 *   relay init        (scaffold @cumulus/server webhook into a Next.js project)
 *
 * Config: ~/.relay/config.json
 * Env:    RELAY_BASE_URL
 */
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output_ } from 'node:process';

const DEFAULT_BASE_URL = 'https://relay.cumulush.com';
const CONFIG_PATH = join(homedir(), '.relay', 'config.json');

interface RelayConfig {
  base_url: string;
  agent_token: string;
  user: { id: string; email: string; inbox_alias: string | null };
  /**
   * Active tenant for tenant-scoped commands (`subscription`, `subscribe`,
   * `register-product`, …). Optional; commands that need it fall back to a
   * `--tenant <id>` override or print a helpful error.
   */
  active_tenant?: string;
}

function baseUrl(): string {
  return process.env.RELAY_BASE_URL ?? DEFAULT_BASE_URL;
}

async function readConfig(): Promise<RelayConfig | null> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(raw) as RelayConfig;
  } catch {
    return null;
  }
}

async function writeConfig(cfg: RelayConfig): Promise<void> {
  await mkdir(join(homedir(), '.relay'), { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

async function requireConfig(): Promise<RelayConfig> {
  const cfg = await readConfig();
  if (!cfg) {
    console.error('Not signed in. Run: relay login');
    process.exit(1);
  }
  return cfg;
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* user can open manually */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[a.slice(2)] = argv[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
async function api<T>(
  cfg: RelayConfig,
  path: string,
  opts: RequestInit & { verbose?: boolean } = {},
): Promise<T> {
  const url = `${cfg.base_url}${path}`;
  const headers = new Headers(opts.headers);
  headers.set('Authorization', `Bearer ${cfg.agent_token}`);
  if (opts.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (opts.verbose) {
    console.error(`→ ${opts.method ?? 'GET'} ${url}`);
  }

  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let data: unknown;
  try {
    data = text.length ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (opts.verbose) {
    console.error(`← ${res.status} ${res.statusText}`);
  }
  if (!res.ok) {
    // 503 = tenant subscription gate. Server shape:
    // { error, state } where state ∈ 'none' | 'past_due' | 'canceled' | 'expired'
    if (res.status === 503 && typeof data === 'object' && data) {
      const d = data as { state?: unknown; error?: unknown };
      const state =
        typeof d.state === 'string' && d.state.length > 0
          ? d.state
          : typeof d.error === 'string'
            ? d.error
            : 'inactive';
      throw new Error(`tenant subscription ${state}`);
    }
    const msg =
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
const isTty = process.stdout.isTTY;

function color(code: string, s: string): string {
  return isTty ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const dim = (s: string) => color('2', s);
const bold = (s: string) => color('1', s);

function printTable(
  rows: Array<Record<string, unknown>>,
  columns: Array<[string, string]>,
): void {
  if (rows.length === 0) {
    console.log(dim('(no rows)'));
    return;
  }
  const widths = columns.map(([, title]) => title.length);
  for (const row of rows) {
    columns.forEach(([key], i) => {
      const v = String(row[key] ?? '');
      if (v.length > widths[i]) widths[i] = Math.min(60, v.length);
    });
  }
  const header = columns
    .map(([, title], i) => bold(title.padEnd(widths[i])))
    .join('  ');
  console.log(header);
  console.log(dim(columns.map((_, i) => '-'.repeat(widths[i])).join('  ')));
  for (const row of rows) {
    console.log(
      columns
        .map(([key], i) => {
          const v = String(row[key] ?? '');
          return v.length > 60 ? v.slice(0, 57) + '…' : v.padEnd(widths[i]);
        })
        .join('  '),
    );
  }
}

function output(data: unknown, asJson: boolean, columns?: Array<[string, string]>): void {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (Array.isArray(data) && columns) {
    printTable(data as Record<string, unknown>[], columns);
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Commands: auth
// ---------------------------------------------------------------------------
async function cmdLogin(): Promise<void> {
  const base = baseUrl();
  console.log(`Signing in to ${base}…`);

  const startRes = await fetch(`${base}/v1/cli/start`, { method: 'POST' });
  if (!startRes.ok) throw new Error(`POST /v1/cli/start failed: ${startRes.status}`);
  const start = (await startRes.json()) as {
    device_code: string;
    authorize_url: string;
    poll_interval_ms: number;
    expires_at: string;
  };

  console.log(`\nOpen this URL to authorize:\n  ${start.authorize_url}\n`);
  openInBrowser(start.authorize_url);

  const deadline = new Date(start.expires_at).getTime();
  const poll = start.poll_interval_ms ?? 2000;

  while (Date.now() < deadline) {
    await sleep(poll);
    const pollRes = await fetch(
      `${base}/v1/cli/poll?device_code=${encodeURIComponent(start.device_code)}`,
    );
    if (!pollRes.ok) continue;
    const data = (await pollRes.json()) as
      | { status: 'pending' }
      | {
          status: 'approved';
          agent_token: string;
          user: { id: string; email: string; inbox_alias: string | null };
        }
      | { status: 'expired' | 'unknown' };

    if (data.status === 'approved') {
      await writeConfig({
        base_url: base,
        agent_token: data.agent_token,
        user: data.user,
      });
      console.log(`\n✓ Signed in as ${data.user.email}`);
      if (data.user.inbox_alias) {
        console.log(`  agent inbox: ${data.user.inbox_alias}@inbox.cumulush.com`);
      }
      return;
    }
    if (data.status === 'expired' || data.status === 'unknown') {
      console.error(`\n✗ ${data.status}. Re-run: relay login`);
      process.exit(1);
    }
  }
  console.error('\n✗ Authorization timed out. Re-run: relay login');
  process.exit(1);
}

async function cmdLogout(): Promise<void> {
  await rm(CONFIG_PATH, { force: true });
  console.log('Signed out.');
}

async function cmdWhoami(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const me = await api<unknown>(cfg, '/v1/me', { verbose: !!args.flags.verbose });
  if (args.flags.json) {
    output(me, true);
    return;
  }
  output(me, false);

  // Surface which personal workspace the bearer is pinned to so the operator
  // knows which scope their CLI calls are operating in.
  try {
    const ws = await api<{
      active_id: string;
      workspaces: UserWorkspaceRow[];
    }>(cfg, '/v1/user/workspaces', { verbose: !!args.flags.verbose });
    const active = ws.workspaces.find((w) => w.id === ws.active_id);
    if (active) {
      console.log();
      console.log(
        bold('Active workspace:') +
          ` ${active.name} ${dim(`(${active.slug})`)}`,
      );
      if (active.inbox_alias) {
        console.log(`  inbox ${active.inbox_alias}`);
      }
      if (ws.workspaces.length > 1) {
        console.log(
          dim(
            `  ${ws.workspaces.length} personal workspaces — see \`relay workspaces list\``,
          ),
        );
      }
    }
  } catch {
    /* best effort — endpoint may be unreachable or older server */
  }
}

// ---------------------------------------------------------------------------
// Commands: workspace
// ---------------------------------------------------------------------------
async function cmdWorkspaceList(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const s = await api<{
    activeWorkspace: { kind: string; tenantId?: string };
    tenants: Array<{ id: string; slug: string; name: string; role: string }>;
  }>(cfg, '/v1/session', { verbose: !!args.flags.verbose });

  if (args.flags.json) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }

  console.log(bold('Active:'), s.activeWorkspace.kind === 'user' ? 'my workspace' : s.activeWorkspace.tenantId);
  console.log();
  console.log(bold('Available tenants:'));
  if (s.tenants.length === 0) {
    console.log(dim('  (none — create one at /dev/products)'));
  } else {
    for (const t of s.tenants) {
      const marker = s.activeWorkspace.kind === 'tenant' && s.activeWorkspace.tenantId === t.id ? '●' : ' ';
      console.log(`  ${marker} ${t.slug.padEnd(30)} ${t.name}  ${dim('[' + t.role + ']')}`);
    }
  }
}

async function cmdWorkspaceSwitch(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const target = args.positional[2];
  if (!target) {
    console.error('usage: relay workspace switch <slug|id|"user">');
    process.exit(1);
  }

  if (target === 'user' || target === 'me') {
    await api(cfg, '/v1/session/workspace', {
      method: 'POST',
      body: JSON.stringify({ kind: 'user' }),
      verbose: !!args.flags.verbose,
    });
    console.log('✓ switched to user workspace');
    return;
  }

  const s = await api<{
    tenants: Array<{ id: string; slug: string; name: string }>;
  }>(cfg, '/v1/session', { verbose: !!args.flags.verbose });
  const t = s.tenants.find((x) => x.slug === target || x.id === target);
  if (!t) {
    console.error(`✗ no tenant with slug or id "${target}"`);
    process.exit(1);
  }
  await api(cfg, '/v1/session/workspace', {
    method: 'POST',
    body: JSON.stringify({ kind: 'tenant', tenantId: t.id }),
    verbose: !!args.flags.verbose,
  });
  console.log(`✓ switched to ${t.name} (${t.slug})`);
}

// ---------------------------------------------------------------------------
// Commands: personal (user) workspaces — plural. Keeps a user's projects
// isolated: accounts, keys, inbox, agent tokens do not cross workspaces.
// Separate from `relay workspace` (singular) which switches between the
// user shell and developer/tenant shells.
// ---------------------------------------------------------------------------
interface UserWorkspaceRow {
  id: string;
  name: string;
  slug: string;
  is_default: boolean;
  inbox_alias: string | null;
  is_active: boolean;
  created_at: string | null;
}

async function fetchUserWorkspaces(
  cfg: RelayConfig,
  verbose: boolean,
): Promise<{ active_id: string; workspaces: UserWorkspaceRow[] }> {
  return api<{ active_id: string; workspaces: UserWorkspaceRow[] }>(
    cfg,
    '/v1/user/workspaces',
    { verbose },
  );
}

function resolveWorkspace(
  workspaces: UserWorkspaceRow[],
  target: string,
): UserWorkspaceRow | null {
  return (
    workspaces.find((w) => w.id === target) ??
    workspaces.find((w) => w.slug === target) ??
    workspaces.find((w) => w.name === target) ??
    null
  );
}

async function cmdUserWorkspacesList(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const data = await fetchUserWorkspaces(cfg, !!args.flags.verbose);
  if (args.flags.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(bold(`Personal workspaces (${data.workspaces.length}):`));
  for (const w of data.workspaces) {
    const marker = w.is_active ? '●' : ' ';
    const tags = [
      w.is_default ? 'default' : null,
      w.is_active ? 'active' : null,
    ]
      .filter(Boolean)
      .join(' · ');
    console.log(
      `  ${marker} ${w.slug.padEnd(24)} ${w.name.padEnd(30)} ${dim(tags)}`,
    );
    if (w.inbox_alias) {
      console.log(`      ${dim(`inbox ${w.inbox_alias}`)}`);
    }
  }
}

async function cmdUserWorkspacesCreate(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const name = args.positional[2];
  if (!name) {
    console.error('usage: relay workspaces create <name> [--slug <slug>] [--no-switch]');
    process.exit(1);
  }
  const slugFlag = args.flags.slug;
  const makeActive = !args.flags['no-switch'];
  const body: Record<string, unknown> = { name, make_active: makeActive };
  if (typeof slugFlag === 'string' && slugFlag) body.slug = slugFlag;

  const row = await api<UserWorkspaceRow>(cfg, '/v1/user/workspaces', {
    method: 'POST',
    body: JSON.stringify(body),
    verbose: !!args.flags.verbose,
  });
  if (args.flags.json) {
    console.log(JSON.stringify(row, null, 2));
    return;
  }
  console.log(`✓ created ${row.name} ${dim(`(${row.slug})`)}`);
  if (row.inbox_alias) console.log(`  inbox ${row.inbox_alias}`);
  if (makeActive) console.log('  made active for the dashboard');
  console.log(
    dim(
      '\nBearer tokens you mint from here on are pinned to this workspace. ' +
        'Existing tokens keep their original pin.',
    ),
  );
}

async function cmdUserWorkspacesSwitch(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const target = args.positional[2];
  if (!target) {
    console.error('usage: relay workspaces switch <slug|id|name>');
    process.exit(1);
  }
  const data = await fetchUserWorkspaces(cfg, !!args.flags.verbose);
  const w = resolveWorkspace(data.workspaces, target);
  if (!w) {
    console.error(`✗ no workspace with slug/id/name "${target}"`);
    process.exit(1);
  }
  // Cookie-only route on the server. The CLI uses a bearer, so we call the
  // switch via its REST path but the bearer path is rejected — we hint the
  // user to do it in the browser, OR we update the user's active pointer
  // via the forthcoming bearer-switch endpoint. For now, switching is a
  // dashboard-only action because bearer tokens carry an immutable pin.
  console.error(
    `✗ workspace switching is a dashboard action because bearer tokens are pinned to a workspace at creation.\n` +
      `  Open the switcher in the top nav at ${baseUrl()}/me/workspaces and click "Open" on ${w.name}.\n` +
      `  Or mint a new token inside ${w.name}: switch in the browser → /me/agents → New token.`,
  );
  process.exit(1);
}

async function cmdUserWorkspacesRename(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const target = args.positional[2];
  const newName = args.positional[3];
  if (!target || !newName) {
    console.error('usage: relay workspaces rename <slug|id|name> <new-name>');
    process.exit(1);
  }
  const data = await fetchUserWorkspaces(cfg, !!args.flags.verbose);
  const w = resolveWorkspace(data.workspaces, target);
  if (!w) {
    console.error(`✗ no workspace with slug/id/name "${target}"`);
    process.exit(1);
  }
  await api(cfg, `/v1/user/workspaces/${w.id}/rename`, {
    method: 'POST',
    body: JSON.stringify({ name: newName }),
    verbose: !!args.flags.verbose,
  });
  console.log(`✓ renamed "${w.name}" → "${newName}"`);
}

async function cmdUserWorkspacesDelete(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const target = args.positional[2];
  if (!target) {
    console.error(
      'usage: relay workspaces delete <slug|id|name> [--yes]\n' +
        '  You will be asked to type the workspace name to confirm.',
    );
    process.exit(1);
  }
  const data = await fetchUserWorkspaces(cfg, !!args.flags.verbose);
  const w = resolveWorkspace(data.workspaces, target);
  if (!w) {
    console.error(`✗ no workspace with slug/id/name "${target}"`);
    process.exit(1);
  }
  if (w.is_default) {
    console.error('✗ the default workspace cannot be deleted.');
    process.exit(1);
  }
  if (data.workspaces.length <= 1) {
    console.error("✗ can't delete your only remaining workspace.");
    process.exit(1);
  }

  if (!args.flags.yes) {
    console.log(
      bold(`About to delete "${w.name}"`) +
        dim(` (${w.slug}). This cannot be undone.`),
    );
    console.log(
      dim(
        '  Deletes every account, API key, inbox message, share link, and\n' +
          '  agent token scoped to this workspace.',
      ),
    );
    const rl = createInterface({ input, output: output_ });
    const typed = await rl.question(`  Type ${bold(w.name)} to confirm: `);
    rl.close();
    if (typed.trim() !== w.name) {
      console.error('✗ name did not match. Aborted.');
      process.exit(1);
    }
  }

  await api(cfg, `/v1/user/workspaces/${w.id}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirm_name: w.name }),
    verbose: !!args.flags.verbose,
  });
  console.log(`✓ deleted "${w.name}"`);
}

async function cmdUserWorkspaces(args: ParsedArgs): Promise<void> {
  const sub = args.positional[1];
  if (!sub || sub === 'list') return cmdUserWorkspacesList(args);
  if (sub === 'create') return cmdUserWorkspacesCreate(args);
  if (sub === 'switch') return cmdUserWorkspacesSwitch(args);
  if (sub === 'rename') return cmdUserWorkspacesRename(args);
  if (sub === 'delete' || sub === 'rm') return cmdUserWorkspacesDelete(args);
  console.error(
    `unknown workspaces subcommand: ${sub}\n` +
      '  available: list | create <name> | switch <slug> | rename <slug> <new-name> | delete <slug>',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Commands: providers
// ---------------------------------------------------------------------------
async function cmdProviders(args: ParsedArgs): Promise<void> {
  const sub = args.positional[1];
  if (!sub || sub === 'list') return cmdProvidersList(args);
  if (sub === 'show') return cmdProvidersShow(args);
  console.error(`unknown providers subcommand: ${sub}`);
  process.exit(1);
}

interface ProviderRow {
  id: string;
  kind: string;
  displayName: string;
  description: string | null;
  docsUrl: string | null;
  homepage: string | null;
  npmPackage: string | null;
  categories: string[];
  inputSchema?: unknown;
  tenantId?: string;
  needsEmailVerification?: boolean;
}

async function cmdProvidersList(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const rows = await api<ProviderRow[]>(cfg, '/v1/providers', {
    verbose: !!args.flags.verbose,
  });
  const view = rows.map((p) => ({
    id: p.id,
    kind: p.kind,
    displayName: p.displayName,
    description: p.description ?? '',
    categories: (p.categories ?? []).join(','),
    homepage: p.homepage ?? '',
  }));
  output(view, !!args.flags.json, [
    ['id', 'ID'],
    ['kind', 'KIND'],
    ['displayName', 'NAME'],
    ['description', 'DESCRIPTION'],
    ['categories', 'CATEGORIES'],
    ['homepage', 'HOMEPAGE'],
  ]);
}

async function cmdProvidersShow(args: ParsedArgs): Promise<void> {
  const id = args.positional[2];
  if (!id) {
    console.error('usage: relay providers show <id>');
    process.exit(1);
  }
  const cfg = await requireConfig();
  const p = await api<ProviderRow>(cfg, `/v1/providers/${encodeURIComponent(id)}`, {
    verbose: !!args.flags.verbose,
  });
  if (args.flags.json) {
    console.log(JSON.stringify(p, null, 2));
    return;
  }
  console.log(`${bold(p.displayName)} (${p.id})`);
  console.log(`  kind:        ${p.kind}`);
  if (p.description) console.log(`  description: ${p.description}`);
  if (p.categories?.length) console.log(`  categories:  ${p.categories.join(', ')}`);
  if (p.homepage) console.log(`  homepage:    ${p.homepage}`);
  if (p.docsUrl) console.log(`  docs:        ${p.docsUrl}`);
  if (p.npmPackage) console.log(`  npm:         ${p.npmPackage}`);
  if (p.tenantId) console.log(`  tenant:      ${p.tenantId}`);
  if (p.needsEmailVerification !== undefined) {
    console.log(`  email-verif: ${p.needsEmailVerification}`);
  }
  console.log('\n  input JSON Schema:');
  console.log(
    JSON.stringify(p.inputSchema ?? {}, null, 2)
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n'),
  );
  console.log('\n  Example POST /v1/signups body:');
  const example = buildExampleSignupBody(p);
  console.log(
    JSON.stringify(example, null, 2)
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n'),
  );
}

function buildExampleSignupBody(p: ProviderRow): Record<string, unknown> {
  const schema = (p.inputSchema ?? {}) as { properties?: Record<string, { type?: string; example?: unknown }> };
  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    if (v && typeof v === 'object') {
      if ('example' in v && v.example !== undefined) input[k] = v.example;
      else if (v.type === 'string') input[k] = `example-${k}`;
      else if (v.type === 'number' || v.type === 'integer') input[k] = 0;
      else if (v.type === 'boolean') input[k] = false;
    }
  }
  return { provider: p.id, input };
}

async function cmdAccounts(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const rows = await api<Array<Record<string, unknown>>>(cfg, '/v1/user/accounts', {
    verbose: !!args.flags.verbose,
  });
  const filtered = args.flags.provider
    ? rows.filter((r) => r.provider_id === args.flags.provider)
    : rows;
  output(filtered, !!args.flags.json, [
    ['id', 'ID'],
    ['provider_id', 'PROVIDER'],
    ['label', 'LABEL'],
    ['email_alias', 'EMAIL'],
    ['status', 'STATUS'],
    ['created_at', 'CREATED'],
  ]);
}

async function cmdKeys(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];
  if (sub === 'mint') return cmdKeysMint(args);
  if (sub === 'rotate') return cmdKeysRotate(args);

  const cfg = await requireConfig();
  const rows = await api<Array<Record<string, unknown>>>(cfg, '/v1/user/keys', {
    verbose: !!args.flags.verbose,
  });
  const filtered = args.flags.account
    ? rows.filter((r) => r.account_id === args.flags.account)
    : rows;
  output(filtered, !!args.flags.json, [
    ['id', 'ID'],
    ['label', 'LABEL'],
    ['provider_id', 'PROVIDER'],
    ['account_label', 'ACCOUNT'],
    ['created_at', 'CREATED'],
    ['last_used_at', 'LAST_USED'],
  ]);
}

async function cmdKeysMint(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const accountId =
    typeof args.flags.account === 'string' ? args.flags.account : args.positional[1];
  if (!accountId) {
    console.error('usage: relay keys mint --account <accountId> [--label <label>]');
    process.exit(1);
  }
  const label = typeof args.flags.label === 'string' ? args.flags.label : undefined;

  const res = await api<{
    id: string;
    account_id: string;
    label: string;
    key: string;
    created_at: string | null;
  }>(cfg, `/v1/accounts/${encodeURIComponent(accountId)}/api-keys`, {
    method: 'POST',
    body: JSON.stringify(label ? { label } : {}),
    verbose: !!args.flags.verbose,
  });

  if (args.flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(bold(`Minted key "${res.label}" (copy now, it will NOT be shown again):`));
  console.log(`  ${res.key}`);
  console.log();
  console.log(dim(`key_id ${res.id} · created ${res.created_at ?? '—'}`));
}

async function cmdKeysRotate(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const accountId =
    typeof args.flags.account === 'string' ? args.flags.account : args.positional[1];
  const keyId =
    typeof args.flags.key === 'string' ? args.flags.key : args.positional[2];
  if (!accountId || !keyId) {
    console.error('usage: relay keys rotate --account <accountId> --key <keyId>');
    process.exit(1);
  }

  const res = await api<{
    rotated: true;
    revoked_key_id: string;
    new_key: { id: string; label: string; key: string; created_at: string | null };
    note: string;
  }>(
    cfg,
    `/v1/accounts/${encodeURIComponent(accountId)}/api-keys/${encodeURIComponent(keyId)}/rotate`,
    { method: 'POST', verbose: !!args.flags.verbose },
  );

  if (args.flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(bold(`Rotated "${res.new_key.label}" (copy now, it will NOT be shown again):`));
  console.log(`  ${res.new_key.key}`);
  console.log();
  console.log(dim(`new_key_id ${res.new_key.id} · revoked ${res.revoked_key_id}`));
  console.log(dim(res.note));
}

async function cmdSignups(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const rows = await api<Array<Record<string, unknown>>>(cfg, '/v1/user/signups', {
    verbose: !!args.flags.verbose,
  });
  const filtered =
    typeof args.flags.status === 'string'
      ? rows.filter((r) => r.status === args.flags.status)
      : rows;
  output(filtered, !!args.flags.json, [
    ['status', 'STATUS'],
    ['provider_slug', 'PROVIDER'],
    ['tenant_name', 'TENANT'],
    ['created_at', 'CREATED'],
  ]);
}

async function cmdInbox(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const limit = typeof args.flags.limit === 'string' ? args.flags.limit : '25';
  const rows = await api<Array<Record<string, unknown>>>(
    cfg,
    `/v1/user/inbox?limit=${encodeURIComponent(limit)}`,
    { verbose: !!args.flags.verbose },
  );
  output(rows, !!args.flags.json, [
    ['from', 'FROM'],
    ['subject', 'SUBJECT'],
    ['received_at', 'RECEIVED'],
  ]);
}

async function cmdShare(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const ttl = parseDurationMinutes(String(args.flags.ttl ?? '10m'));
  const uses = Number(args.flags.uses ?? 1);

  const res = await api<{ url: string; expires_at: string }>(
    cfg,
    '/v1/user/magic-links',
    {
      method: 'POST',
      body: JSON.stringify({ ttl_minutes: ttl, max_uses: uses }),
      verbose: !!args.flags.verbose,
    },
  );

  if (args.flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(bold('Share link (copy now, it will NOT be shown again):'));
  console.log(`  ${res.url}`);
  console.log();
  console.log(dim(`expires ${res.expires_at}`));
}

function parseDurationMinutes(raw: string): number {
  const m = raw.match(/^(\d+)\s*(m|min|h|hr)?$/i);
  if (!m) return 10;
  const n = parseInt(m[1], 10);
  const unit = (m[2] ?? 'm').toLowerCase();
  return unit.startsWith('h') ? Math.min(60, n * 60) : Math.min(60, n);
}

// ---------------------------------------------------------------------------
// Commands: integrator subscription (Relay's only revenue surface)
// ---------------------------------------------------------------------------
function resolveTenantId(
  cfg: RelayConfig,
  args: ParsedArgs,
): string {
  const override =
    typeof args.flags.tenant === 'string' ? args.flags.tenant : null;
  const active =
    override ?? cfg.active_tenant ?? process.env.RELAY_TENANT_ID ?? null;
  if (!active) {
    console.error(
      '✗ no active tenant. Pass --tenant <id> or set active_tenant in ~/.relay/config.json.',
    );
    process.exit(1);
  }
  return active;
}

interface SubscriptionSummary {
  status: string | null;
  plan: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  canceled_at: string | null;
  stripe_customer_id: string | null;
}

async function cmdSubscription(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const tenantId = resolveTenantId(cfg, args);
  const res = await api<SubscriptionSummary>(cfg, '/v1/dev/billing/summary', {
    headers: { 'X-Relay-Tenant': tenantId },
    verbose: !!args.flags.verbose,
  });

  if (args.flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  console.log(bold('Tenant subscription') + dim(`  (${tenantId})`));
  const pad = (k: string) => k.padEnd(22);
  console.log(`  ${pad('status')}${res.status ?? dim('none')}`);
  console.log(`  ${pad('plan')}${res.plan ?? dim('—')}`);
  console.log(
    `  ${pad('trial_ends_at')}${res.trial_ends_at ?? dim('—')}`,
  );
  console.log(
    `  ${pad('current_period_end')}${res.current_period_end ?? dim('—')}`,
  );
  if (res.canceled_at) {
    console.log(`  ${pad('canceled_at')}${res.canceled_at}`);
  }
}

async function cmdSubscribe(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const tenantId = resolveTenantId(cfg, args);
  const plan =
    typeof args.flags.plan === 'string' ? args.flags.plan : 'starter';

  const res = await api<{ url: string }>(cfg, '/v1/dev/billing/subscribe', {
    method: 'POST',
    headers: { 'X-Relay-Tenant': tenantId },
    body: JSON.stringify({ plan }),
    verbose: !!args.flags.verbose,
  });

  if (args.flags.json) {
    console.log(JSON.stringify({ url: res.url }, null, 2));
    return;
  }

  console.log(
    `Opening Stripe Checkout for tenant ${bold(tenantId)} on plan ${bold(plan)} …`,
  );
  console.log(dim(`  ${res.url}`));
  if (!args.flags.yes) {
    openInBrowser(res.url);
  }
}

// ---------------------------------------------------------------------------
// Commands: dev workspace
// ---------------------------------------------------------------------------
async function cmdProducts(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const sub = args.positional[1];

  if (!sub) {
    const rows = await api<Array<Record<string, unknown>>>(cfg, '/v1/dev/products', {
      verbose: !!args.flags.verbose,
    });
    output(rows, !!args.flags.json, [
      ['slug', 'SLUG'],
      ['display_name', 'NAME'],
      ['verification_mode', 'MODE'],
      ['signups_week', 'WEEK'],
      ['signups_total', 'TOTAL'],
    ]);
    return;
  }

  const slug = args.positional[2];
  if (!slug) {
    console.error(`usage: relay products ${sub} <slug>`);
    process.exit(1);
  }

  if (sub === 'show') {
    const rows = await api<Array<Record<string, unknown>>>(cfg, '/v1/dev/products', {
      verbose: !!args.flags.verbose,
    });
    const row = rows.find((r) => r.slug === slug);
    if (!row) {
      console.error(`✗ product "${slug}" not found`);
      process.exit(1);
    }
    output(row, !!args.flags.json);
    return;
  }

  if (sub === 'rotate') {
    const res = await api<{ webhook_secret: string }>(
      cfg,
      `/v1/dev/products/${encodeURIComponent(slug)}/rotate`,
      { method: 'POST', verbose: !!args.flags.verbose },
    );
    if (args.flags.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(bold('New webhook secret (copy now, not shown again):'));
      console.log('  ' + res.webhook_secret);
    }
    return;
  }

  console.error(`unknown subcommand: products ${sub}`);
  process.exit(1);
}

async function promptUser(question: string): Promise<string> {
  const rl = createInterface({ input, output: output_ });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

function assertSlug(slug: string): void {
  if (!/^[a-z0-9-]+$/.test(slug) || slug.length < 2 || slug.length > 60) {
    console.error(
      `✗ --slug must match [a-z0-9-]+ and be 2-60 chars (got "${slug}")`,
    );
    process.exit(1);
  }
}

function assertUrl(label: string, raw: string): void {
  try {
    // eslint-disable-next-line no-new
    new URL(raw);
  } catch {
    console.error(`✗ ${label} is not a valid URL: ${raw}`);
    process.exit(1);
  }
}

async function cmdRegisterProduct(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const nonInteractive = !!args.flags.yes;

  let slug = typeof args.flags.slug === 'string' ? args.flags.slug : '';
  let displayName =
    typeof args.flags['display-name'] === 'string'
      ? args.flags['display-name']
      : '';
  let signupWebhookUrl =
    typeof args.flags['signup-webhook-url'] === 'string'
      ? args.flags['signup-webhook-url']
      : '';
  const teardownWebhookUrl =
    typeof args.flags['teardown-webhook-url'] === 'string'
      ? args.flags['teardown-webhook-url']
      : undefined;
  let tenantId =
    typeof args.flags.tenant === 'string'
      ? args.flags.tenant
      : process.env.RELAY_TENANT_ID ?? '';
  const verificationMode =
    typeof args.flags['verification-mode'] === 'string'
      ? args.flags['verification-mode']
      : undefined;

  const missing = (label: string) => {
    if (nonInteractive) {
      console.error(
        `✗ --${label} is required in non-interactive mode (--yes).`,
      );
      process.exit(1);
    }
    if (!process.stdin.isTTY) {
      console.error(
        `✗ --${label} is required (no TTY available for interactive prompts).`,
      );
      process.exit(1);
    }
  };

  if (!slug) {
    missing('slug');
    slug = await promptUser('Product slug (a-z0-9-): ');
  }
  assertSlug(slug);

  if (!displayName) {
    missing('display-name');
    displayName = await promptUser('Display name: ');
  }
  if (!displayName) {
    console.error('✗ display name cannot be empty');
    process.exit(1);
  }

  if (!signupWebhookUrl) {
    missing('signup-webhook-url');
    signupWebhookUrl = await promptUser('Signup webhook URL: ');
  }
  assertUrl('--signup-webhook-url', signupWebhookUrl);
  if (teardownWebhookUrl) {
    assertUrl('--teardown-webhook-url', teardownWebhookUrl);
  }

  if (!tenantId) {
    missing('tenant');
    tenantId = await promptUser('Tenant id (uuid): ');
  }
  if (!tenantId) {
    console.error('✗ --tenant is required');
    process.exit(1);
  }

  const payload: Record<string, unknown> = {
    slug,
    display_name: displayName,
    signup_webhook_url: signupWebhookUrl,
  };
  if (teardownWebhookUrl) payload.teardown_webhook_url = teardownWebhookUrl;
  if (verificationMode) payload.verification_mode = verificationMode;

  let res: { id: string; slug: string; webhook_secret: string };
  try {
    res = await api<{ id: string; slug: string; webhook_secret: string }>(
      cfg,
      '/v1/dev/products',
      {
        method: 'POST',
        headers: { 'X-Relay-Tenant': tenantId },
        body: JSON.stringify(payload),
        verbose: !!args.flags.verbose,
      },
    );
  } catch (e) {
    throw e;
  }

  if (args.flags.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(bold('✓ Product registered.'));
    console.log(`  id:   ${res.id}`);
    console.log(`  slug: ${res.slug}`);
    console.log();
    console.log(
      bold('Webhook secret (shown once — save now, will NOT be shown again):'),
    );
    console.log('  ' + res.webhook_secret);
    console.log();
  }

  // Offer to append the secret to .env.local so the integrator can paste it
  // straight into their Next.js project.
  const envPath = join(process.cwd(), '.env.local');
  const line = `RELAY_WEBHOOK_SECRET=${res.webhook_secret}\n`;

  let writeIt = nonInteractive;
  if (!writeIt) {
    if (!process.stdin.isTTY) {
      // No TTY and no --yes: skip silently so the user can copy it manually.
      return;
    }
    const answer = await promptUser(
      `Append RELAY_WEBHOOK_SECRET to ${envPath}? [Y/n] `,
    );
    writeIt = answer === '' || /^y(es)?$/i.test(answer);
  }

  if (!writeIt) return;

  try {
    let existing = '';
    try {
      existing = await readFile(envPath, 'utf8');
    } catch {
      // file does not exist; we'll create it via appendFile
    }
    if (existing.includes('RELAY_WEBHOOK_SECRET=')) {
      console.error(
        `! ${envPath} already contains RELAY_WEBHOOK_SECRET — not overwriting. New value printed above.`,
      );
      return;
    }
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    await appendFile(envPath, prefix + line);
    console.log(`✓ wrote RELAY_WEBHOOK_SECRET to ${envPath}`);
  } catch (e) {
    console.error(
      `! failed to write ${envPath}: ${(e as Error).message}. Copy the secret above manually.`,
    );
  }
}

async function cmdStats(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const res = await api<{
    tenant: { name: string; slug: string };
    weekly: Record<string, number>;
  }>(cfg, '/v1/dev', { verbose: !!args.flags.verbose });
  if (args.flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(bold(`${res.tenant.name}  `) + dim(`(/${res.tenant.slug})`));
  console.log();
  for (const [k, v] of Object.entries(res.weekly)) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }
}

async function cmdUsers(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const rows = await api<Array<Record<string, unknown>>>(cfg, '/v1/dev/users', {
    verbose: !!args.flags.verbose,
  });
  output(rows, !!args.flags.json, [
    ['email', 'EMAIL'],
    ['signups', 'SIGNUPS'],
    ['last_product', 'LAST_PRODUCT'],
    ['last_status', 'LAST_STATUS'],
    ['last_signup_at', 'LAST_SIGNUP'],
  ]);
}

async function cmdLogs(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const limit = typeof args.flags.limit === 'string' ? args.flags.limit : '50';
  const rows = await api<Array<Record<string, unknown>>>(
    cfg,
    `/v1/dev/logs?limit=${encodeURIComponent(limit)}`,
    { verbose: !!args.flags.verbose },
  );
  output(rows, !!args.flags.json, [
    ['status', 'STATUS'],
    ['provider_slug', 'PROVIDER'],
    ['created_at', 'CREATED'],
  ]);
}

async function cmdScan(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const slug = args.positional[1];
  if (!slug) {
    console.error('usage: relay scan <product-slug> [--full] [--i-know]');
    process.exit(1);
  }

  // Look up the product.
  const products = await api<Array<{ slug: string; signup_webhook_url: string }>>(
    cfg,
    '/v1/dev/products',
    { verbose: !!args.flags.verbose },
  );
  const p = products.find((x) => x.slug === slug);
  if (!p) {
    console.error(`✗ product "${slug}" not found on active workspace`);
    process.exit(1);
  }

  const url = p.signup_webhook_url;
  console.log(`Scanning ${bold(slug)} → ${dim(url)}`);

  // 1. Reachability (HEAD/GET). We don't know auth — expect anything that
  //    isn't a DNS/TLS error to be "reachable".
  let reachable = false;
  let latencyMs = 0;
  try {
    const t0 = Date.now();
    await fetch(url, { method: 'OPTIONS' }).catch(() =>
      fetch(url, { method: 'GET' }),
    );
    latencyMs = Date.now() - t0;
    reachable = true;
  } catch (err) {
    console.log(`  ${color('31', '✗')} reachability — ${(err as Error).message}`);
  }
  if (reachable) {
    console.log(`  ${color('32', '✓')} reachability  ${dim(`${latencyMs}ms`)}`);
  }

  // 2. TLS cert freshness — rough: HEAD request to the hostname, we know
  //    it's TLS if the URL is https.
  const isHttps = url.startsWith('https://');
  console.log(`  ${isHttps ? color('32', '✓') : color('33', '!')} https    ${dim(isHttps ? 'tls present' : 'http — not recommended')}`);

  // 3. Signature verification via a synthetic ping. We don't have the secret,
  //    so we post an unsigned request and expect 401/403 — if the server
  //    accepts unsigned payloads, surface that as a warning.
  try {
    const body = JSON.stringify({ kind: 'ping', __dry_run: true });
    const t0 = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const ms = Date.now() - t0;
    if (res.status === 401 || res.status === 403) {
      console.log(`  ${color('32', '✓')} signature ${dim(`rejects unsigned (${res.status}, ${ms}ms)`)}`);
    } else if (res.ok) {
      console.log(`  ${color('33', '!')} signature ${dim(`accepted unsigned — webhook must verify X-Relay-Signature (${res.status}, ${ms}ms)`)}`);
    } else {
      console.log(`  ${color('32', '✓')} signature ${dim(`unsigned returned ${res.status} (${ms}ms)`)}`);
    }
  } catch (err) {
    console.log(`  ${color('33', '!')} signature — ${(err as Error).message}`);
  }

  if (!reachable) {
    console.log();
    console.log(color('31', 'Scan failed.'));
    process.exit(1);
  }

  // Optional --full: drive a real signed signup end-to-end against the
  // tenant's webhook, poll until terminal, and clean up. Used during
  // concierge integration to prove a tenant is wired up before flipping
  // them from staging to production.
  if (args.flags.full) {
    const env = (process.env.RELAY_ENV ?? '').toLowerCase();
    const isProd =
      env === 'production' || cfg.base_url.includes('relay.cumulush.com');
    if (isProd && !args.flags['i-know']) {
      console.log();
      console.log(
        color(
          '31',
          '✗ --full creates a real signup against the tenant webhook.',
        ),
      );
      console.log(
        dim(
          '  Refusing on production. Re-run with RELAY_BASE_URL pointing to staging,\n' +
            '  or pass --i-know if you know what you\'re doing.',
        ),
      );
      process.exit(1);
    }

    console.log();
    console.log(`Running full end-to-end signup against ${bold(slug)}…`);

    // (1) POST /v1/signups — kick the signup workflow.
    let signupId: string;
    try {
      const t0 = Date.now();
      const created = await api<{ signup_id: string; status: string }>(cfg, '/v1/signups', {
        method: 'POST',
        body: JSON.stringify({ provider: slug, input: {} }),
        verbose: !!args.flags.verbose,
      });
      signupId = created.signup_id;
      console.log(
        `  ${color('32', '✓')} POST /v1/signups ${dim(`→ ${signupId} (${Date.now() - t0}ms)`)}`,
      );
    } catch (err) {
      console.log(
        `  ${color('31', '✗')} POST /v1/signups — ${(err as Error).message}`,
      );
      process.exit(1);
    }

    // (2) Poll GET /v1/signups/:id until terminal.
    const pollStart = Date.now();
    const POLL_TIMEOUT_MS = 30_000;
    let status = 'pending';
    let accountId: string | null = null;
    while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
      try {
        const s = await api<{
          status: string;
          account_id?: string | null;
          error?: string | null;
        }>(cfg, `/v1/signups/${signupId}`, { verbose: !!args.flags.verbose });
        status = s.status;
        accountId = s.account_id ?? null;
        if (status === 'complete' || status === 'failed') break;
      } catch (err) {
        console.log(
          `  ${color('31', '✗')} GET /v1/signups/:id — ${(err as Error).message}`,
        );
        process.exit(1);
      }
      await sleep(1_000);
    }
    const totalMs = Date.now() - pollStart;
    if (status === 'complete' && accountId) {
      console.log(
        `  ${color('32', '✓')} signup delivered ${dim(`account=${accountId} (${totalMs}ms)`)}`,
      );
    } else if (status === 'failed') {
      console.log(
        `  ${color('31', '✗')} signup failed ${dim(`(${totalMs}ms)`)}`,
      );
      process.exit(1);
    } else {
      console.log(
        `  ${color('31', '✗')} signup did not reach terminal status within 30s ${dim(`(last status=${status})`)}`,
      );
      process.exit(1);
    }

    // (3) DELETE /v1/accounts/:id — clean up the test account.
    try {
      await api(cfg, `/v1/accounts/${accountId}`, {
        method: 'DELETE',
        verbose: !!args.flags.verbose,
      });
      console.log(`  ${color('32', '✓')} DELETE /v1/accounts/${accountId}`);
    } catch (err) {
      console.log(
        `  ${color('33', '!')} cleanup — ${(err as Error).message} ${dim('(test account remains)')}`,
      );
    }
  }

  console.log();
  console.log(color('32', args.flags.full ? 'Full scan complete.' : 'Scan complete.'));
}

// ---------------------------------------------------------------------------
// init — scaffold a Relay webhook handler into a Next.js project
// ---------------------------------------------------------------------------
const ROUTE_TEMPLATE = `/**
 * Relay agent-signup webhook.
 */
import { relay } from '@cumulus/server';

export const POST = relay.webhook({
  secret: process.env.RELAY_WEBHOOK_SECRET!,
  onSignup: async ({ email, input }) => {
    throw new Error('implement onSignup in app/api/agent-signup/route.ts');
  },
  onCreateApiKey: async ({ account_id, label }) => {
    throw new Error('implement onCreateApiKey');
  },
  onRevokeApiKey: async ({ account_id, key_id }) => {
    throw new Error('implement onRevokeApiKey');
  },
  onTeardown: async ({ account_id }) => {
    throw new Error('implement onTeardown');
  },
});
`;

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function cmdInit(): Promise<void> {
  const cwd = process.cwd();
  const hasNextConfig =
    (await pathExists(join(cwd, 'next.config.ts'))) ||
    (await pathExists(join(cwd, 'next.config.mjs'))) ||
    (await pathExists(join(cwd, 'next.config.js')));
  const hasAppDir = await pathExists(join(cwd, 'app'));
  if (!hasNextConfig || !hasAppDir) {
    console.error(
      "Doesn't look like a Next.js App Router project. Run this from your Next.js project root.",
    );
    process.exit(1);
  }
  const routeDir = join(cwd, 'app', 'api', 'agent-signup');
  const routePath = join(routeDir, 'route.ts');
  if (await pathExists(routePath)) {
    console.error(`${routePath} already exists — refusing to overwrite.`);
    process.exit(1);
  }
  await mkdir(routeDir, { recursive: true });
  await writeFile(routePath, ROUTE_TEMPLATE);
  console.log(`✓ wrote ${routePath.replace(cwd + '/', '')}`);
  const envExample = join(cwd, '.env.example');
  if (await pathExists(envExample)) {
    const existing = await readFile(envExample, 'utf8');
    if (!existing.includes('RELAY_WEBHOOK_SECRET')) {
      await writeFile(
        envExample,
        existing +
          (existing.endsWith('\n') ? '' : '\n') +
          '\n# Mint at https://relay.cumulush.com/dev/products\nRELAY_WEBHOOK_SECRET=\n',
      );
      console.log('✓ appended RELAY_WEBHOOK_SECRET stub to .env.example');
    }
  }
  console.log(
    `\nNext steps:\n  1. npm install @cumulus/server\n  2. relay products  (register this app)\n  3. Put the minted secret in .env.local as RELAY_WEBHOOK_SECRET\n  4. Fill in the TODOs in app/api/agent-signup/route.ts\n  5. relay scan <slug>   (end-to-end health check)\n`,
  );
}

// ---------------------------------------------------------------------------
// Commands: agent guide (per-user markdown memory)
// ---------------------------------------------------------------------------
async function readStdinAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface GuideBody {
  content: string;
  updated_at: string | null;
  bytes: number;
}

async function cmdGuide(args: ParsedArgs): Promise<void> {
  const sub = args.positional[1];
  if (!sub || sub === 'read') return cmdGuideRead(args);
  if (sub === 'write') return cmdGuideWrite(args);
  if (sub === 'edit') return cmdGuideEdit(args);
  console.error(`unknown guide subcommand: ${sub}`);
  console.error('usage: relay guide [read|write|edit]');
  process.exit(1);
}

async function cmdGuideRead(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const res = await api<GuideBody>(cfg, '/v1/agent-guide', {
    verbose: !!args.flags.verbose,
  });
  if (args.flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (!res.content) {
    console.error(
      dim('(empty — write your guide with `echo "..." | relay guide write` or `relay guide edit`)'),
    );
    return;
  }
  process.stdout.write(res.content);
  if (!res.content.endsWith('\n')) process.stdout.write('\n');
}

async function cmdGuideWrite(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  if (process.stdin.isTTY) {
    console.error(
      '✗ relay guide write reads from stdin. Pipe in the new guide body, e.g. `cat guide.md | relay guide write`.',
    );
    process.exit(1);
  }
  const content = await readStdinAll();
  const res = await api<{ updated_at: string; bytes: number }>(
    cfg,
    '/v1/agent-guide',
    {
      method: 'PUT',
      body: JSON.stringify({ content }),
      verbose: !!args.flags.verbose,
    },
  );
  if (args.flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(`✓ updated ${res.bytes} bytes at ${res.updated_at}`);
}

async function cmdGuideEdit(args: ParsedArgs): Promise<void> {
  const cfg = await requireConfig();
  const current = await api<GuideBody>(cfg, '/v1/agent-guide', {
    verbose: !!args.flags.verbose,
  });

  const tmpDir = join(homedir(), '.relay');
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const tmpPath = join(tmpDir, `guide.${Date.now()}.md`);
  await writeFile(tmpPath, current.content ?? '', { mode: 0o600 });

  const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [tmpPath], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${editor} exited ${code}`));
    });
  });

  const updated = await readFile(tmpPath, 'utf8');
  await rm(tmpPath, { force: true });

  if (updated === (current.content ?? '')) {
    console.log(dim('(no changes — skipping PUT)'));
    return;
  }

  const res = await api<{ updated_at: string; bytes: number }>(
    cfg,
    '/v1/agent-guide',
    {
      method: 'PUT',
      body: JSON.stringify({ content: updated }),
      verbose: !!args.flags.verbose,
    },
  );
  console.log(`✓ updated ${res.bytes} bytes at ${res.updated_at}`);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
function help(): void {
  console.log(`relay — CLI for agent-driven signup

${bold('Auth')}
  login                       Sign in via the browser
  logout                      Remove local credentials
  whoami                      Print current identity

${bold('Workspace shells')}
  workspace list              List shells (user / dev tenants)
  workspace switch <target>   Switch to "user" or a tenant slug/id

${bold('Personal workspaces')} ${dim('(isolated sets of accounts, keys, inbox per-user)')}
  workspaces list                               Your personal workspaces
  workspaces create <name> [--slug S] [--no-switch]
                                                Create + make active
  workspaces rename <slug> <new name>           Rename
  workspaces delete <slug> [--yes]              Hard delete (type-name confirm)

${bold('Discovery')}
  providers [list]            List every registered signup provider
  providers show <id>         Full metadata + input JSON Schema + example body

${bold('Your data')}
  accounts [--provider X]     Third-party accounts your agents created
  keys [--account ID]         Flat view of API key bookkeeping rows
  keys mint --account ID      Mint a new API key (plaintext printed once)
  keys rotate --account ID --key ID
                              Rotate = retrieve-my-key (new plaintext, old revoked)
  signups [--status S]        Signup timeline
  inbox [--limit N]           Recent inbound emails
  share [--ttl 10m]           Mint a read-only share link

${bold('Agent guide (per-user markdown)')}
  guide read                  Print your agent guide to stdout
  guide write                 Replace the guide from stdin (cat file | relay guide write)
  guide edit                  Open $EDITOR, save to persist

${bold('Billing')}
  subscription [--tenant id]  Tenant subscription snapshot
  subscribe [--plan builder]  Open Stripe Checkout for a tenant plan

${bold('Developer')}
  products                    List products on the active tenant
  products show <slug>        Product detail
  products rotate <slug>      Rotate webhook secret
  register-product [flags]    Mint a new product + webhook_secret over bearer auth
                                Flags: --slug --display-name --signup-webhook-url
                                       [--teardown-webhook-url] [--verification-mode M]
                                       --tenant <id> [--yes]
  stats                       Weekly aggregates
  users                       End-users who signed up via this tenant
  logs [--limit N]            Recent signup_jobs
  scan <slug>                 Webhook health scan
                                Add --full to drive a real signup end-to-end
                                (refused on production without --i-know).

${bold('Scaffolding')}
  init                        Drop a webhook handler into a Next.js project

${bold('Flags')}
  --json                      Emit JSON
  --verbose                   Trace HTTP calls

Env:
  RELAY_BASE_URL              API host (default ${DEFAULT_BASE_URL})
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args.positional[0] ?? '';

  try {
    switch (cmd) {
      case 'login':
        return cmdLogin();
      case 'logout':
        return cmdLogout();
      case 'whoami':
        return cmdWhoami(args);
      case 'workspace': {
        const sub = args.positional[1];
        if (sub === 'list' || !sub) return cmdWorkspaceList(args);
        if (sub === 'switch') return cmdWorkspaceSwitch(args);
        console.error(`unknown workspace subcommand: ${sub}`);
        process.exit(1);
        return;
      }
      case 'workspaces':
        return cmdUserWorkspaces(args);
      case 'providers':
        return cmdProviders(args);
      case 'accounts':
        return cmdAccounts(args);
      case 'keys':
        return cmdKeys(args);
      case 'signups':
        return cmdSignups(args);
      case 'inbox':
        return cmdInbox(args);
      case 'share':
        return cmdShare(args);
      case 'subscription':
        return cmdSubscription(args);
      case 'subscribe':
        return cmdSubscribe(args);
      case 'products':
        return cmdProducts(args);
      case 'register-product':
        return cmdRegisterProduct(args);
      case 'stats':
        return cmdStats(args);
      case 'users':
        return cmdUsers(args);
      case 'logs':
        return cmdLogs(args);
      case 'scan':
        return cmdScan(args);
      case 'init':
        return cmdInit();
      case '':
      case 'help':
      case '--help':
      case '-h':
        help();
        return;
      default:
        console.error(`unknown command: ${cmd}\n`);
        help();
        process.exit(1);
    }
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
