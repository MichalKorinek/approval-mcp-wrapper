import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';
import { createConfigStateStore } from '@approval-mcp/state-store';
import { loadConfig } from '../apps/server/dist/config.js';
import { buildStorageServer } from '../apps/server/dist/storage-server.js';
import { buildRuntime } from '../apps/server/dist/runtime.js';

const directory = await mkdtemp(join(tmpdir(), 'approval-storage-browser-'));
let app; let browser;
const errors = [];
const socket = createServer();
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const origin = `http://localhost:${port}`;
const key = randomBytes(32);
const config = (envKey = false) => loadConfig({ APPROVAL_MCP_PUBLIC_URL: origin, APPROVAL_MCP_DATA_DIR: directory, ...(envKey ? { APPROVAL_MCP_MASTER_KEY: key.toString('base64') } : {}) });
let administrator;
const createRuntime = async (...args) => {
  const runtime = await buildRuntime(...args);
  administrator = await runtime.sessions.create('admin');
  return runtime;
};
let notifications = 0;
const notifyLocked = async () => { notifications++; return { accepted: 1, failed: 0 }; };
async function start(envKey = false) {
  app = await buildStorageServer(config(envKey), { createRuntime, notifyLocked });
  await app.listen({ host: '127.0.0.1', port });
}
async function diskText(root = directory) {
  const values = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    values.push(entry.isDirectory() ? await diskText(path) : await readFile(path, 'utf8'));
  }
  return values.join('\n');
}
try {
  const old = await createConfigStateStore(directory);
  await old.mutate({ type: 'record.upserted', collection: 'settings', id: 'migration-fixture', value: 'legacy-sensitive-fixture' });
  await old.close();
  await start(true);
  browser = await chromium.launch({ headless: true, ...(process.env.DEMO_CHROMIUM_EXECUTABLE ? { executablePath: process.env.DEMO_CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'amcp_admin', value: administrator.plaintext, url: origin, httpOnly: true, sameSite: 'Strict' }, { name: 'amcp_csrf', value: administrator.csrfToken, url: origin, sameSite: 'Strict' }]);
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  const bodies = [];
  page.on('console', (message) => { if (message.type() === 'error') console.warn('Browser console:', message.text()); });
  await page.addInitScript(() => {
    const original = navigator.credentials.create.bind(navigator.credentials);
    navigator.credentials.create = async (...args) => { try { return await original(...args); } catch (error) { console.error('Native passkey creation:', error.name, error.message); throw error; } };
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.status() >= 400 && response.url().includes('/api/storage/')) console.warn('Storage test HTTP', response.status(), new URL(response.url()).pathname); });
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().includes('/api/storage/')) bodies.push(request.postDataJSON()); });
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  await page.goto(origin + '/system');
  await page.getByRole('heading', { name: 'Encrypted storage', exact: true }).waitFor();
  await page.getByLabel('Passkey name', { exact: true }).fill('Mac fixture');
  await page.getByRole('button', { name: 'Register storage passkey', exact: true }).click();
  await page.getByRole('button', { name: 'Finish encrypted setup', exact: true }).click();
  await page.getByRole('heading', { name: 'Save your storage recovery key', exact: true }).waitFor();
  const recovery = await page.getByLabel('Storage recovery key', { exact: true }).inputValue();
  assert.equal(recovery.length, 43);
  await page.getByRole('button', { name: 'I saved it — hide the key', exact: true }).click();
  // A second provider/device, not a duplicate credential on the same authenticator.
  const secondaryContext = await browser.newContext();
  await secondaryContext.addCookies(await context.cookies());
  const secondaryPage = await secondaryContext.newPage(); secondaryPage.setDefaultTimeout(15_000);
  secondaryPage.on('pageerror', (error) => errors.push(error.message));
  const secondaryCdp = await secondaryContext.newCDPSession(secondaryPage);
  await secondaryCdp.send('WebAuthn.enable');
  await secondaryCdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  await secondaryPage.goto(origin + '/system');
  await secondaryPage.getByLabel('Passkey name', { exact: true }).fill('Backup passkey fixture');
  await secondaryPage.getByRole('button', { name: 'Register storage passkey', exact: true }).click();
  await secondaryPage.getByRole('button', { name: 'Finish encrypted setup', exact: true }).click();
  await secondaryPage.locator('.storage-slot').filter({ hasText: 'Backup passkey fixture' }).waitFor();
  const manifest = JSON.parse(await readFile(join(directory, 'storage-vault.json'), 'utf8'));
  assert.equal(manifest.slots.length, 2);
  const text = await diskText();
  for (const secret of [key.toString('base64'), key.toString('base64url'), recovery, 'legacy-sensitive-fixture']) assert.equal(text.includes(secret), false);
  for (const body of bodies) {
    assert.equal(JSON.stringify(body).includes(recovery), false);
    if (body.authentication) assert.deepEqual(body.authentication.clientExtensionResults, {});
  }
  await mkdir('artifacts/storage-vault', { recursive: true });
  await page.screenshot({ path: 'artifacts/storage-vault/settings.png', fullPage: true });
  await app.close(); app = undefined;
  await start(false);
  await page.reload();
  await page.getByRole('heading', { name: 'Unlock Approval MCP', exact: true }).waitFor();
  assert.equal(notifications, 1);
  await page.screenshot({ path: 'artifacts/storage-vault/unlock.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Light theme', exact: true }).click();
  await page.getByRole('button', { name: 'CZ', exact: true }).click();
  await page.getByRole('heading', { name: 'Odemknout Approval MCP', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/storage-vault/unlock-mobile-dark-cs.png', fullPage: true });
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  assert.equal((await fetch(origin + '/health/ready')).status, 503);
  assert.equal((await fetch(origin + '/mcp')).status, 503);
  await page.getByRole('button', { name: 'Unlock storage', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Encrypted storage', exact: true }).waitFor();
  assert.equal((await fetch(origin + '/health/ready')).status, 200);
  // Both registered slots survive a restart; exercise the second credential too.
  await app.close(); app = undefined; await start(false); await page.reload();
  await secondaryPage.reload();
  await secondaryPage.getByRole('combobox').selectOption({ label: 'Backup passkey fixture' });
  await secondaryPage.getByRole('button', { name: 'Unlock storage', exact: true }).first().click();
  await secondaryPage.getByRole('heading', { name: 'Encrypted storage', exact: true }).waitFor();
  await app.close(); app = undefined; await start(false); await page.reload();
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  await page.getByText('Use the storage recovery key', { exact: true }).click();
  await page.getByLabel('Storage recovery key', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: 'Unlock storage', exact: true }).last().click();
  await page.getByRole('alert').waitFor();
  assert.equal((await fetch(origin + '/health/ready')).status, 503);
  await page.getByLabel('Storage recovery key', { exact: true }).fill(recovery);
  await page.getByRole('button', { name: 'Unlock storage', exact: true }).last().click();
  await page.getByRole('heading', { name: 'Encrypted storage', exact: true }).waitFor();
  assert.equal((await fetch(origin + '/health/ready')).status, 200);
  // A genuinely fresh install has no environment key: setup code + PRF establish the vault and first administrator.
  await app.close(); app = undefined;
  const freshConfig = loadConfig({ APPROVAL_MCP_PUBLIC_URL: origin, APPROVAL_MCP_DATA_DIR: join(directory, 'fresh'), APPROVAL_MCP_UNLOCK_NOTIFICATIONS: 'false' });
  app = await buildStorageServer(freshConfig, { setupToken: 'fixture-initial-code' });
  await app.listen({ host: '127.0.0.1', port });
  const freshContext = await browser.newContext(); const freshPage = await freshContext.newPage(); freshPage.setDefaultTimeout(15_000);
  const freshCdp = await freshContext.newCDPSession(freshPage); await freshCdp.send('WebAuthn.enable');
  await freshCdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  await freshPage.goto(origin);
  await freshPage.getByLabel('Initial setup code from server logs', { exact: true }).fill('fixture-initial-code');
  await freshPage.getByLabel('Passkey name', { exact: true }).fill('Fresh storage fixture');
  await freshPage.getByRole('button', { name: 'Register storage passkey', exact: true }).click();
  await freshPage.getByRole('button', { name: 'Finish encrypted setup', exact: true }).click();
  await freshPage.getByRole('heading', { name: 'Save your storage recovery key', exact: true }).waitFor();
  assert.equal((await freshPage.getByLabel('Storage recovery key', { exact: true }).inputValue()).length, 43);
  await freshPage.getByRole('button', { name: 'I saved it — hide the key', exact: true }).click();
  await freshPage.getByRole('button', { name: 'Continue with passkey', exact: true }).click();
  await freshPage.getByRole('heading', { name: 'Approval inbox', exact: true }).waitFor();
  // The live inbox owns SSE connections; shutdown must not wait forever for them.
  await app.close(); app = undefined;
  await freshContext.close();
  const unsupportedDir = join(directory, 'unsupported');
  app = await buildStorageServer(loadConfig({ APPROVAL_MCP_PUBLIC_URL: origin, APPROVAL_MCP_DATA_DIR: unsupportedDir }), { setupToken: 'fixture-no-prf' });
  await app.listen({ host: '127.0.0.1', port });
  const unsupportedContext = await browser.newContext(); const unsupportedPage = await unsupportedContext.newPage();
  const unsupportedCdp = await unsupportedContext.newCDPSession(unsupportedPage); await unsupportedCdp.send('WebAuthn.enable');
  await unsupportedCdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: false } });
  await unsupportedPage.goto(origin);
  await unsupportedPage.getByLabel('Initial setup code from server logs', { exact: true }).fill('fixture-no-prf');
  await unsupportedPage.getByLabel('Passkey name', { exact: true }).fill('Unsupported fixture');
  await unsupportedPage.getByRole('button', { name: 'Register storage passkey', exact: true }).click();
  await unsupportedPage.getByRole('button', { name: 'Finish encrypted setup', exact: true }).click();
  await unsupportedPage.getByRole('alert').filter({ hasText: 'did not return PRF' }).waitFor();
  await assert.rejects(readFile(join(unsupportedDir, 'storage-vault.json')), { code: 'ENOENT' });
  await unsupportedContext.close();
  assert.deepEqual(errors, []);
  console.log('Production storage verified: legacy migration, environment auto-unlock, two PRF passkeys, locked restart, startup notification callback, recovery, encrypted disk records and path-bound keys.');
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    console.warn('Browser state:', page.url(), await page.getByRole('heading').allTextContents(), await page.getByRole('alert').allTextContents());
  }
  console.warn('Page errors:', errors);
  throw error;
} finally { await browser?.close(); await app?.close(); await rm(directory, { recursive: true, force: true }); key.fill(0); }
