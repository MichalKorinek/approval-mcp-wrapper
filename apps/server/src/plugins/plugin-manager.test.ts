import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import type { JsonValue } from '@approval-mcp/contracts';

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
    if (path === 'https://api.github.com/repos/test/plugin-sample') return Response.json({ default_branch: 'main' });
    if (path.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: currentRevision } });
    const target = [...releases].find(([revision]) => path.includes(`/${revision}/`))?.[1];
    if (target === undefined) return new Response('', { status: 404 });
    return path.endsWith('plugin.json') ? Response.json(target.manifest) : new Response(target.code);
  });
  const create = () => new PluginManager({
    directory: join(directory, 'plugins'), state, registry, host: {} as PluginHost,
    fetch: fetcher,
  });
  const manager = create();
  await manager.restore();
  const install = async () => {
    const preview = await manager.preview('https://github.com/test/plugin-sample', 'test-owner');
    await manager.add(preview.previewId, 'test-owner');
  };
  return { directory, state, registry, revision, fetcher, manager, create, addRelease,
    setHead: (revision: string) => { currentRevision = revision; }, releases, install };
}

describe('persistent plugin manager', () => {
  it('previews metadata only, binds confirmation to its session, and installs the exact reviewed commit', async () => {
    const { manager, fetcher, registry, addRelease, setHead } = await fixture();
    const preview = await manager.preview('https://github.com/test/plugin-sample', 'owner');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('dist/plugin.mjs'))).toBe(false);
    expect(registry.list()).toEqual([]);
    await expect(manager.add(preview.previewId, 'different-owner')).rejects.toMatchObject({ code: 'plugin.preview_expired' });
    const newer = 'f'.repeat(40);
    addRelease(newer, '9.0.0');
    setHead(newer);
    await manager.add(preview.previewId, 'owner');
    expect(registry.list()[0]?.version).toBe('1.0.0');
    await expect(manager.add(preview.previewId, 'owner')).rejects.toMatchObject({ code: 'plugin.preview_expired' });
  });

  it('rejects expired previews without executing code', async () => {
    const { manager, registry } = await fixture();
    const preview = await manager.preview('https://github.com/test/plugin-sample', 'owner');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date(preview.expiresAt).getTime() + 1);
    try { await expect(manager.add(preview.previewId, 'owner')).rejects.toMatchObject({ code: 'plugin.preview_expired' }); }
    finally { clock.mockRestore(); }
    expect(registry.list()).toEqual([]);
  });

  it('does not let a second repository claim an already installed plugin ID', async () => {
    const { manager, fetcher, install, registry } = await fixture();
    await install();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url) => String(url) === 'https://api.github.com/repos/evil/plugin-sample'
      ? Response.json({ default_branch: 'main' }) : original(url));
    await expect(manager.preview('https://github.com/evil/plugin-sample', 'owner')).rejects.toMatchObject({ code: 'plugin.source_conflict' });
    expect(manager.list()[0]?.repository).toBe('https://github.com/test/plugin-sample');
    expect(registry.list()).toHaveLength(1);
  });

  it('migrates installed legacy plugins offline, preserving pins and deleting empty old catalog entries', async () => {
    const { directory, state, registry, create, fetcher, revision, releases } = await fixture();
    const original = releases.get(revision)!;
    const code = original.code.replace("id:'sample'", "id:'email'");
    const installation = { ...original.manifest, id: 'email', sha256: createHash('sha256').update(code).digest('hex'), revision, installedAt: new Date().toISOString() };
    await mkdir(join(directory, 'plugins', 'email', revision), { recursive: true });
    await writeFile(join(directory, 'plugins', 'email', revision, 'plugin.mjs'), code);
    await state.mutate({ type: 'record.upserted', collection: 'plugins', id: 'email', value: { enabled: true, autoInstall: true, installations: [installation] } as JsonValue });
    await state.mutate({ type: 'record.upserted', collection: 'plugins', id: 'geo', value: { enabled: true, autoInstall: true, installations: [] } });
    await state.mutate({ type: 'record.upserted', collection: 'upstreams', id: 'mail', value: { id: 'mail', alias: 'work', pluginId: 'email', pluginVersion: '1.0.0' } });
    const restarted = create();
    await restarted.restore();
    expect(fetcher).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([{ id: 'email', version: '1.0.0', normalizationVersion: 2 }]);
    expect(restarted.list()).toHaveLength(1);
    expect(restarted.list()[0]?.repository).toBe('https://github.com/jiridudekusy/approval-mcp-plugin-your-mail-mcp');
    expect(state.read((state) => state.upstreams.mail)).toMatchObject({ pluginVersion: '1.0.0' });
  });
  it('verifies disabled cached plugins without running their factory on restart', async () => {
    const { manager, create, addRelease, revision, registry, install } = await fixture();
    addRelease(revision, '1.0.0', `export function createPlugin() {
      globalThis.__approvalPluginFactoryCalls = (globalThis.__approvalPluginFactoryCalls ?? 0) + 1;
      return {id:'sample',version:'1.0.0',normalizationVersion:2,async describe() { return {}; }};
    }`);
    try {
      await install();
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
    const { manager, create, fetcher, registry, install } = await fixture();
    expect(fetcher).not.toHaveBeenCalled();
    expect(manager.list()).toEqual([]);
    await install();
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(registry.list()).toEqual([{ id: 'sample', version: '1.0.0', normalizationVersion: 2 }]);
    const description = await registry.describe({ id: 'sample', version: '1.0.0' }, { upstreamId: 'u', upstreamAlias: 'test', toolName: 'test', arguments: {} });
    expect(description.source).toBe('plugin');
    fetcher.mockClear();
    await create().restore();
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
    const { manager, registry, state, addRelease, setHead, create, install } = await fixture();
    await install();
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
    expect(registry.list()).toEqual([]);
    expect(restarted.list()).toEqual([]);
  });

  it('rejects tampered cache before execution and can repair it explicitly', async () => {
    const { manager, directory, revision, create, registry, fetcher, install } = await fixture();
    await install();
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
    const { manager, fetcher, addRelease, setHead, registry, releases, revision, install } = await fixture();
    fetcher.mockImplementationOnce(async () => Response.json({ apiVersion: 99 }));
    await expect(install()).rejects.toThrow();
    expect(registry.list()).toEqual([]);
    const originalCode = releases.get(revision)!.code;
    releases.get(revision)!.code = 'throw new Error("Must not run before integrity verification");';
    await expect(install()).rejects.toMatchObject({ code: 'plugin.checksum_failed' });
    expect(registry.list()).toEqual([]);
    releases.get(revision)!.code = originalCode;
    await install();
    const nextRevision = 'c'.repeat(40);
    addRelease(nextRevision, '1.0.0', 'throw new Error("changed code");');
    setHead(nextRevision);
    await expect(manager.checkUpdate('sample')).rejects.toMatchObject({ code: 'plugin.version_reused' });
    await expect(manager.install('../../escape')).rejects.toMatchObject({ code: 'plugin.not_found' });
    expect(registry.list()).toHaveLength(1);
  });

  it('handles download failures without stopping the server or retrying installed plugins', async () => {
    const { manager, fetcher, registry, install } = await fixture();
    fetcher.mockRejectedValueOnce(new Error('offline'));
    await expect(install()).rejects.toThrow('offline');
    expect(manager.list()).toEqual([]);
    expect(registry.list()).toEqual([]);
    await install();
    expect(registry.list()).toHaveLength(1);
    fetcher.mockClear();
    // Merely listing/restoring never checks for or installs anything.
    manager.list();
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
      expect((await app.inject({ method: 'POST', url: '/api/admin/plugins/preview', headers: { cookie: headers.cookie }, payload: { repository: 'https://github.com/test/plugin-sample' } })).statusCode).toBe(403);
      const preview = await app.inject({ method: 'POST', url: '/api/admin/plugins/preview', headers, payload: { repository: 'https://github.com/test/plugin-sample' } });
      expect(preview.statusCode).toBe(200);
      expect(registry.list()).toEqual([]);
      expect((await app.inject({ method: 'POST', url: '/api/admin/plugins/sources', headers, payload: { previewId: preview.json().previewId, trustCode: false } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/admin/plugins/sources', headers, payload: { previewId: preview.json().previewId, trustCode: true } })).statusCode).toBe(201);
      expect((await app.inject({ url: '/api/admin/plugins', headers })).json()).toHaveLength(1);
      expect((await app.inject({ method: 'POST', url: '/api/admin/plugins/sample/disable', headers })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/admin/plugins', headers })).json()).toEqual([]);
      expect((await app.inject({ method: 'POST', url: '/api/admin/plugins/unknown/install', headers })).statusCode).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: '/api/admin/plugins/sample', headers })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});
