import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { startPoc } from '../examples/passkey-vault-poc/server.mjs';

const directory = await mkdtemp(join(tmpdir(), 'approval-prf-browser-'));
let app;
let browser;
try {
  app = await startPoc({ dataDir: directory, port: 0 });
  browser = await chromium.launch({ headless: true, ...(process.env.DEMO_CHROMIUM_EXECUTABLE ? { executablePath: process.env.DEMO_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (request.method() === 'POST') requests.push({ url: request.url(), data: request.postDataJSON() }); });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true,
  } });
  await page.goto(app.origin);
  await page.getByRole('button', { name: 'Create with passkey', exact: true }).click();
  await page.getByRole('button', { name: 'Finish encrypted setup', exact: true }).click();
  await page.locator('#sample-section').waitFor({ state: 'visible' });
  const recovery = await page.locator('#new-recovery-code').inputValue();
  assert.equal(recovery.length, 43);
  const disk = await readFile(app.file, 'utf8');
  assert.equal(disk.includes(recovery), false);
  assert.equal(disk.includes('Synthetic data'), false);
  const enrollment = requests.find((item) => item.url.endsWith('/api/enroll/complete'));
  assert.ok(enrollment);
  assert.equal(disk.includes(enrollment.data.key), false);
  for (const request of requests) {
    assert.equal(JSON.stringify(request.data).includes(recovery), false);
    if (request.data.authentication) assert.deepEqual(request.data.authentication.clientExtensionResults, {});
  }
  await page.getByRole('button', { name: 'Lock vault', exact: true }).click();
  await page.locator('#state').filter({ hasText: /^Locked$/ }).waitFor();
  await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
  await page.locator('#state').filter({ hasText: /^Unlocked$/ }).waitFor();
  const origin = app.origin;
  const port = Number(new URL(origin).port);
  await app.close();
  app = undefined;
  app = await startPoc({ dataDir: directory, port, publicUrl: origin });
  await page.reload();
  await page.locator('#state').filter({ hasText: /^Locked$/ }).waitFor();
  assert.equal(await page.locator('#sample-section').isVisible(), false);
  await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
  await page.locator('#state').filter({ hasText: /^Unlocked$/ }).waitFor();
  await page.getByRole('button', { name: 'Lock vault', exact: true }).click();
  await page.locator('#state').filter({ hasText: /^Locked$/ }).waitFor();
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  await page.getByText('Use a recovery key instead', { exact: true }).click();
  await page.getByLabel('Recovery key', { exact: true }).fill('wrong-key');
  await page.getByRole('button', { name: 'Recover vault', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Recovery failed' }).waitFor();
  await page.getByLabel('Recovery key', { exact: true }).fill(recovery);
  await page.getByRole('button', { name: 'Recover vault', exact: true }).click();
  await page.locator('#state').filter({ hasText: /^Unlocked$/ }).waitFor();
  assert.deepEqual(errors, []);
  const unsupported = await startPoc({ dataDir: join(directory, 'unsupported'), port: 0 });
  const unsupportedContext = await browser.newContext();
  try {
    const unsupportedPage = await unsupportedContext.newPage();
    const unsupportedCdp = await unsupportedContext.newCDPSession(unsupportedPage);
    await unsupportedCdp.send('WebAuthn.enable');
    await unsupportedCdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: false,
    } });
    await unsupportedPage.goto(unsupported.origin);
    await unsupportedPage.getByRole('button', { name: 'Create with passkey', exact: true }).click();
    await unsupportedPage.getByRole('button', { name: 'Finish encrypted setup', exact: true }).click();
    await unsupportedPage.getByRole('status').filter({ hasText: 'did not return PRF key material' }).waitFor();
    assert.equal((await unsupportedPage.evaluate(() => fetch('/api/status').then((response) => response.json()))).initialized, false);
    await assert.rejects(readFile(unsupported.file), { code: 'ENOENT' });
  } finally { await unsupportedContext.close(); await unsupported.close(); }
  console.log('Passkey vault PoC verified: virtual PRF passkey, unsupported-PRF fail-closed, encryption, lock, restart, recovery, and no key material persisted. Real device compatibility still requires a manual test.');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
