import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isCliEntrypoint } from './index';

describe('isCliEntrypoint', () => {
  it('recognizes npm .bin symlinks as the CLI entrypoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'create-cumulus-bin-'));
    const actual = join(root, 'dist', 'index.js');
    const bin = join(root, 'node_modules', '.bin', 'create-cumulus');

    await mkdir(join(root, 'dist'), { recursive: true });
    await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
    await writeFile(actual, '#!/usr/bin/env node\n');
    await symlink(actual, bin);

    expect(isCliEntrypoint(pathToFileURL(actual).href, bin)).toBe(true);
  });
});
