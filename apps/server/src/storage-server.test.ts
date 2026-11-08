import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { createConfigStateStore } from '@approval-mcp/state-store';
import { loadConfig } from './config.js';
import { buildStorageServer } from './storage-server.js';
import { StorageVault } from './storage-vault.js';

const directory = () => mkdtemp(join(tmpdir(), 'approval-storage-http-'));
const configFor = (dataDir: string, key?: Buffer) => loadConfig({ APPROVAL_MCP_PUBLIC_URL: 'http://localhost:43127', APPROVAL_MCP_DATA_DIR: dataDir, ...(key === undefined ? {} : { APPROVAL_MCP_MASTER_KEY: key.toString('base64') }) });
const headers = { host: 'localhost:43127' };
const webRoot = fileURLToPath(new URL('./fixtures/storage-web', import.meta.url));

describe('storage startup boundary', () => {
  it('uses the existing environment key, migrates data and dispatches normal auth routes', async () => {
    const dir = await directory(); const key = randomBytes(32);
    const old = await createConfigStateStore(dir);
    await old.mutate({ type: 'record.upserted', collection: 'settings', id: 'fixture', value: 'private fixture' }); await old.close();
    const app = await buildStorageServer(configFor(dir, key));
    try {
      expect((await app.inject({ url: '/api/storage/status', headers })).json()).toMatchObject({ locked: false, initialized: true, environmentUnlock: true });
      expect((await app.inject({ url: '/health/ready', headers })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/auth/session', headers })).statusCode).toBe(401);
      expect((await app.inject({ url: '/api/admin/system', headers })).statusCode).toBe(401);
      expect(await readFile(join(dir, 'storage-v1/state.snapshot.json'), 'utf8')).not.toContain('private fixture');
    } finally { await app.close(); }
    await expect(buildStorageServer(configFor(dir, randomBytes(32)))).rejects.toThrow();
    const restarted = await buildStorageServer(configFor(dir, key));
    expect((await restarted.inject({ url: '/api/storage/status', headers })).json().locked).toBe(false);
    await restarted.close();
  });

  it('starts locked without environment key, blocks MCP/API and only correct recovery starts runtime', async () => {
    const dir = await directory(); const key = randomBytes(32);
    const vault = await StorageVault.open(dir, 'http://localhost:43127');
    const wrap = { nonce: randomBytes(12).toString('base64url'), ciphertext: randomBytes(48).toString('base64url') };
    await vault.initialize(key, { id: randomUUID(), name: 'Mac', salt: randomBytes(32).toString('base64url'), credential: { id: 'fixture', publicKey: 'fixture', counter: 0 }, wrap, createdAt: new Date().toISOString() }, wrap);
    await vault.unlock(key); vault.destroy();
    const app = await buildStorageServer(configFor(dir), { webRoot });
    try {
      const statusResponse = await app.inject({ url: '/api/storage/status', headers });
      const status = statusResponse.json();
      const cookie = statusResponse.cookies.map((v) => `${v.name}=${v.value}`).join('; ');
      const post = (path: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/storage/${path}`, headers: { ...headers, cookie, origin: 'http://localhost:43127', 'x-storage-csrf': status.csrf }, payload });
      expect(status).toMatchObject({ locked: true, environmentUnlock: false });
      expect((await app.inject({ url: '/health/ready', headers })).statusCode).toBe(503);
      expect((await app.inject({ url: '/mcp', headers })).statusCode).toBe(503);
      expect((await app.inject({ url: '/api/auth/session', headers })).statusCode).toBe(423);
      const page = await app.inject({ url: '/', headers });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.body).toContain('Storage UI fixture');
      expect((await post('recover', { key: randomBytes(32).toString('base64url') })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/storage/recover', headers, payload: { key: key.toString('base64url') } })).statusCode).toBe(403);
      expect((await post('enroll/options', { name: 'attacker' })).statusCode).toBe(400);
      expect((await post('recover', { key: key.toString('base64url') })).statusCode).toBe(200);
      expect((await app.inject({ url: '/health/ready', headers })).statusCode).toBe(200);
    } finally { await app.close(); }
    const cold = await buildStorageServer(configFor(dir));
    expect((await cold.inject({ url: '/api/storage/status', headers })).json().locked).toBe(true); await cold.close();
  });

  it('requires the original environment key for legacy data, and a setup code for fresh installs', async () => {
    const dir = await directory(); const old = await createConfigStateStore(dir); await old.close();
    const app = await buildStorageServer(configFor(dir));
    expect((await app.inject({ url: '/api/storage/status', headers })).json().legacyKeyRequired).toBe(true); await app.close();
    const fresh = await buildStorageServer(configFor(await directory()), { setupToken: 'fixture-setup' });
    try {
      const result = await fresh.inject({ url: '/api/storage/status', headers });
      const cookie = result.cookies.map((v) => `${v.name}=${v.value}`).join('; ');
      const base = { method: 'POST' as const, url: '/api/storage/enroll/options', headers: { ...headers, cookie, origin: 'http://localhost:43127', 'x-storage-csrf': result.json().csrf } };
      expect((await fresh.inject({ ...base, payload: { name: 'Mac', setupToken: 'wrong' } })).statusCode).toBe(400);
      expect((await fresh.inject({ ...base, payload: { name: 'Mac', setupToken: 'fixture-setup' } })).json().extensions).toEqual({ prf: {} });
      expect((await fresh.inject({ url: '/api/storage/status', headers: { host: 'attacker.example' } })).statusCode).toBe(400);
    } finally { await fresh.close(); }
  });
});
