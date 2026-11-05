import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry } from '@approval-mcp/plugin-sdk';
import { createConfigStateStore } from '@approval-mcp/state-store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginManager, type PluginHost } from './plugin-manager.js';
import { registerPluginRoutes } from '../admin/plugin-routes.js';
import { registerSystemRoutes } from '../admin/system-routes.js';
import { buildServerApp } from '../app.js';
import { InMemoryRecoveryRepository, RecoveryService } from '../recovery-service.js';
import { InMemorySessionRepository, SessionService } from '../session-store.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'approval-plugin-test-'));
  directories.push(directory);
  const state = await createConfigStateStore(join(directory, 'data'));
  const registry = new PluginRegistry([]);
  const revision = 'a'.repeat(40);
  let currentRevision = revision;
  const releases = new Map<string, { manifest: object; code: string }>();
  const addRelease = (revision: string, version: string, codeOverride?: string) => {
    const code = codeOverride ?? `export function createPlugin() { return {id:'sample',version:'${version}',normalizationVersion:2,async describe(input) { return {source:'plugin',normalizedContext:{},sensitivePaths:[],title:{key:'sample',fallback:{en:'Readable approval'}},sections:[],proposedScopes:[]}; }}; }`;
    releases.set(revision, { code, manifest: {
      apiVersion: 1, id: 'sample', name: 'Sample', description: 'Sample presentation plugin',
      version, normalizationVersion: 2, entry: 'plugin.mjs',
      sha256: createHash('sha256').update(code).digest('hex'),
    } });
  };
  addRelease(revision, '1.0.0');
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const path = String(url);
    if (path.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: currentRevision } });
    const target = [...releases].find(([revision]) => path.includes(`/${revision}/`))?.[1];
    if (target === undefined) return new Response('', { status: 404 });
    return path.endsWith('plugin.json') ? Response.json(target.manifest) : new Response(target.code);
  });
  const create = () => new PluginManager({
    directory: join(directory, 'plugins'), state, registry, host: {} as PluginHost,
    catalog: [{ id: 'sample', name: 'Sample', repository: 'test/plugin-sample', revision }], fetch: fetcher,
  });
  const manager = create();
  await manager.restore();
  return { directory, state, registry, revision, fetcher, manager, create, addRelease,
    setHead: (revision: string) => { currentRevision = revision; }, releases };
}

describe('persistent plugin manager', () => {
  it('verifies disabled cached plugins without running their factory on restart', async () => {
    const { manager, create, addRelease, revision, registry } = await fixture();
    addRelease(revision, '1.0.0', `export function createPlugin() {
      globalThis.__approvalPluginFactoryCalls = (globalThis.__approvalPluginFactoryCalls ?? 0) + 1;
      return {id:'sample',version:'1.0.0',normalizationVersion:2,async describe() { return {}; }};
    }`);
    try {
      await manager.install('sample');
      expect(Reflect.get(globalThis, '__approvalPluginFactoryCalls')).toBe(1);
      await manager.setEnabled('sample', false);
      const restarted = create();
      await restarted.restore();
      expect(Reflect.get(globalThis, '__approvalPluginFactoryCalls')).toBe(1);
      expect(restarted.list()[0]).toMatchObject({ enabled: false, error: null, installed: [{ loaded: true }] });
      expect(registry.list()).toEqual([]);
      await restarted.setEnabled('sample', true);
      expect(Reflect.get(globalThis, '__approvalPluginFactoryCalls')).toBe(2);
      expect(registry.list()).toHaveLength(1);
    } finally { Reflect.deleteProperty(globalThis, '__approvalPluginFactoryCalls'); }
  });
  it('installs once, hot loads, and restarts entirely from the persistent cache', async () => {
    const { manager, create, fetcher, registry } = await fixture();
    expect(fetcher).not.toHaveBeenCalled();
    await manager.installDefaults();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(registry.list()).toEqual([{ id: 'sample', version: '1.0.0', normalizationVersion: 2 }]);
    const description = await registry.describe({ id: 'sample', version: '1.0.0' }, { upstreamId: 'u', upstreamAlias: 'test', toolName: 'test', arguments: {} });
    expect(description.source).toBe('plugin');
    fetcher.mockClear();
    await create().restore();
    await create().installDefaults();
    expect(fetcher).not.toHaveBeenCalled();
    await manager.setEnabled('sample', false);
    expect(registry.list()).toEqual([]);
    const restarted = create();
    await restarted.restore();
    expect(registry.list()).toEqual([]);
    await restarted.setEnabled('sample', true);
    expect(registry.list()).toHaveLength(1);
  });

  it('adds new versions alongside existing pins, without rewriting upstreams', async () => {
    const { manager, registry, state, addRelease, setHead, create } = await fixture();
    await manager.install('sample');
    await state.mutate({ type: 'record.upserted', collection: 'upstreams', id: 'u', value: { id: 'u', alias: 'sample', pluginId: 'sample', pluginVersion: '1.0.0' } });
    const revision = 'b'.repeat(40);
    addRelease(revision, '1.1.0');
    setHead(revision);
    await manager.checkUpdate('sample');
    expect(manager.list()[0]?.update).toEqual({ version: '1.1.0', revision });
    expect(registry.list()).toHaveLength(1);
    await manager.update('sample');
    expect(registry.list().map((item) => item.version)).toEqual(['1.0.0', '1.1.0']);
    expect(state.read((state) => state.upstreams.u)).toMatchObject({ pluginVersion: '1.0.0' });
    await create().restore();
    expect(registry.list()).toHaveLength(2);
    await expect(manager.remove('sample')).rejects.toMatchObject({ code: 'plugin.in_use', status: 409 });
    await state.mutate({ type: 'record.deleted', collection: 'upstreams', id: 'u' });
    await manager.remove('sample');
    const restarted = create();
    await restarted.restore();
    await restarted.installDefaults();
    expect(registry.list()).toEqual([]);
    expect(restarted.list()[0]?.installed).toEqual([]);
  });

  it('rejects tampered cache before execution and can repair it explicitly', async () => {
    const { manager, directory, revision, create, registry, fetcher } = await fixture();
    await manager.install('sample');
    const path = join(directory, 'plugins', 'sample', revision, 'plugin.mjs');
    const original = await readFile(path, 'utf8');
    await writeFile(path, "throw new Error('MUST NOT EXECUTE');");
    fetcher.mockClear();
    const restarted = create();
    await restarted.restore();
    expect(fetcher).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
    expect(restarted.list()[0]?.error).toBe('plugin.cache_invalid');
    await restarted.install('sample');
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(registry.list()).toHaveLength(1);
  });

  it('does not install code with a bad hash or accept reuse of an installed version', async () => {
    const { manager, fetcher, addRelease, setHead, registry, releases, revision } = await fixture();
    fetcher.mockImplementationOnce(async () => Response.json({ apiVersion: 99 }));
    await expect(manager.install('sample')).rejects.toThrow();
    expect(registry.list()).toEqual([]);
    const originalCode = releases.get(revision)!.code;
    releases.get(revision)!.code = 'throw new Error("Must not run before integrity verification");';
    await expect(manager.install('sample')).rejects.toMatchObject({ code: 'plugin.checksum_failed' });
    expect(registry.list()).toEqual([]);
    releases.get(revision)!.code = originalCode;
    await manager.install('sample');
    const nextRevision = 'c'.repeat(40);
    addRelease(nextRevision, '1.0.0', 'throw new Error("changed code");');
    setHead(nextRevision);
    await expect(manager.checkUpdate('sample')).rejects.toMatchObject({ code: 'plugin.version_reused' });
    await expect(manager.install('../../escape')).rejects.toMatchObject({ code: 'plugin.not_found' });
    expect(registry.list()).toHaveLength(1);
  });

  it('handles download failures without stopping the server or retrying installed plugins', async () => {
    const { manager, fetcher, registry } = await fixture();
    fetcher.mockRejectedValueOnce(new Error('offline'));
    await manager.installDefaults();
    expect(manager.list()[0]?.error).toBe('plugin.operation_failed');
    expect(registry.list()).toEqual([]);
    await manager.installDefaults();
    expect(registry.list()).toHaveLength(1);
    fetcher.mockClear();
    await manager.installDefaults();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('protects management routes with admin authentication and CSRF and lists plugins dynamically', async () => {
    const { manager, registry } = await fixture();
    const sessions = new SessionService(new InMemorySessionRepository());
    const session = await sessions.create('admin');
    const app = await buildServerApp({ auth: {
      sessions, secureCookies: false, recovery: new RecoveryService(new InMemoryRecoveryRepository()),
      passkeys: { bootstrapOptions: async () => ({}), verifyBootstrap: async () => ({ adminId: 'admin' }), loginOptions: async () => ({}), verifyLogin: async () => ({ adminId: 'admin' }) },
    } });
    try {
      await registerPluginRoutes(app, { sessions, pluginManager: manager });
      await registerSystemRoutes(app, { sessions, getPlugins: () => registry.list() });
      expect((await app.inject({ url: '/api/admin/plugins/catalog' })).statusCode).toBe(401);
      const headers = { cookie: `amcp_admin=${session.plaintext}`, 'x-csrf-token': session.csrfToken };
      expect((await app.inject({ method: 'POST', url: '/api/admin/plugins/sample/install', headers: { cookie: headers.cookie } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/admin/plugins/sample/install', headers })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/admin/plugins', headers })).json()).toHaveLength(1);
      expect((await app.inject({ method: 'POST', url: '/api/admin/plugins/sample/disable', headers })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/admin/plugins', headers })).json()).toEqual([]);
      expect((await app.inject({ method: 'POST', url: '/api/admin/plugins/unknown/install', headers })).statusCode).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: '/api/admin/plugins/sample', headers })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});
