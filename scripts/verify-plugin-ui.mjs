// Isolated end-to-end fixture. Never run against production state or accounts.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { chromium } from '@playwright/test';
import { PluginRegistry } from '@approval-mcp/plugin-sdk';
import { createConfigStateStore } from '@approval-mcp/state-store';
import { StateStoreTokenRepository, TokenService } from '@approval-mcp/gateway';
import { buildServerApp } from '../apps/server/dist/app.js';
import { registerAdminRoutes } from '../apps/server/dist/admin/index.js';
import { PluginManager } from '../apps/server/dist/plugins/plugin-manager.js';
import { InMemoryRecoveryRepository, RecoveryService } from '../apps/server/dist/recovery-service.js';
import { InMemorySessionRepository, SessionService } from '../apps/server/dist/session-store.js';

const directory = await mkdtemp(join(tmpdir(), 'approval-plugin-ui-'));
const output = resolve(process.env.PLUGIN_SCREENSHOT_DIR ?? join(directory, 'screenshots'));
await mkdir(output, { recursive: true });
const state = await createConfigStateStore(join(directory, 'data'));
const registry = new PluginRegistry([]);
const host = {
  async findContact(_upstream, _source, identifier) { return { contacts: [{ jid: identifier, name: 'Sample contact' }] }; },
  async findChat(_upstream, identifier) { return { jid: identifier, name: 'Sample chat' }; },
};
const manager = new PluginManager({ directory: join(directory, 'plugins'), state, registry, host });
let browser;
let app;
try {
  await manager.restore();
  await manager.installDefaults();
  assert.equal(registry.list().length, 6, JSON.stringify(manager.list()));
  const description = await registry.describe({ id: 'whatsapp', version: '1.0.0' }, {
    upstreamId: 'sample-whatsapp', upstreamAlias: 'whatsapp', toolName: 'send_message',
    arguments: { recipient: 'sample@s.whatsapp.net', message: 'Sample content for a UI test.' },
  });
  assert.equal(description.source, 'plugin');
  const now = new Date().toISOString();
  for (const [id, alias, pluginId, displayName] of [
    ['sample-whatsapp', 'whatsapp', 'whatsapp', 'WhatsApp'],
    ['sample-mail-work', 'work_mail', 'email', 'Work email'],
    ['sample-mail-home', 'private_mail', 'email', 'Personal email'],
    ['sample-wellness', 'wellness', 'krkonoskewellness', 'Wellness'],
    ['sample-imcp', 'imcp', 'imcp', 'iMCP'],
  ]) await state.mutate({ type: 'record.upserted', collection: 'upstreams', id, value: {
    id, alias, displayName, pluginId, pluginVersion: '1.0.0', url: 'https://example.invalid/mcp',
    allowPrivateNetwork: false, schemaVersion: 1, version: 1, createdAt: now, updatedAt: now,
  } });
  const sessions = new SessionService(new InMemorySessionRepository());
  const session = await sessions.create('test-admin');
  const unavailable = async () => { throw new Error('Not available in UI test fixture'); };
  app = await buildServerApp({ auth: {
    sessions, secureCookies: false, recovery: new RecoveryService(new InMemoryRecoveryRepository()),
    passkeys: { bootstrapOptions: unavailable, verifyBootstrap: unavailable, loginOptions: unavailable, verifyLogin: unavailable },
  } });
  await registerAdminRoutes(app, {
    sessions, state, tokens: new TokenService(new StateStoreTokenRepository(state)),
    getPlugins: () => registry.list(), pluginManager: manager,
  });
  await app.register(fastifyStatic, { root: resolve('apps/web/dist'), wildcard: false });
  app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({}) : reply.sendFile('index.html'));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ headless: true, ...(process.env.DEMO_CHROMIUM_EXECUTABLE ? { executablePath: process.env.DEMO_CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US', timezoneId: 'UTC' });
  await context.addCookies([{ name: 'amcp_admin', value: session.plaintext, url: origin, httpOnly: true }, { name: 'amcp_csrf', value: session.csrfToken, url: origin }]);
  await context.addInitScript(() => { localStorage.setItem('approval-mcp.locale', 'en'); localStorage.setItem('approval-mcp.theme', 'light'); });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/plugins`);
  await page.getByRole('heading', { name: 'Presentation plugins', exact: true }).waitFor();
  assert.equal(await page.locator('.managed-plugin-card').count(), 6);
  assert.match(await page.getByRole('link', { name: /approval-mcp-plugin-your-mail-mcp/ }).getAttribute('href'), /plugin-your-mail-mcp$/);
  const geo = page.locator('.managed-plugin-card').filter({ has: page.getByRole('heading', { name: 'Geo / Dawarich', exact: true }) });
  const action = async (label) => {
    const response = page.waitForResponse((response) => response.request().method() !== 'GET' && response.url().includes('/api/admin/plugins/geo'));
    await geo.getByRole('button', { name: label, exact: true }).click();
    assert.equal((await response).status(), 200);
  };
  await geo.getByRole('button', { name: 'Disable', exact: true }).click();
  await action('Disable');
  await geo.getByText('Disabled', { exact: true }).waitFor();
  assert.equal(registry.list().length, 5);
  await action('Enable');
  await geo.getByText('Enabled', { exact: true }).waitFor();
  await action('Check for updates');
  await page.getByRole('status').filter({ hasText: 'Already up to date.' }).waitFor();
  const used = page.locator('.managed-plugin-card').filter({ has: page.getByRole('heading', { name: 'iMCP', exact: true }) });
  assert.equal(await used.getByRole('button', { name: 'Uninstall', exact: true }).isDisabled(), true);
  await geo.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await action('Uninstall');
  await geo.getByText('Not installed', { exact: true }).waitFor();
  await action('Install');
  await geo.getByText('Enabled', { exact: true }).waitFor();
  await page.reload();
  await page.locator('.managed-plugin-card').first().waitFor();
  await page.screenshot({ path: join(output, 'plugins-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Dark theme', exact: true }).first().click();
  await page.screenshot({ path: join(output, 'plugins-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, 'plugins-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile layout overflow');
  await page.getByRole('button', { name: 'CZ', exact: true }).last().click();
  await page.getByRole('heading', { name: 'Prezentační pluginy', exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'plugins-czech-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const offlineFetch = async () => { throw new Error('Restart must not contact GitHub'); };
  const restarted = new PluginManager({ directory: join(directory, 'plugins'), state, registry, host, fetch: offlineFetch });
  await restarted.restore();
  await restarted.installDefaults();
  assert.equal(registry.list().length, 6);
  await restarted.close();
  console.log(`Plugin UI verified: six real repositories, actions, offline restart, desktop/mobile/English/Czech. Screenshots: ${output}`);
} finally {
  await browser?.close();
  await manager.close();
  await app?.close();
  await state.close();
  await rm(directory, { recursive: true, force: true });
}
