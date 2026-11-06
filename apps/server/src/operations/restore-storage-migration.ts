import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createConfigStateStore, StorageCipher } from '@approval-mcp/state-store';
import { createCallJournal } from '@approval-mcp/call-journal';
import { StorageVault } from '../storage-vault.js';

/** Explicit OFFLINE rollback of the pre-migration files into a NEW directory.
 * This deliberately creates plaintext, and does not include post-migration writes. */
export async function restoreStorageMigration(options: { dataDir: string; target: string; masterKey: Uint8Array }): Promise<{ restored: number }> {
  const root = resolve(options.dataDir); const target = resolve(options.target);
  if (target === root || target.startsWith(root + '/')) throw new Error('Rollback target must be outside the source data directory');
  const vault = await StorageVault.open(root, 'http://localhost');
  vault.verifyKey(options.masterKey);
  const manifest = vault.manifest!;
  if (manifest.legacy.length === 0) throw new Error('This installation has no pre-migration backup');
  const codec = new StorageCipher(options.masterKey, manifest.id);
  const temporary = await mkdtemp(join(dirname(target), '.storage-rollback-'));
  let installed = false;
  try {
    for (const entry of manifest.legacy) {
      const sealed = await readFile(join(root, 'storage-migration-backup', entry.path.replaceAll('/', '__') + '.sealed'), 'utf8');
      const bytes = Buffer.from(codec.decode(`backup/${entry.path}`, sealed), 'base64');
      if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('Migration backup checksum mismatch');
      if (entry.path.split('/').at(-1)!.startsWith('.')) continue;
      const destination = join(temporary, entry.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const file = await open(destination, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    }
    const state = await createConfigStateStore(temporary); await state.close();
    await createCallJournal(join(temporary, 'calls'));
    // mkdir reserves the target, so even an existing empty directory is never overwritten.
    await mkdir(target, { mode: 0o700 });
    try { await rename(temporary, target); } catch (e) { await rmdir(target); throw e; }
    const parent = await open(dirname(target), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    installed = true;
    return { restored: manifest.legacy.filter((entry) => !entry.path.split('/').at(-1)!.startsWith('.')).length };
  } finally { codec.destroy(); if (!installed) await rm(temporary, { recursive: true, force: true }); }
}
