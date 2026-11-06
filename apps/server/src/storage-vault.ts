import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { z } from 'zod';
import { createConfigStateStore, createNodeFileOperations, StorageCipher, encodeLines } from '@approval-mcp/state-store';
import { createCallJournal, rebuildSegmentIndex } from '@approval-mcp/call-journal';
import { CredentialVault } from '@approval-mcp/upstream';
import { PushSecretVault } from './push-notification-service.js';
import type { EncryptedCredentialEnvelope, UpstreamId } from '@approval-mcp/contracts';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const bytes = z.string().regex(/^[A-Za-z0-9_-]+$/).max(20_000);
export const wrappingEnvelopeSchema = z.object({ nonce: bytes.refine((v) => Buffer.from(v, 'base64url').length === 12), ciphertext: bytes.refine((v) => Buffer.from(v, 'base64url').length === 48) }).strict();
export const vaultCredentialSchema = z.object({ id: bytes, publicKey: bytes, counter: z.number().int().nonnegative(), transports: z.array(z.string()).optional() }).strict();
const slotSchema = z.object({ id: z.uuid(), name: z.string().trim().min(1).max(64), salt: bytes, credential: vaultCredentialSchema, wrap: wrappingEnvelopeSchema, createdAt: z.iso.datetime() }).strict();
const manifestSchema = z.object({
  version: z.literal(1), id: z.uuid(), origin: z.url(), check: z.string(), authentication: z.string(),
  phase: z.enum(['migrating', 'ready']),
  legacy: z.array(z.object({ path: z.string().regex(/^(?:state\.(?:snapshot\.json|journal\.jsonl)|calls\/calls-\d{4}-\d{2}-\d{2}(?:\.index)?\.jsonl(?:\.gz)?|(?:calls\/)?\.[a-f0-9-]+\.(?:(?:index|jsonl\.gz)\.)?tmp)$/), sha256: z.string().length(64) }).strict()),
  slots: z.array(slotSchema).max(20), recoveryWrap: wrappingEnvelopeSchema.optional(),
}).strict();
export type VaultSlot = z.infer<typeof slotSchema>;
type Manifest = z.infer<typeof manifestSchema>;
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const exists = async (path: string) => lstat(path).then((value) => { if (!value.isFile()) throw new Error('Storage file must not be a symlink or directory'); return true; }, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e; });

/** Owns the cold-start boundary. No application state is loaded while locked. */
export class StorageVault {
  manifest: Manifest | undefined;
  key: Buffer | undefined;
  codec: StorageCipher | undefined;
  readonly runtimeDir: string;
  private readonly files = createNodeFileOperations();
  private constructor(readonly dataDir: string, readonly origin: string) { this.runtimeDir = join(dataDir, 'storage-v1'); }
  static async open(dataDir: string, origin: string): Promise<StorageVault> {
    const vault = new StorageVault(dataDir, origin);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const text = await vault.files.readText(join(dataDir, 'storage-vault.json'));
    if (text !== undefined) vault.manifest = manifestSchema.parse(JSON.parse(text));
    for (const name of ['storage-v1', 'storage-migration-backup']) {
      try {
        const info = await lstat(join(dataDir, name));
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid storage directory');
        if (text === undefined && (await readdir(join(dataDir, name))).length > 0) throw new Error('Encrypted data exists without its manifest; restore the manifest from backup');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return vault;
  }
  async hasLegacyData(): Promise<boolean> { return (await this.legacyPaths()).length > 0; }
  async hasCommittedLegacyData(): Promise<boolean> { return (await this.legacyPaths()).some((path) => !basename(path).startsWith('.')); }
  private async legacyPaths(): Promise<string[]> {
    const result: string[] = [];
    for (const name of await readdir(this.dataDir)) {
      if (/^state\.(snapshot\.json|journal\.jsonl)$/.test(name) || /^\.[a-f0-9-]+\.tmp$/.test(name)) result.push(name);
    }
    try {
      const directory = await lstat(join(this.dataDir, 'calls'));
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid legacy calls directory');
      for (const name of await readdir(join(this.dataDir, 'calls'))) {
        if (/^calls-\d{4}-\d{2}-\d{2}(\.index)?\.jsonl(\.gz)?$/.test(name) || /^\.[a-f0-9-]+\.(?:index|jsonl\.gz)\.tmp$/.test(name)) result.push(`calls/${name}`);
        else throw new Error('Unknown file in legacy calls directory; review before migrating');
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    for (const name of result) await exists(join(this.dataDir, name));
    return result.sort();
  }
  async initialize(key: Uint8Array, slot?: VaultSlot, recoveryWrap?: z.infer<typeof wrappingEnvelopeSchema>, vaultId: string = randomUUID()): Promise<void> {
    if (this.manifest !== undefined) throw new Error('Storage already initialized');
    const id = vaultId;
    const codec = new StorageCipher(key, id);
    try {
      const paths = await this.legacyPaths();
      if (paths.some((path) => path.startsWith('state.'))) {
        // Read without snapshot/close: validate the existing key before publishing a manifest or changing any legacy byte.
        const state = await createConfigStateStore(this.dataDir);
        const credentials = new CredentialVault(key);
        const push = new PushSecretVault(key);
        state.read((data) => {
          for (const [id, raw] of Object.entries(data.upstreams)) {
            const upstream = raw as { credentials?: EncryptedCredentialEnvelope };
            if (upstream.credentials !== undefined) credentials.decrypt(id as UpstreamId, upstream.credentials);
          }
          const vapid = data.settings['web-push-vapid'] as { privateKey?: Parameters<PushSecretVault['decrypt']>[1] } | undefined;
          if (vapid?.privateKey !== undefined) push.decrypt('vapid-private-key', vapid.privateKey);
          for (const [id, raw] of Object.entries(data.pushDevices)) {
            const device = raw as { subscription: Parameters<PushSecretVault['decrypt']>[1] };
            push.decrypt(`device:${id}:subscription`, device.subscription);
          }
        });
      }
      const legacy = await Promise.all(paths.map(async (path) => ({ path, sha256: digest(await readFile(join(this.dataDir, path))) })));
      await this.persist({ version: 1, id, origin: this.origin, phase: 'migrating', legacy, slots: slot === undefined ? [] : [slot], ...(recoveryWrap === undefined ? {} : { recoveryWrap }), check: codec.encode('key-check', 'approval-mcp-storage-v1'), authentication: '' }, key);
    } finally { codec.destroy(); }
  }
  verifyKey(key: Uint8Array): void {
    if (this.manifest === undefined) throw new Error('Storage is not initialized');
    const codec = new StorageCipher(key, this.manifest.id);
    try {
      if (codec.decode('key-check', this.manifest.check) !== 'approval-mcp-storage-v1') throw new Error('Invalid storage key');
      const { authentication, ...metadata } = this.manifest;
      if (codec.decode('manifest', authentication) !== JSON.stringify(metadata)) throw new Error('Storage metadata authentication failed');
    }
    finally { codec.destroy(); }
  }
  async unlock(key: Uint8Array): Promise<void> {
    this.verifyKey(key);
    const codec = new StorageCipher(key, this.manifest!.id);
    try { await this.migrate(codec, key); }
    catch (e) { codec.destroy(); throw e; }
    this.codec?.destroy(); this.key?.fill(0);
    this.codec = codec; this.key = Buffer.from(key);
  }
  private async migrate(codec: StorageCipher, key: Uint8Array): Promise<void> {
    const manifest = this.manifest!;
    if (manifest.phase === 'ready') return;
    await this.files.ensureDir(this.runtimeDir);
    await this.files.ensureDir(join(this.runtimeDir, 'calls'));
    const backup = join(this.dataDir, 'storage-migration-backup');
    await this.files.ensureDir(backup);
    for (const entry of manifest.legacy) {
      const archive = join(backup, entry.path.replaceAll('/', '__') + '.sealed');
      let raw: Buffer;
      const saved = await this.files.readText(archive);
      if (saved === undefined) {
        raw = await readFile(join(this.dataDir, entry.path));
        if (digest(raw) !== entry.sha256) throw new Error('Legacy storage changed during migration; stop other instances');
        await this.files.writeAtomic(archive, codec.encode(`backup/${entry.path}`, raw.toString('base64')));
      } else raw = Buffer.from(codec.decode(`backup/${entry.path}`, saved), 'base64');
      if (digest(raw) !== entry.sha256) throw new Error('Migration backup verification failed');
      // Old abandoned temporary files are archived, but never become active state.
      if (basename(entry.path).startsWith('.') || entry.path.endsWith('.index.jsonl')) continue;
      const context = entry.path.replace(/\.gz$/, '');
      const source = entry.path.endsWith('.gz') ? await gunzipAsync(raw) : raw;
      let text = source.toString('utf8');
      if (entry.path.startsWith('calls/') && text !== '' && !text.endsWith('\n')) {
        // Preserve the exact source in the archive. The legacy journal permits
        // dropping only a torn final JSON record; never append onto that fragment.
        const boundary = text.lastIndexOf('\n') + 1;
        try { JSON.parse(text.slice(boundary)); text += '\n'; }
        catch { text = text.slice(0, boundary); }
      }
      let encoded = encodeLines(codec, context, text);
      if (entry.path.endsWith('.gz')) encoded = (await gzipAsync(Buffer.from(encoded))).toString('base64');
      const target = join(this.runtimeDir, entry.path);
      if (entry.path.endsWith('.gz')) {
        // Atomic binary output through the same durable writer (base64 is only a temporary representation).
        const { open, rename } = await import('node:fs/promises');
        const temp = `${target}.${randomUUID()}.tmp`;
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(Buffer.from(encoded, 'base64')); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, target);
        const parent = await open(join(this.runtimeDir, 'calls'), 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      } else await this.files.writeAtomic(target, encoded);
    }
    // Ciphertext records have different byte offsets. Never reuse legacy offsets.
    for (const name of await readdir(join(this.runtimeDir, 'calls'))) {
      if (/^calls-\d{4}-\d{2}-\d{2}\.jsonl(?:\.gz)?$/.test(name)) await rebuildSegmentIndex(join(this.runtimeDir, 'calls', name), join(this.runtimeDir, 'calls', name.replace(/\.jsonl(?:\.gz)?$/, '.index.jsonl')), codec);
    }
    // Validate the staged stores before touching any legacy file.
    const state = await createConfigStateStore(this.runtimeDir, createNodeFileOperations(codec));
    await state.close();
    await createCallJournal(join(this.runtimeDir, 'calls'), undefined, codec);
    for (const entry of manifest.legacy) {
      const path = join(this.dataDir, entry.path);
      if (await exists(path)) {
        if (digest(await readFile(path)) !== entry.sha256) throw new Error('Legacy data changed; migration cleanup stopped');
        await rm(path);
      }
    }
    if (manifest.legacy.some((entry) => entry.path.startsWith('calls/'))) {
      const parent = await open(join(this.dataDir, 'calls'), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
    await this.persist({ ...manifest, phase: 'ready' }, key);
  }
  async addSlot(slot: VaultSlot, recoveryWrap: z.infer<typeof wrappingEnvelopeSchema> | undefined, key: Uint8Array): Promise<void> {
    this.verifyKey(key);
    if (this.key !== undefined && !timingSafeEqual(this.key, key)) throw new Error('Key mismatch');
    const manifest = this.manifest!;
    if (manifest.slots.length >= 20 || manifest.slots.some((v) => v.credential.id === slot.credential.id)) throw new Error('Duplicate passkey or slot limit');
    await this.persist({ ...manifest, slots: [...manifest.slots, slot], ...(recoveryWrap === undefined ? {} : { recoveryWrap }) }, key);
  }
  async updateCounter(slotId: string, counter: number, key: Uint8Array): Promise<void> {
    this.verifyKey(key);
    await this.persist({ ...this.manifest!, slots: this.manifest!.slots.map((slot) => slot.id === slotId ? { ...slot, credential: { ...slot.credential, counter } } : slot) }, key);
  }
  async removeSlot(id: string): Promise<void> {
    const manifest = this.manifest!;
    if (manifest.slots.length <= 1) throw new Error('Keep at least one storage passkey');
    await this.persist({ ...manifest, slots: manifest.slots.filter((slot) => slot.id !== id) });
  }
  private async persist(manifest: Manifest, key: Uint8Array | undefined = this.key): Promise<void> {
    if (key === undefined) throw new Error('Storage key required to update metadata');
    const parsed = manifestSchema.parse(manifest);
    const { authentication: _old, ...metadata } = parsed;
    const codec = new StorageCipher(key, parsed.id);
    try {
      const next = { ...metadata, authentication: codec.encode('manifest', JSON.stringify(metadata)) };
      await this.files.writeAtomic(join(this.dataDir, 'storage-vault.json'), JSON.stringify(next));
      this.manifest = manifestSchema.parse(next);
    } finally { codec.destroy(); }
  }
  destroy(): void { this.key?.fill(0); this.key = undefined; this.codec?.destroy(); this.codec = undefined; }
}
