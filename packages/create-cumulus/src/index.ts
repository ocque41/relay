#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  createProject,
  helpText,
  nextSteps,
  parseCliArgs,
  resolveCreateOptions,
} from './core.js';

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const parsed = parseCliArgs(argv);
    if (parsed.help) {
      console.log(helpText());
      return;
    }
    const options = await resolveCreateOptions(parsed);
    await createProject(options);
    console.log(nextSteps(options));
  } catch (err) {
    if (err instanceof Error && err.message === 'help_requested') {
      console.log(helpText());
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`create-cumulus: ${message}`);
    process.exitCode = 1;
  }
}

function realpathOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function isCliEntrypoint(
  metaUrl = import.meta.url,
  argvPath = process.argv[1],
): boolean {
  if (!argvPath) return false;
  return realpathOrResolved(fileURLToPath(metaUrl)) === realpathOrResolved(argvPath);
}

if (isCliEntrypoint()) {
  void main();
}
