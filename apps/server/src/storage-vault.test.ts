import { mkdtemp, readFile, readdir, writeFile, access, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { createConfigStateStore, createNodeFileOperations, StorageCipher } from '@approval-mcp/state-store';
import { createCallJournal } from '@approval-mcp/call-journal';
import { StorageVault } from './storage-vault.js';
import { createBackup } from './operations/backup.js';
import { restoreBackup } from './operations/restore.js';
import { restoreStorageMigration } from './operations/restore-storage-migration.js';
import { CredentialVault } from '@approval-mcp/upstream';
import type { UpstreamId, JsonValue } from '@approval-mcp/contracts';

const temp = () => mkdtemp(join(tmpdir(), 'approval-storage-'));
async function legacy(dataDir: string) {
  const state = await createConfigStateStore(dataDir);
  await state.mutate({ type: 'record.upserted', collection: 'settings', id: 'secret', value: { message: 'sensitive-migration-fixture' } });
  await state.close();
  const journal = await createCallJournal(join(dataDir, 'calls'));
  await journal.append({ eventId: 'event1', callId: 'call1', clientTokenId: 'token1', upstreamId: 'upstream1', toolName: 'private_tool', timestamp: '2026-07-28T10:00:00.000Z', type: 'call.received', payload: { body: 'sensitive-history-fixture' } });
  await journal.compressClosedSegments(new Date('2026-07-30T10:00:00Z'));
}

describe('encrypted storage migration', () => {
  it('migrates legacy state, compressed segments and indexes, keeping only encrypted backups', async () => {
    const directory = await temp(); await legacy(directory);
    const key = randomBytes(32);
    const vault = await StorageVault.open(directory, 'http://localhost');
    await vault.initialize(key); await vault.unlock(key);
    expect(vault.manifest?.phase).toBe('ready');
    await expect(access(join(directory, 'state.journal.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(directory, 'calls'))).toEqual([]);
    const state = await createConfigStateStore(vault.runtimeDir, createNodeFileOperations(vault.codec!));
    expect(state.read((v) => v.settings['secret'])).toEqual({ message: 'sensitive-migration-fixture' });
    const journal = await createCallJournal(join(vault.runtimeDir, 'calls'), undefined, vault.codec!);
    expect((await journal.get('call1'))?.events[0]?.payload).toEqual({ body: 'sensitive-history-fixture' });
    await journal.append({ eventId: 'event2', callId: 'call2', clientTokenId: 'token1', upstreamId: 'upstream1', toolName: 'private_tool', timestamp: '2026-07-31T10:00:00.000Z', type: 'call.completed', finalStatus: 'success' });
    expect((await journal.query({})).items).toHaveLength(2);
    expect(await readFile(join(vault.runtimeDir, 'state.snapshot.json'), 'utf8')).not.toContain('sensitive-migration-fixture');
    expect(await readFile(join(vault.runtimeDir, 'calls/calls-2026-07-28.index.jsonl'), 'utf8')).not.toContain('private_tool');
    for (const name of await readdir(join(directory, 'storage-migration-backup'))) {
      const content = await readFile(join(directory, 'storage-migration-backup', name), 'utf8');
      expect(content).not.toContain('sensitive'); expect(content).toMatch(/^amcp-sealed-v1:/);
    }
    await state.close(); vault.destroy();
    const restart = await StorageVault.open(directory, 'http://localhost');
    expect(restart.key).toBeUndefined();
    await expect(restart.unlock(randomBytes(32))).rejects.toThrow();
    await restart.unlock(key);
    await expect((await createCallJournal(join(restart.runtimeDir, 'calls'), undefined, restart.codec!)).get('call1')).resolves.toBeDefined();
    restart.destroy();
  });

  it('resumes after interruption and partial cleanup using encrypted originals', async () => {
    const directory = await temp(); await legacy(directory);
    const key = randomBytes(32);
    const vault = await StorageVault.open(directory, 'http://localhost');
    await vault.initialize(key);
    const interruptedManifest = await readFile(join(directory, 'storage-vault.json'), 'utf8');
    await vault.unlock(key); vault.destroy();
    // Simulate a crash after cleanup but before committing the ready marker.
    const path = join(directory, 'storage-vault.json');
    await writeFile(path, interruptedManifest);
    const resumed = await StorageVault.open(directory, 'http://localhost');
    await resumed.unlock(key);
    const state = await createConfigStateStore(resumed.runtimeDir, createNodeFileOperations(resumed.codec!));
    expect(state.read((v) => v.settings['secret'])).toBeDefined();
    expect(resumed.manifest?.phase).toBe('ready');
    await state.close(); resumed.destroy();
  });

  it('does not remove legacy files if staged state validation fails', async () => {
    const directory = await temp();
    await writeFile(join(directory, 'state.snapshot.json'), 'broken legacy file');
    const vault = await StorageVault.open(directory, 'http://localhost');
    const key = randomBytes(32);
    await expect(vault.initialize(key)).rejects.toThrow();
    expect(await readFile(join(directory, 'state.snapshot.json'), 'utf8')).toBe('broken legacy file');
    expect(vault.manifest).toBeUndefined();
  });

  it('binds encrypted records to vault, purpose and file path and rejects tampering/plaintext', () => {
    const key = randomBytes(32); const codec = new StorageCipher(key, 'vault1');
    const sealed = codec.encode('state.snapshot.json', 'hello');
    expect(codec.decode('state.snapshot.json', sealed)).toBe('hello');
    expect(() => codec.decode('state.journal.jsonl', sealed)).toThrow();
    expect(() => new StorageCipher(key, 'vault2').decode('state.snapshot.json', sealed)).toThrow();
    expect(() => codec.decode('state.snapshot.json', 'hello')).toThrow();
    expect(() => codec.decode('state.snapshot.json', sealed.slice(0, -4) + 'AAAA')).toThrow();
    codec.destroy();
  });

  it('backs up and restores an encrypted installation without writing plaintext', async () => {
    const root = await temp(); const directory = join(root, 'data'); await legacy(directory);
    const key = randomBytes(32); const vault = await StorageVault.open(directory, 'http://localhost');
    await vault.initialize(key); await vault.unlock(key);
    const stateStore = await createConfigStateStore(vault.runtimeDir, createNodeFileOperations(vault.codec!));
    const output = join(root, 'backup');
    await createBackup({ dataDir: directory, output, stateStore });
    await expect(restoreBackup({ input: output, target: join(root, 'dry'), dryRun: true })).resolves.toMatchObject({ valid: true, decryptionValidated: false });
    await expect(restoreBackup({ input: output, target: join(root, 'wrong'), dryRun: true, masterKey: randomBytes(32) })).rejects.toThrow();
    await expect(restoreBackup({ input: output, target: join(root, 'restored'), dryRun: false, masterKey: key })).resolves.toMatchObject({ decryptionValidated: true });
    const restored = await StorageVault.open(join(root, 'restored'), 'http://localhost'); await restored.unlock(key);
    await expect((await createCallJournal(join(restored.runtimeDir, 'calls'), undefined, restored.codec!)).get('call1')).resolves.toBeDefined();
    await stateStore.close(); vault.destroy(); restored.destroy();
  });

  it('rejects a wrong legacy key before changing data, and authenticates migration metadata', async () => {
    const dir = await temp(); const key = randomBytes(32);
    const store = await createConfigStateStore(dir);
    await store.mutate({ type: 'record.upserted', collection: 'upstreams', id: 'fixture', value: { credentials: new CredentialVault(key).encrypt('fixture' as UpstreamId, { authorization: 'Bearer secret-fixture' }) } as unknown as JsonValue });
    await store.close();
    const before = await readFile(join(dir, 'state.snapshot.json'), 'utf8');
    const wrong = await StorageVault.open(dir, 'http://localhost');
    await expect(wrong.initialize(randomBytes(32))).rejects.toThrow();
    expect(await readFile(join(dir, 'state.snapshot.json'), 'utf8')).toBe(before);
    await expect(access(join(dir, 'storage-vault.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const vault = await StorageVault.open(dir, 'http://localhost'); await vault.initialize(key); await vault.unlock(key); vault.destroy();
    const path = join(dir, 'storage-vault.json'); const metadata = JSON.parse(await readFile(path, 'utf8'));
    metadata.phase = 'migrating'; await writeFile(path, JSON.stringify(metadata));
    const modified = await StorageVault.open(dir, 'http://localhost');
    await expect(modified.unlock(key)).rejects.toThrow('metadata authentication');
  });

  it('can explicitly recover the pre-migration legacy files into a new directory for offline rollback', async () => {
    const root = await temp(); const dir = join(root, 'data'); await legacy(dir);
    const key = randomBytes(32); const vault = await StorageVault.open(dir, 'http://localhost');
    await vault.initialize(key); await vault.unlock(key); vault.destroy();
    await expect(restoreStorageMigration({ dataDir: dir, target: join(root, 'wrong'), masterKey: randomBytes(32) })).rejects.toThrow();
    const target = join(root, 'rollback');
    await expect(restoreStorageMigration({ dataDir: dir, target, masterKey: key })).resolves.toMatchObject({ restored: 4 });
    const old = await createConfigStateStore(target);
    expect(old.read((v) => v.settings['secret'])).toEqual({ message: 'sensitive-migration-fixture' });
    await expect((await createCallJournal(join(target, 'calls'))).get('call1')).resolves.toBeDefined();
    await expect(restoreStorageMigration({ dataDir: dir, target, masterKey: key })).rejects.toThrow();
    await old.close();
  });

  it('archives a torn legacy final history record without appending onto that fragment', async () => {
    const dir = await temp();
    const old = await createConfigStateStore(dir); await old.close();
    const history = await createCallJournal(join(dir, 'calls'));
    const event = { eventId: 'first', callId: 'first', clientTokenId: 'token', upstreamId: 'upstream', toolName: 'tool', timestamp: '2026-07-28T10:00:00.000Z', type: 'call.received' as const };
    await history.append(event); await appendFile(join(dir, 'calls/calls-2026-07-28.jsonl'), '{"torn"');
    const vault = await StorageVault.open(dir, 'http://localhost'); const key = randomBytes(32);
    await vault.initialize(key); await vault.unlock(key);
    const journal = await createCallJournal(join(vault.runtimeDir, 'calls'), undefined, vault.codec!);
    await journal.append({ ...event, callId: 'second', eventId: 'second' });
    expect((await journal.query({})).items).toHaveLength(2);
    vault.destroy();
  });
});
