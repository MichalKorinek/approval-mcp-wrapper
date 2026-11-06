import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { JsonValue, Upstream } from '@approval-mcp/contracts';
import { PluginRegistry, type ApprovalPlugin } from '@approval-mcp/plugin-sdk';
import type { ConfigStateStore } from '@approval-mcp/state-store';
import { LEGACY_PLUGIN_SOURCES } from './legacy-sources.js';
import {
  installationSchema, manifestSchema, parsePluginRepository, pluginRecordSchema, revisionSchema,
  type Installation, type Manifest, type PluginRecord, type PluginSource,
} from './plugin-source.js';

export interface PluginHost {
  findContact(upstreamId: string, source: 'whatsapp' | 'imcp', identifier: string): Promise<unknown>;
  findChat(upstreamId: string, identifier: string): Promise<unknown>;
  findMessage(upstreamId: string, identifier: string): Promise<unknown>;
  listWellnessServices(upstreamId: string): Promise<unknown>;
  findCalendarEvents(upstreamId: string, start: string, end: string): Promise<unknown>;
  readMessage(upstreamId: string, messageId: string): Promise<unknown>;
  readJson(upstreamId: string, uri: string): Promise<JsonValue | undefined>;
}

interface Release { revision: string; manifest: Manifest }
interface Preview { source: PluginSource; release: Release; owner: string; expiresAt: number }

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
  private readonly previews = new Map<string, Preview>();
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: {
    directory: string;
    state: ConfigStateStore;
    registry: PluginRegistry;
    host: PluginHost;
    fetch?: typeof fetch;
  }) {
    this.fetcher = options.fetch ?? fetch;
  }

  /** Load only verified local artifacts. No network requests on restart. */
  async restore(): Promise<void> {
    // Preserve old installations offline. Remove old empty auto-install entries.
    for (const [id, raw] of this.options.state.read((state) => Object.entries(state.plugins))) {
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && raw.schemaVersion === 2) continue;
      const source = LEGACY_PLUGIN_SOURCES.find((item) => item.id === id);
      if (source === undefined || typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`Unknown legacy plugin record: ${id}`);
      }
      const installations = installationSchema.array().parse(raw.installations);
      const used = this.options.state.read((state) => Object.values(state.upstreams).some((upstream) =>
        typeof upstream === 'object' && upstream !== null && !Array.isArray(upstream) && upstream.pluginId === id));
      if (installations.length === 0 && !used) {
        await this.options.state.mutate({ type: 'record.deleted', collection: 'plugins', id });
      } else {
        await this.save(id, pluginRecordSchema.parse({ ...source, schemaVersion: 2, enabled: raw.enabled, installations }));
      }
    }
    for (const record of this.records()) {
      const entry = record;
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

  /** Preview only downloads metadata. No plugin module is fetched or executed. */
  async preview(repositoryUrl: unknown, owner: string) {
    let repository: string;
    try { repository = parsePluginRepository(repositoryUrl); }
    catch { throw new PluginManagerError('plugin.invalid_repository'); }
    for (const [id, preview] of this.previews) if (preview.expiresAt <= Date.now()) this.previews.delete(id);
    if (this.previews.size >= 100) throw new PluginManagerError('plugin.too_many_previews', 429);
    const revision = await this.head(repository);
    const release = await this.release({ repository }, revision);
    const source = { id: release.manifest.id, name: release.manifest.name, repository, revision };
    this.validateSource(source, release);
    const previewId = randomUUID();
    const expiresAt = Date.now() + 5 * 60_000;
    this.previews.set(previewId, { owner, source, release, expiresAt });
    return { previewId, expiresAt: new Date(expiresAt).toISOString(), ...release.manifest,
      repository: `https://github.com/${repository}`, revision };
  }

  add(previewId: string, owner: string): Promise<void> {
    return this.enqueue(async () => {
      const preview = this.previews.get(previewId);
      if (preview === undefined || preview.owner !== owner || preview.expiresAt <= Date.now()) {
        throw new PluginManagerError('plugin.preview_expired', 409);
      }
      this.previews.delete(previewId);
      this.validateSource(preview.source, preview.release);
      await this.installRelease(preview.source, preview.release);
    });
  }

  list() {
    const upstreams = this.options.state.read((state) =>
      Object.values(state.upstreams) as unknown as Upstream[]);
    return this.records().map((record) => {
      const entry = record;
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
      const revision = await this.head(entry.repository);
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
      await this.options.state.mutate({ type: 'record.deleted', collection: 'plugins', id });
      for (const key of this.instances.keys()) if (key.startsWith(`${id}@`)) this.instances.delete(key);
      for (const key of this.verified) if (key.startsWith(`${id}@`)) this.verified.delete(key);
      this.refreshRegistry();
      // The ID is validated by the manifest schema, never an arbitrary path.
      await rm(join(this.options.directory, id), { recursive: true, force: true });
      this.available.delete(id);
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.queue;
  }

  private async installRelease(entry: PluginSource, release: Release): Promise<void> {
    const { manifest, revision } = release;
    this.validateSource(entry, release);
    const record = this.findRecord(entry.id) ?? { ...entry, schemaVersion: 2 as const, enabled: true, autoInstall: false as const, installations: [] };
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

  private async release(entry: Pick<PluginSource, 'repository'> & Partial<Pick<PluginSource, 'id'>>, revision: string): Promise<Release> {
    const manifest = manifestSchema.parse(JSON.parse(await this.download(this.rawUrl(entry, revision, 'plugin.json'), 16_000)));
    if ('id' in entry && manifest.id !== entry.id) throw new PluginManagerError('plugin.invalid_manifest');
    return { manifest, revision };
  }

  private rawUrl(entry: Pick<PluginSource, 'repository'>, revision: string, file: string) {
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

  private records(): PluginRecord[] {
    return this.options.state.read((state) => Object.entries(state.plugins).map(([id, raw]) => {
      const record = pluginRecordSchema.parse(raw);
      if (record.id !== id || record.installations.some((item) => item.id !== id)) throw new Error('Invalid plugin identity');
      return record;
    }));
  }

  private findRecord(id: string): PluginRecord | undefined {
    return this.records().find((record) => record.id === id);
  }

  private record(id: string): PluginRecord {
    const record = this.findRecord(id);
    if (record === undefined) throw new PluginManagerError('plugin.not_found', 404);
    return record;
  }

  private validateSource(source: PluginSource, release: Release) {
    const current = this.findRecord(source.id);
    if (current !== undefined && current.repository !== source.repository) throw new PluginManagerError('plugin.source_conflict', 409);
    const installed = current?.installations.find((item) => item.version === release.manifest.version);
    if (installed !== undefined && installed.sha256 !== release.manifest.sha256) throw new PluginManagerError('plugin.version_reused', 409);
    if (this.records().some((item) => item.repository === source.repository && item.id !== source.id)) {
      throw new PluginManagerError('plugin.source_conflict', 409);
    }
  }

  private async head(repository: string): Promise<string> {
    const metadata = JSON.parse(await this.download(`https://api.github.com/repos/${repository}`, 32_000)) as { default_branch?: unknown };
    if (typeof metadata.default_branch !== 'string' || metadata.default_branch.length === 0 || metadata.default_branch.length > 200) {
      throw new PluginManagerError('plugin.invalid_repository');
    }
    const reference = JSON.parse(await this.download(
      `https://api.github.com/repos/${repository}/git/ref/heads/${encodeURIComponent(metadata.default_branch)}`, 16_000,
    )) as { object?: { sha?: unknown } };
    return revisionSchema.parse(reference.object?.sha);
  }

  private save(id: string, record: PluginRecord) {
    return this.options.state.mutate({ type: 'record.upserted', collection: 'plugins', id, value: pluginRecordSchema.parse(record) as unknown as JsonValue });
  }

  private refreshRegistry() {
    this.options.registry.replace([...this.instances.values()].filter((plugin) => this.record(plugin.id).enabled));
  }

  private key(id: string, version: string) { return `${id}@${version}`; }
  private hash(source: string) { return createHash('sha256').update(source).digest('hex'); }

  private exclusive(id: string, operation: (entry: PluginRecord) => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      const entry = this.record(id);
      this.busy.add(id);
      try {
        await operation(entry);
        this.errors.delete(id);
      } catch (error) {
        this.errors.set(id, error instanceof PluginManagerError ? error.code : 'plugin.operation_failed');
        throw error;
      } finally { this.busy.delete(id); }
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.closing) return Promise.reject(new PluginManagerError('plugin.closing', 503));
    const queued = this.queue.then(operation);
    this.queue = queued.catch(() => undefined);
    return queued;
  }
}
