import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';

import { createConfigStateStore } from '@approval-mcp/state-store';
import { createNodeFileOperations } from '@approval-mcp/state-store';
import { StorageVault } from '../storage-vault.js';

import {
  checksum,
  durableCopy,
  type BackupManifest,
} from './backup.js';

function safePath(root: string, path: string): string {
  const normalized = normalize(path);
  if (
    normalized === '..' ||
    normalized.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    resolve(root, normalized) === resolve(root)
  ) {
    throw new Error(`Unsafe backup path: ${path}`);
  }
  const destination = resolve(root, normalized);
  if (!destination.startsWith(`${resolve(root)}/`)) {
    throw new Error(`Unsafe backup path: ${path}`);
  }
  return destination;
}

export async function restoreBackup(options: {
  input: string;
  target: string;
  dryRun: boolean;
  masterKey?: Uint8Array;
}): Promise<{ valid: true; fileCount: number; decryptionValidated: boolean }> {
  const input = resolve(options.input);
  const manifest = JSON.parse(
    await readFile(join(input, 'manifest.json'), 'utf8'),
  ) as BackupManifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new Error('Unsupported backup manifest');
  }
  for (const file of manifest.files) {
    const source = safePath(input, file.path);
    if (
      (await stat(source)).size !== file.bytes ||
      (await checksum(source)) !== file.sha256
    ) {
      throw new Error(`Backup checksum mismatch: ${file.path}`);
    }
  }

  const temporary = await mkdtemp(join(dirname(resolve(options.target)), '.restore-'));
  let installed = false;
  try {
    for (const file of manifest.files) {
      await durableCopy(
        safePath(input, file.path),
        safePath(temporary, file.path),
      );
    }
    let decryptionValidated = true;
    const storage = await StorageVault.open(temporary, 'http://localhost');
    if (storage.manifest === undefined) {
      const store = await createConfigStateStore(temporary);
      await store.close();
    } else if (options.masterKey === undefined) {
      decryptionValidated = false;
    } else {
      try {
        await storage.unlock(options.masterKey);
        const store = await createConfigStateStore(storage.runtimeDir, createNodeFileOperations(storage.codec!));
        await store.close();
      } finally { storage.destroy(); }
    }
    if (!options.dryRun) {
      await mkdir(dirname(resolve(options.target)), {
        recursive: true,
        mode: 0o700,
      });
      await rename(temporary, resolve(options.target));
      installed = true;
    }
    return { valid: true, fileCount: manifest.files.length, decryptionValidated };
  } finally {
    if (!installed) {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
