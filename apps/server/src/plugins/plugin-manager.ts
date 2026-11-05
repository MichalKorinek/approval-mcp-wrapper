import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { JsonValue, Upstream } from '@approval-mcp/contracts';
import { PluginRegistry, type ApprovalPlugin } from '@approval-mcp/plugin-sdk';
import type { ConfigStateStore } from '@approval-mcp/state-store';
import { z } from 'zod';

import { PLUGIN_CATALOG, type PluginCatalogEntry } from './catalog.js';

export interface PluginHost {
  findContact(upstreamId: string, source: 'whatsapp' | 'imcp', identifier: string): Promise<unknown>;
  findChat(upstreamId: string, identifier: string): Promise<unknown>;
  findMessage(upstreamId: string, identifier: string): Promise<unknown>;
  listWellnessServices(upstreamId: string): Promise<unknown>;
  findCalendarEvents(upstreamId: string, start: string, end: string): Promise<unknown>;
  readMessage(upstreamId: string, messageId: string): Promise<unknown>;
  readJson(upstreamId: string, uri: string): Promise<JsonValue | undefined>;
}

const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const manifestSchema = z.object({
  apiVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().min(1).max(120),
  description: z.string().max(1000),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
  normalizationVersion: z.number().int().positive(),
  entry: z.literal('plugin.mjs'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const installationSchema = manifestSchema.extend({
  revision: revisionSchema,
  installedAt: z.iso.datetime(),
});
const recordSchema = z.object({
  enabled: z.boolean(),
  autoInstall: z.boolean(),
  installations: z.array(installationSchema).max(50),
});
type Manifest = z.infer<typeof manifestSchema>;
type Installation = z.infer<typeof installationSchema>;
type PluginRecord = z.infer<typeof recordSchema>;
interface Release { revision: string; manifest: Manifest }

export class PluginManagerError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

export class PluginManager {
  private readonly instances = new Map<string, ApprovalPlugin>();
  private readonly verified = new Set<string>();
  private readonly errors = new Map<string, string>();
  private readonly available = new Map<string, Release>();
  private readonly busy = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private readonly catalog: readonly PluginCatalogEntry[];
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: {
    directory: string;
    state: ConfigStateStore;
    registry: PluginRegistry;
    host: PluginHost;
    catalog?: readonly PluginCatalogEntry[];
    fetch?: typeof fetch;
  }) {
    this.catalog = options.catalog ?? PLUGIN_CATALOG;
    this.fetcher = options.fetch ?? fetch;
    for (const item of this.catalog) {
      manifestSchema.shape.id.parse(item.id);
      revisionSchema.parse(item.revision);
      if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(item.repository)) throw new Error('Invalid plugin repository');
    }
  }

  /** Load only verified local artifacts. No network requests on restart. */
  async restore(): Promise<void> {
    for (const entry of this.catalog) {
      const record = this.record(entry.id);
      if (this.options.state.read((state) => state.plugins[entry.id]) === undefined) {
        await this.save(entry.id, record);
      }
      for (const installed of record.installations) {
        try {
          if (record.enabled) {
            const plugin = await this.load(entry.id, installed);
            this.instances.set(this.key(entry.id, installed.version), plugin);
          } else {
            // Disabled code is integrity-checked but not executed on startup.
            await this.readVerified(entry.id, installed);
          }
          this.verified.add(this.key(entry.id, installed.version));
        } catch {
          this.errors.set(entry.id, 'plugin.cache_invalid');
        }
      }
    }
    this.refreshRegistry();
  }

  /** Fresh installations happen after HTTP starts; failures remain visible in UI. */
  async installDefaults(): Promise<void> {
    for (const entry of this.catalog) {
      if (this.closing) return;
      const record = this.record(entry.id);
      if (!record.autoInstall || record.installations.length > 0) continue;
      await this.exclusive(entry.id, async (entry) => {
        const latest = this.record(entry.id);
        if (this.closing || !latest.autoInstall || latest.installations.length > 0) return;
        await this.installRelease(entry, await this.release(entry, entry.revision));
      }).catch(() => undefined);
    }
  }

  list() {
    const upstreams = this.options.state.read((state) =>
      Object.values(state.upstreams) as unknown as Upstream[]);
    return this.catalog.map((entry) => {
      const record = this.record(entry.id);
      return {
        id: entry.id,
        name: entry.name,
        repository: `https://github.com/${entry.repository}`,
        enabled: record.enabled,
        busy: this.busy.has(entry.id),
        installed: record.installations.map((installed) => ({
          version: installed.version,
          normalizationVersion: installed.normalizationVersion,
          revision: installed.revision,
          installedAt: installed.installedAt,
          loaded: this.verified.has(this.key(entry.id, installed.version)),
        })),
        usedBy: upstreams.filter((upstream) => upstream.pluginId === entry.id)
          .map((upstream) => ({ id: upstream.id, name: upstream.displayName ?? upstream.alias, version: upstream.pluginVersion })),
        error: this.errors.get(entry.id) ?? null,
        update: this.available.get(entry.id) === undefined ? null : {
          version: this.available.get(entry.id)!.manifest.version,
          revision: this.available.get(entry.id)!.revision,
        },
      };
    });
  }

  install(id: string): Promise<void> {
    return this.exclusive(id, async (entry) => {
      // Retrying install repairs a missing/corrupt cache using its original SHA.
      const record = this.record(id);
      const targets = record.installations.length === 0
        ? [await this.release(entry, entry.revision)]
        : record.installations.map((installed) => ({ revision: installed.revision, manifest: installed }));
      for (const target of targets) await this.installRelease(entry, target);
    });
  }

  checkUpdate(id: string): Promise<void> {
    return this.exclusive(id, async (entry) => {
      const response = JSON.parse(await this.download(
        `https://api.github.com/repos/${entry.repository}/git/ref/heads/main`, 16_000,
      )) as { object?: { sha?: unknown } };
      const revision = revisionSchema.parse(response.object?.sha);
      const release = await this.release(entry, revision);
      const installed = this.record(id).installations.find((item) => item.version === release.manifest.version);
      if (installed !== undefined && installed.sha256 !== release.manifest.sha256) {
        throw new PluginManagerError('plugin.version_reused', 409);
      }
      if (installed === undefined) this.available.set(id, release);
      else this.available.delete(id);
    });
  }

  update(id: string): Promise<void> {
    return this.exclusive(id, async (entry) => {
      const release = this.available.get(id);
      if (release === undefined) throw new PluginManagerError('plugin.no_update', 409);
      await this.installRelease(entry, release);
      this.available.delete(id);
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.exclusive(id, async () => {
      if (enabled) {
        const loaded = await Promise.all(this.record(id).installations.map(async (installed) =>
          ({ key: this.key(id, installed.version), plugin: await this.load(id, installed) })));
        for (const { key, plugin } of loaded) {
          this.instances.set(key, plugin);
          this.verified.add(key);
        }
      }
      await this.save(id, { ...this.record(id), enabled });
      this.refreshRegistry();
    });
  }

  remove(id: string): Promise<void> {
    return this.exclusive(id, async () => {
      if (this.list().find((item) => item.id === id)!.usedBy.length > 0) {
        throw new PluginManagerError('plugin.in_use', 409);
      }
      await this.save(id, { enabled: false, autoInstall: false, installations: [] });
      for (const key of this.instances.keys()) if (key.startsWith(`${id}@`)) this.instances.delete(key);
      for (const key of this.verified) if (key.startsWith(`${id}@`)) this.verified.delete(key);
      this.refreshRegistry();
      // The ID is resolved against the fixed catalog, never an arbitrary path.
      await rm(join(this.options.directory, id), { recursive: true, force: true });
      this.available.delete(id);
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.queue;
  }

  private async installRelease(entry: PluginCatalogEntry, release: Release): Promise<void> {
    const { manifest, revision } = release;
    const record = this.record(entry.id);
    const existing = record.installations.find((item) => item.version === manifest.version);
    if (existing !== undefined && existing.sha256 !== manifest.sha256) {
      throw new PluginManagerError('plugin.version_reused', 409);
    }
    if (existing === undefined && record.installations.length >= 50) {
      throw new PluginManagerError('plugin.version_limit', 409);
    }
    const artifact = await this.download(this.rawUrl(entry, revision, 'dist/plugin.mjs'), 1_000_000);
    if (this.hash(artifact) !== manifest.sha256) throw new PluginManagerError('plugin.checksum_failed');
    const directory = join(this.options.directory, entry.id, revision);
    await mkdir(directory, { recursive: true });
    const temporaryPath = join(directory, `${randomUUID()}.tmp`);
    try {
      const file = await open(temporaryPath, 'wx', 0o600);
      try {
        await file.writeFile(artifact);
        await file.sync();
      } finally { await file.close(); }
      await rename(temporaryPath, join(directory, 'plugin.mjs'));
      const parent = await open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    } finally {
      await rm(temporaryPath, { force: true });
    }
    const installed: Installation = { ...manifest, revision, installedAt: new Date().toISOString() };
    const instance = await this.load(entry.id, installed);
    await this.save(entry.id, {
      ...record,
      enabled: record.installations.length === 0 ? true : record.enabled,
      installations: [...record.installations.filter((item) => item.version !== installed.version), installed],
    });
    this.instances.set(this.key(entry.id, installed.version), instance);
    this.verified.add(this.key(entry.id, installed.version));
    this.refreshRegistry();
  }

  private async readVerified(id: string, installed: Installation): Promise<string> {
    const path = join(this.options.directory, id, installed.revision, 'plugin.mjs');
    const source = await readFile(path, 'utf8');
    if (this.hash(source) !== installed.sha256) throw new PluginManagerError('plugin.checksum_failed');
    return path;
  }

  private async load(id: string, installed: Installation): Promise<ApprovalPlugin> {
    const path = await this.readVerified(id, installed);
    const module = await import(pathToFileURL(path).href) as {
      createPlugin?: (host: PluginHost) => ApprovalPlugin;
    };
    if (typeof module.createPlugin !== 'function') throw new PluginManagerError('plugin.invalid_factory');
    const plugin = module.createPlugin(Object.freeze({ ...this.options.host }));
    if (plugin.id !== id || plugin.version !== installed.version ||
      plugin.normalizationVersion !== installed.normalizationVersion || typeof plugin.describe !== 'function') {
      throw new PluginManagerError('plugin.invalid_contract');
    }
    return plugin;
  }

  private async release(entry: PluginCatalogEntry, revision: string): Promise<Release> {
    const manifest = manifestSchema.parse(JSON.parse(await this.download(this.rawUrl(entry, revision, 'plugin.json'), 16_000)));
    if (manifest.id !== entry.id) throw new PluginManagerError('plugin.invalid_manifest');
    return { manifest, revision };
  }

  private rawUrl(entry: PluginCatalogEntry, revision: string, file: string) {
    return `https://raw.githubusercontent.com/${entry.repository}/${revision}/${file}`;
  }

  private async download(url: string, limit: number): Promise<string> {
    const response = await this.fetcher(url, {
      redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json, text/plain', 'user-agent': 'approval-mcp-plugin-manager' },
    });
    if (!response.ok || response.body === null) throw new PluginManagerError('plugin.download_failed', 502);
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) throw new PluginManagerError('plugin.download_too_large', 502);
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks).toString('utf8');
  }

  private record(id: string): PluginRecord {
    const raw = this.options.state.read((state) => state.plugins[id]);
    return raw === undefined ? { enabled: true, autoInstall: true, installations: [] } : recordSchema.parse(raw);
  }

  private save(id: string, record: PluginRecord) {
    return this.options.state.mutate({ type: 'record.upserted', collection: 'plugins', id, value: record as unknown as JsonValue });
  }

  private refreshRegistry() {
    this.options.registry.replace([...this.instances.values()].filter((plugin) => this.record(plugin.id).enabled));
  }

  private key(id: string, version: string) { return `${id}@${version}`; }
  private hash(source: string) { return createHash('sha256').update(source).digest('hex'); }

  private exclusive(id: string, operation: (entry: PluginCatalogEntry) => Promise<void>): Promise<void> {
    const entry = this.catalog.find((item) => item.id === id);
    if (entry === undefined) return Promise.reject(new PluginManagerError('plugin.not_found', 404));
    const queued = this.queue.then(async () => {
      this.busy.add(id);
      try {
        await operation(entry);
        this.errors.delete(id);
      } catch (error) {
        this.errors.set(id, error instanceof PluginManagerError ? error.code : 'plugin.operation_failed');
        throw error;
      } finally { this.busy.delete(id); }
    });
    this.queue = queued.catch(() => undefined);
    return queued;
  }
}
