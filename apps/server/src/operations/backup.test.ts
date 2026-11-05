import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConfigStateStore } from '@approval-mcp/state-store';
import { describe, expect, it } from 'vitest';

import { createBackup } from './backup.js';
import { restoreBackup } from './restore.js';

describe('backup and restore', () => {
  it('creates a checksummed backup that survives dry-run restore', async () => {
    const root = await mkdtemp(join(tmpdir(), 'approval-backup-'));
    const dataDir = join(root, 'data');
    const output = join(root, 'backup');
    const store = await createConfigStateStore(dataDir);
    await store.mutate({
      type: 'record.upserted',
      collection: 'settings',
      id: 'retention',
      value: { days: 90 },
    });
    const pluginPath = 'plugins/sample/pinned/plugin.mjs';
    await mkdir(join(dataDir, 'plugins/sample/pinned'), { recursive: true });
    await writeFile(join(dataDir, pluginPath), 'export const sample = true;');

    const manifest = await createBackup({ dataDir, output, stateStore: store });

    expect(manifest.files.some((file) => file.path === 'state.snapshot.json')).toBe(
      true,
    );
    expect(manifest.files.some((file) => file.path === pluginPath)).toBe(true);
    await expect(
      restoreBackup({
        input: output,
        target: join(root, 'restored'),
        dryRun: true,
      }),
    ).resolves.toMatchObject({ valid: true });
  });

  it('rejects a backup whose file no longer matches its checksum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'approval-backup-'));
    const dataDir = join(root, 'data');
    const output = join(root, 'backup');
    const store = await createConfigStateStore(dataDir);
    await createBackup({ dataDir, output, stateStore: store });
    const manifest = JSON.parse(
      await readFile(join(output, 'manifest.json'), 'utf8'),
    ) as { files: { path: string }[] };
    await writeFile(join(output, manifest.files[0]!.path), 'tampered');

    await expect(
      restoreBackup({
        input: output,
        target: join(root, 'restored'),
        dryRun: true,
      }),
    ).rejects.toThrow('checksum');
  });
});
