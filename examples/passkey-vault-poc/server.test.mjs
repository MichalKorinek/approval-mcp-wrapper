import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPoc } from './server.mjs';
import { encryptSample, randomKey, toBase64, wrapKey } from './crypto.mjs';

test('cold start is locked; only correct recovery and session can read the sample; restart relocks', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'approval-prf-http-'));
  let app;
  try {
    app = await startPoc({ dataDir, port: 0 });
    const origin = app.origin;
    const port = Number(new URL(origin).port);
    const file = app.file;
    await app.close(); app = undefined;
    const id = crypto.randomUUID();
    const key = randomKey();
    const recovery = randomKey();
    const sample = { message: 'Synthetic data — no Approval MCP secrets.', createdAt: new Date().toISOString() };
    await mkdir(dataDir, { recursive: true });
    await writeFile(file, JSON.stringify({ schemaVersion: 1, id, rpId: 'localhost', origin,
      salt: toBase64(randomKey()), credential: { id: toBase64(randomKey()), publicKey: toBase64(randomKey()), counter: 0 },
      passkeyWrap: await wrapKey(key, randomKey(), id, 'passkey'), recoveryWrap: await wrapKey(key, recovery, id, 'recovery'),
      payload: await encryptSample(key, id, sample),
    }));
    app = await startPoc({ dataDir, port, publicUrl: origin });
    const response = await fetch(`${origin}/api/status`);
    const status = await response.json();
    assert.equal(status.locked, true);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const headers = { cookie, origin, 'content-type': 'application/json', 'x-poc-csrf': status.csrf };
    assert.equal((await fetch(`${origin}/api/sample`, { headers: { cookie } })).status, 423);
    const post = (path, body, customHeaders = headers) => fetch(`${origin}${path}`, { method: 'POST', headers: customHeaders, body: JSON.stringify(body) });
    assert.equal((await post('/api/recover', { key: toBase64(key) }, { ...headers, origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('/api/recover', { key: toBase64(randomKey()) })).status, 400);
    assert.equal((await post('/api/recover', { key: toBase64(key) })).status, 200);
    assert.deepEqual(await (await fetch(`${origin}/api/sample`, { headers: { cookie } })).json(), sample);
    assert.equal((await fetch(`${origin}/api/sample`)).status, 423, 'Other sessions cannot use the unlocked key');
    const disk = await readFile(file, 'utf8');
    assert.equal(disk.includes(toBase64(key)), false);
    assert.equal(disk.includes(toBase64(recovery)), false);
    assert.equal(disk.includes(sample.message), false);
    await app.close(); app = undefined;
    app = await startPoc({ dataDir, port, publicUrl: origin });
    assert.equal((await (await fetch(`${origin}/api/status`)).json()).locked, true);
    assert.equal((await fetch(`${origin}/api/sample`, { headers: { cookie } })).status, 423);
  } finally { await app?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('invalid existing PoC files fail closed without being overwritten', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'approval-prf-invalid-'));
  try {
    const file = join(dataDir, 'poc-vault.json');
    const existing = '{"production":"DO NOT OVERWRITE"}';
    await writeFile(file, existing);
    await assert.rejects(startPoc({ dataDir, port: 0 }), /not been overwritten/);
    assert.equal(await readFile(file, 'utf8'), existing);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
