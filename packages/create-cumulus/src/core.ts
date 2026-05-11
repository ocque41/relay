import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  agentAuthModes,
  buildFiles,
  isAgentAuthMode,
  isPackageManager,
  isTemplateName,
  packageManagers,
  type AgentAuthMode,
  type PackageManager,
  type RenderOptions,
  type TemplateName,
} from './templates.js';

const publicTemplateChoices = ['full', 'outer', 'inner', 'agent-auth'] as const;

export interface ParsedArgs {
  projectName?: string;
  template?: TemplateName;
  agentAuth?: AgentAuthMode;
  companyName?: string;
  packageManager?: PackageManager;
  install?: boolean;
  git?: boolean;
  help?: boolean;
}

export interface CreateOptions extends RenderOptions {
  targetDir: string;
  install: boolean;
  git: boolean;
}

export interface CreateResult {
  targetDir: string;
  filesWritten: string[];
}

interface RawArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function rawParse(argv: string[]): RawArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '--install') {
      flags.install = true;
      continue;
    }
    if (arg === '--no-install') {
      flags.install = false;
      continue;
    }
    if (arg === '--git') {
      flags.git = true;
      continue;
    }
    if (arg === '--no-git') {
      flags.git = false;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[arg.slice(2)] = argv[++i];
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

function readStringFlag(
  flags: Record<string, string | boolean>,
  key: string,
): string | undefined {
  const value = flags[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeTemplateName(value: string): TemplateName | undefined {
  switch (value) {
    case 'full':
    case 'agent-auth':
      return value;
    case 'outer':
    case 'marketing':
      return 'marketing';
    case 'inner':
    case 'inside':
      return 'inside';
    default:
      return undefined;
  }
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  const raw = rawParse(argv);
  const templateFlag = readStringFlag(raw.flags, 'template');
  const agentAuthFlag = readStringFlag(raw.flags, 'agent-auth');
  const packageManagerFlag = readStringFlag(raw.flags, 'package-manager');
  let template: TemplateName | undefined;
  let agentAuth: AgentAuthMode | undefined;
  let packageManager: PackageManager | undefined;

  if (templateFlag) {
    const normalizedTemplate = normalizeTemplateName(templateFlag);
    if (!normalizedTemplate || !isTemplateName(normalizedTemplate)) {
      throw new Error(
        `invalid --template: ${templateFlag}. Use full, outer, inner, or agent-auth.`,
      );
    }
    template = normalizedTemplate;
  }
  if (agentAuthFlag) {
    if (!isAgentAuthMode(agentAuthFlag)) {
      throw new Error(`invalid --agent-auth: ${agentAuthFlag}`);
    }
    agentAuth = agentAuthFlag;
  }
  if (packageManagerFlag) {
    if (!isPackageManager(packageManagerFlag)) {
      throw new Error(`invalid --package-manager: ${packageManagerFlag}`);
    }
    packageManager = packageManagerFlag;
  }

  return {
    projectName: raw.positional[0],
    template,
    agentAuth,
    companyName: readStringFlag(raw.flags, 'company'),
    packageManager,
    install: typeof raw.flags.install === 'boolean' ? raw.flags.install : undefined,
    git: typeof raw.flags.git === 'boolean' ? raw.flags.git : undefined,
    help: raw.flags.help === true,
  };
}

export function packageNameFromProject(projectName: string): string {
  const base = basename(projectName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) return 'cumulus-app';
  return base;
}

export function companyFromProject(projectName: string): string {
  const base = basename(projectName).replace(/[-_]+/g, ' ').trim();
  if (!base) return 'Acme Inc';
  return base
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function detectPackageManager(): PackageManager {
  const userAgent = process.env.npm_config_user_agent ?? '';
  if (userAgent.startsWith('pnpm')) return 'pnpm';
  if (userAgent.startsWith('yarn')) return 'yarn';
  if (userAgent.startsWith('bun')) return 'bun';
  return 'npm';
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptChoice<T extends string>(
  rl: ReturnType<typeof createInterface>,
  label: string,
  choices: readonly T[],
  fallback: T,
): Promise<T> {
  const answer = (
    await rl.question(`${label} (${choices.join('/')}) [${fallback}]: `)
  ).trim();
  if (!answer) return fallback;
  if ((choices as readonly string[]).includes(answer)) return answer as T;
  throw new Error(`invalid ${label}: ${answer}`);
}

async function promptTemplate(rl: ReturnType<typeof createInterface>): Promise<TemplateName> {
  output.write(`\nTemplates:\n`);
  output.write(`  full       Outer site + inner app + agent auth.\n`);
  output.write(`  outer      Marketing site, docs, public pages, signup/action endpoints.\n`);
  output.write(`  inner      Dashboards, /me workspace, settings, API, playground.\n`);
  output.write(`  agent-auth Smallest Relay-compatible auth, signup, and actions starter.\n\n`);
  const choice = await promptChoice(rl, 'Template', publicTemplateChoices, 'full');
  const normalized = normalizeTemplateName(choice);
  if (!normalized) throw new Error(`invalid Template: ${choice}`);
  return normalized;
}

async function promptString(
  rl: ReturnType<typeof createInterface>,
  label: string,
  fallback: string,
): Promise<string> {
  const answer = (await rl.question(`${label} [${fallback}]: `)).trim();
  return answer || fallback;
}

async function promptBoolean(
  rl: ReturnType<typeof createInterface>,
  label: string,
  fallback: boolean,
): Promise<boolean> {
  const hint = fallback ? 'Y/n' : 'y/N';
  const answer = (await rl.question(`${label} (${hint}): `)).trim().toLowerCase();
  if (!answer) return fallback;
  if (answer === 'y' || answer === 'yes') return true;
  if (answer === 'n' || answer === 'no') return false;
  throw new Error(`invalid ${label}: ${answer}`);
}

export async function resolveCreateOptions(
  parsed: ParsedArgs,
  cwd = process.cwd(),
): Promise<CreateOptions> {
  if (parsed.help) {
    throw new Error('help_requested');
  }

  const interactive = isInteractive();
  let projectName = parsed.projectName;
  let template = parsed.template;
  let agentAuth = parsed.agentAuth;
  let companyName = parsed.companyName;
  let packageManager = parsed.packageManager;
  let install = parsed.install;
  let git = parsed.git;

  if (interactive) {
    const rl = createInterface({ input, output });
    try {
      projectName = projectName ?? (await promptString(rl, 'Project directory', 'my-cumulus-app'));
      template = template ?? (await promptTemplate(rl));
      agentAuth =
        agentAuth ?? (await promptChoice(rl, 'Agent auth', agentAuthModes, 'hosted'));
      companyName =
        companyName ?? (await promptString(rl, 'Company name', companyFromProject(projectName)));
      packageManager =
        packageManager ??
        (await promptChoice(rl, 'Package manager', packageManagers, detectPackageManager()));
      install = install ?? (await promptBoolean(rl, 'Install dependencies', true));
      git = git ?? (await promptBoolean(rl, 'Initialize git', true));
    } finally {
      rl.close();
    }
  }

  projectName = projectName ?? 'my-cumulus-app';
  template = template ?? 'full';
  agentAuth = agentAuth ?? 'hosted';
  companyName = companyName ?? companyFromProject(projectName);
  packageManager = packageManager ?? detectPackageManager();
  install = install ?? false;
  git = git ?? false;

  const targetDir = resolve(cwd, projectName);
  const packageName = packageNameFromProject(projectName);

  return {
    projectName,
    packageName,
    companyName,
    template,
    agentAuth,
    packageManager,
    targetDir,
    install,
    git,
  };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function assertWritableTarget(targetDir: string): Promise<void> {
  if (!(await directoryExists(targetDir))) return;
  const entries = await readdir(targetDir);
  const visible = entries.filter((entry) => entry !== '.DS_Store');
  if (visible.length > 0) {
    throw new Error(`${targetDir} already exists and is not empty`);
  }
}

async function writeProjectFile(targetDir: string, filePath: string, content: string): Promise<void> {
  const absolute = resolve(targetDir, filePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

export async function createProject(options: CreateOptions): Promise<CreateResult> {
  await assertWritableTarget(options.targetDir);
  await mkdir(options.targetDir, { recursive: true });

  const files = buildFiles(options);
  const filesWritten: string[] = [];
  for (const [filePath, content] of files) {
    await writeProjectFile(options.targetDir, filePath, content);
    filesWritten.push(filePath);
  }

  if (options.install) {
    await run(options.packageManager, ['install'], options.targetDir);
  }
  if (options.git) {
    await run('git', ['init'], options.targetDir);
  }

  return { targetDir: options.targetDir, filesWritten };
}

export function helpText(): string {
  return `create-cumulus — bootstrap a Cumulus project

Usage:
  npx create-cumulus@latest <project-name>
  npm create cumulus@latest <project-name>
  create-cumulus <project-name> --template full --agent-auth hosted

Options:
  --template full|outer|inner|agent-auth
  --agent-auth hosted|self-hosted
  --company "Acme Inc"
  --package-manager npm|pnpm|yarn|bun
  --install | --no-install
  --git | --no-git
  -h, --help

Template aliases:
  outer = marketing
  inner = inside
`;
}

export function nextSteps(options: CreateOptions): string {
  const cd = options.projectName.includes('/') ? options.targetDir : options.projectName;
  const runDev = options.packageManager === 'npm' ? 'npm run dev' : `${options.packageManager} dev`;
  return `Created ${options.companyName} in ${options.targetDir}

Next:
  cd ${cd}
  ${options.install ? runDev : `${options.packageManager} install\n  ${runDev}`}

Configure:
  cp .env.example .env.local
  fill SESSION_SECRET and Relay values
`;
}
