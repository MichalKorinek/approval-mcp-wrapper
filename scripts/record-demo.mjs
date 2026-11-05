import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import { chromium } from '@playwright/test';
import { createCallJournal } from '@approval-mcp/call-journal';
import { connectedApprovalPlugins } from '@approval-mcp/connected-plugins';
import {
  ApprovalOrchestrator,
  PolicyCallCoordinator,
  PolicyDeniedError,
  StateStoreApprovalRepository,
  StateStoreTokenRepository,
  TokenService,
} from '@approval-mcp/gateway';
import { resolveProfileRules } from '@approval-mcp/policy';
import { createConfigStateStore } from '@approval-mcp/state-store';

import { buildServerApp } from '../apps/server/dist/app.js';
import {
  ApprovalEventBroker,
  HistoryEventBroker,
  registerAdminRoutes,
} from '../apps/server/dist/admin/index.js';
import { InMemoryRecoveryRepository, RecoveryService } from '../apps/server/dist/recovery-service.js';
import { InMemorySessionRepository, SessionService } from '../apps/server/dist/session-store.js';

// An isolated recording fixture, never the production entry point. All remote
// MCP calls and device records below are synthetic; no push delivery is faked.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(process.env.DEMO_OUTPUT_DIR ?? join(root, 'docs/media'));
const speed = Number(process.env.DEMO_SPEED ?? 1);
if (!Number.isFinite(speed) || speed <= 0) throw new Error('DEMO_SPEED must be positive');
const pause = (ms) => delay(Math.max(50, ms * speed));
await mkdir(outputDir, { recursive: true });
const temporaryDir = await mkdtemp(join(tmpdir(), 'approval-mcp-recording-'));
const state = await createConfigStateStore(join(temporaryDir, 'data'));
const sessions = new SessionService(new InMemorySessionRepository());
const session = await sessions.create('demo-admin');
const tokens = new TokenService(new StateStoreTokenRepository(state));
const agent = (await tokens.create('Work assistant')).record;
const secondAgent = (await tokens.create('Personal assistant')).record;
const now = new Date().toISOString();
const versioned = (id, values) => ({ id, schemaVersion: 1, createdAt: now, updatedAt: now, version: 1, ...values });
const upstreams = [
  versioned('demo-work-mail', { alias: 'work_mail', displayName: 'Work email', description: 'Company mailbox for project work.', metadata: { account: 'work', owner: 'demo team' }, url: 'https://mail-work.example/mcp', allowPrivateNetwork: false, pluginId: 'email', pluginVersion: '1.0.0' }),
  versioned('demo-private-mail', { alias: 'private_mail', displayName: 'Personal email', description: 'Personal mailbox kept separate from work tools.', metadata: { account: 'personal' }, url: 'https://mail-personal.example/mcp', allowPrivateNetwork: false, pluginId: 'email', pluginVersion: '1.0.0' }),
  versioned('demo-whatsapp', { alias: 'whatsapp', displayName: 'WhatsApp', description: 'Messages and chats; sending requires approval.', url: 'https://chat.example/mcp', allowPrivateNetwork: false, pluginId: 'whatsapp', pluginVersion: '1.0.0' }),
];
const profiles = [
  versioned('demo-profile-work', { name: 'Work', isDefault: true, approvalTimeoutSeconds: 300, toolCallTimeoutSeconds: 60 }),
  versioned('demo-profile-private', { name: 'Personal', isDefault: false, approvalTimeoutSeconds: 60, toolCallTimeoutSeconds: 60 }),
];
const catalogs = {
  'demo-work-mail': [
    { name: 'search', description: 'Search emails by query.' },
    { name: 'text', description: 'Read the selected email.' },
    { name: 'refresh', description: 'Start mailbox synchronization.' },
  ],
  'demo-private-mail': [{ name: 'search', description: 'Search personal emails.' }],
  'demo-whatsapp': [
    { name: 'list_chats', description: 'List available chats.' },
    { name: 'send_message', description: 'Send a message to a recipient or group.' },
    { name: 'send_file', description: 'Send a file through WhatsApp.' },
  ],
};
const rules = [
  ['demo-work-mail', 'search', 'allow'],
  ['demo-work-mail', 'text', 'allow'],
  ['demo-work-mail', 'refresh', 'deny'],
  ['demo-whatsapp', 'list_chats', 'allow'],
  ['demo-whatsapp', 'send_message', 'require_approval'],
  ['demo-whatsapp', 'send_file', 'deny'],
].map(([upstreamId, toolName, outcome], index) => versioned(`demo-rule-${index}`, {
  profileId: profiles[0].id, upstreamId, toolName, outcome, predicates: [], enabled: true,
}));
rules.push(versioned('demo-rule-private', { profileId: profiles[1].id, upstreamId: 'demo-private-mail', toolName: 'search', outcome: 'allow', predicates: [], enabled: true }));
const assignments = [agent, secondAgent].map((token, index) => versioned(`demo-assignment-${index}`, { clientTokenId: token.id, profileId: profiles[index].id }));
await state.mutate({
  type: 'records.batch',
  operations: [
    ...upstreams.map((value) => ['upstreams', value]),
    ...profiles.map((value) => ['profiles', value]),
    ...rules.map((value) => ['profileRules', value]),
    ...assignments.map((value) => ['tokenProfileAssignments', value]),
  ].map(([collection, value]) => ({ type: 'record.upserted', collection, id: value.id, value })),
});
const broker = new ApprovalEventBroker();
const historyBroker = new HistoryEventBroker();
const repository = new StateStoreApprovalRepository(state);
const approvals = new ApprovalOrchestrator(repository, () => new Date(), () => false,
  (approval) => broker.publish({ approvalId: approval.id, status: approval.status }));
const journal = await createCallJournal(join(temporaryDir, 'calls'), (event) => historyBroker.publish({ callId: event.callId, timestamp: event.timestamp, type: event.type }));
const contactNames = new Map([
  ['demo-project-team@lid', 'Project team'],
  ['demo-second-chat@lid', 'Organizing team'],
]);
const plugins = connectedApprovalPlugins({
  async findContact(_upstreamId, _source, identifier) {
    return { contacts: [{ jid: identifier, name: contactNames.get(identifier) ?? 'Sample contact' }] };
  },
  async findChat(_upstreamId, identifier) {
    return { jid: identifier, name: contactNames.get(identifier) ?? 'Sample chat' };
  },
});
let simulatedExecutions = 0;
const coordinator = new PolicyCallCoordinator({
  policies(call) {
    return resolveProfileRules({ ...call, profiles, rules, assignments }).rules.map((rule) => ({ ...rule, clientTokenId: call.clientTokenId, toolName: call.toolName }));
  },
  grants: () => state.read((current) => Object.values(current.grants)),
  approvals,
  journal,
  approvalTimeoutMs: () => 300_000,
  upstream: { async call() { simulatedExecutions++; return { content: [{ type: 'text', text: 'Demo only. No external operation was performed.' }] }; } },
  async describe(call) {
    const upstream = upstreams.find((candidate) => candidate.id === call.upstreamId);
    const plugin = plugins.find((candidate) => candidate.id === upstream.pluginId);
    return { description: await plugin.describe({ ...call, upstreamAlias: upstream.alias }), pluginId: plugin.id, pluginVersion: plugin.version, normalizationVersion: plugin.normalizationVersion };
  },
});
const signal = new AbortController();
const call = (upstreamId, toolName, args) => coordinator.call({ clientTokenId: agent.id, upstreamId, toolName, arguments: args }, signal.signal);
await call('demo-work-mail', 'search', { account: 'work', query: 'project status' });
await assert.rejects(call('demo-work-mail', 'refresh', {}), PolicyDeniedError);
const deviceViews = ['Demo Mac · Safari', 'Demo iPhone'].map((name, index) => ({
  id: `demo-device-${index}`, name, locale: 'en', platform: index === 0 ? 'macOS' : 'iOS', endpointHash: String(index).repeat(64), createdAt: now, updatedAt: now,
}));
const unavailable = async () => { throw new Error('Authentication enrollment and real push delivery are not part of this isolated recording fixture'); };
const app = await buildServerApp({ auth: {
  sessions, secureCookies: false, recovery: new RecoveryService(new InMemoryRecoveryRepository()),
  passkeys: { bootstrapOptions: unavailable, verifyBootstrap: unavailable, loginOptions: unavailable, verifyLogin: unavailable },
} });
let browser;
let context;
try {
  await registerAdminRoutes(app, {
    sessions, state, tokens, approvals, journal, broker, historyBroker, plugins,
    discoverTools: async (upstreamId) => ({ upstreamId, refreshedAt: new Date().toISOString(), tools: (catalogs[upstreamId] ?? []).map((tool) => ({ ...tool, inputSchema: { type: 'object' } })) }),
    push: { publicKey: '', listDevices: () => deviceViews, registerDevice: unavailable, removeDevice: unavailable, testDevice: unavailable },
  });
  await app.register(fastifyStatic, { root: join(root, 'apps/web/dist'), wildcard: false });
  app.setNotFoundHandler((request, reply) => request.method === 'GET' && !request.url.startsWith('/api/') ? reply.sendFile('index.html') : reply.code(404).send({ error: { code: 'route.not_found' } }));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ headless: true, ...(process.env.DEMO_CHROMIUM_EXECUTABLE ? { executablePath: process.env.DEMO_CHROMIUM_EXECUTABLE } : {}) });
  context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, locale: 'en-US', timezoneId: 'UTC', recordVideo: { dir: join(temporaryDir, 'video'), size: { width: 1440, height: 1080 } } });
  await context.addCookies([{ name: 'amcp_admin', value: session.plaintext, url: origin, httpOnly: true }, { name: 'amcp_csrf', value: session.csrfToken, url: origin }]);
  await context.addInitScript(() => {
    localStorage.setItem('approval-mcp.locale', 'en');
    localStorage.setItem('approval-mcp.theme', 'light');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const video = page.video();
  const move = async (locator) => { await locator.scrollIntoViewIfNeeded(); await locator.hover(); await pause(450); };
  const click = async (locator) => { await move(locator); await locator.click(); };
  const scene = async (title, subtitle, hold = 1_800) => {
    console.log(title);
    await page.evaluate(({ title, subtitle }) => {
      const card = document.createElement('div');
      card.id = 'demo-scene';
      Object.assign(card.style, { position: 'fixed', inset: '0', zIndex: '2147483647', display: 'grid', placeContent: 'center', padding: '100px', textAlign: 'left', background: 'radial-gradient(ellipse at 15% 20%, #1d3872, #0b1224 65%)', color: '#f8fafc', fontFamily: 'system-ui, sans-serif' });
      const brand = document.createElement('p'); brand.textContent = 'APPROVAL MCP / DEMO'; Object.assign(brand.style, { color: '#93c5fd', fontSize: '18px', fontWeight: '700', letterSpacing: '3px', marginBottom: '26px' });
      const heading = document.createElement('h1'); heading.textContent = title; Object.assign(heading.style, { fontSize: '58px', maxWidth: '1100px', lineHeight: '1.15', margin: '0 0 22px' });
      const detail = document.createElement('p'); detail.textContent = subtitle; Object.assign(detail.style, { color: '#cbd5e1', fontSize: '25px', maxWidth: '1050px', lineHeight: '1.6' });
      card.append(brand, heading, detail); document.body.append(card);
    }, { title, subtitle });
    await pause(hold);
    await page.evaluate(() => document.getElementById('demo-scene')?.remove());
  };
  await page.goto(`${origin}/upstreams`);
  await page.getByRole('heading', { name: 'Work email', exact: true }).waitFor();
  await page.evaluate(() => {
    const badge = document.createElement('div'); badge.textContent = 'DEMO · SAMPLE DATA';
    Object.assign(badge.style, { position: 'fixed', bottom: '10px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483646', padding: '7px 14px', background: '#0f172ae6', color: '#cbd5e1', borderRadius: '20px', font: '600 11px system-ui', letterSpacing: '1px', pointerEvents: 'none' });
    document.body.append(badge);
  });
  await scene('Your agents. Your rules.', 'A quick tour of the approval gateway. All data is fictional; no real messages or push notifications are sent.', 3_200);
  await scene('01 / Connect your MCP servers', 'Names, descriptions, and metadata keep work and personal accounts distinct.');
  await pause(3_000);
  await click(page.locator('.upstream-record').filter({ hasText: 'Work email' }).getByRole('button', { name: 'Edit', exact: true }));
  await pause(2_500);
  await click(page.locator('[data-route="/access"]').first());
  await page.getByText('Work assistant', { exact: true }).waitFor();
  await scene('02 / Profiles control tool access', 'Give each agent a profile. Approval waits and tool execution have separate timeouts.');
  await pause(2_000);
  await click(page.getByRole('tab', { name: /^Profiles/ }));
  await page.getByLabel('Approval wait', { exact: true }).waitFor();
  await pause(4_000);
  await page.locator('.profile-server').filter({ hasText: 'WhatsApp' }).scrollIntoViewIfNeeded();
  await pause(2_000);
  await click(page.locator('[data-route="/approvals"]').first());
  const pendingCall = call('demo-whatsapp', 'send_message', { recipient: 'demo-project-team@lid', message: 'Hi team, the draft is ready for review. Please share your feedback by Friday. Thanks!' });
  // Attach a rejection handler immediately, including if recording later fails.
  const pendingResult = pendingCall.then((result) => ({ result }), (error) => ({ error }));
  await page.locator('.approval-card').waitFor();
  await scene('03 / Review the actual content', 'See the agent, recipient, and full message. Expand the technical arguments whenever you need them.');
  await click(page.locator('.approval-card').first());
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Project team', { exact: true }).waitFor();
  await pause(4_000);
  await dialog.getByRole('radio', { name: 'Whole tool (any arguments)', exact: true }).check();
  await move(dialog.getByRole('button', { name: 'Allow for 1 hour', exact: true }));
  await scene('04 / One hour, any arguments', 'Allow this agent to use the same tool on the same upstream without argument restrictions. Revoke the grant at any time.');
  await pause(3_500);
  await page.screenshot({ path: join(outputDir, 'approval-mcp-demo.png') });
  const saved = page.waitForResponse((response) => response.url().endsWith('/decision') && response.request().method() === 'POST');
  await click(dialog.getByRole('button', { name: 'Allow for 1 hour', exact: true }));
  assert.equal((await saved).status(), 200);
  const result = await pendingResult;
  if (result.error) throw result.error;
  const grant = state.read((current) => Object.values(current.grants).find((item) => item.toolName === 'send_message'));
  assert.deepEqual(grant.predicates, []);
  assert.ok(grant.expiresAt);
  await call('demo-whatsapp', 'send_message', { recipient: 'demo-second-chat@lid', message: 'A sample message to another recipient using the one-hour tool-wide grant.' });
  assert.equal((await repository.list()).filter((item) => item.approval.status === 'pending').length, 0);
  await click(page.locator('[data-route="/access"]').first());
  await click(page.getByRole('tab', { name: /^Active permissions/ }));
  await page.getByText('Whole tool (any arguments)', { exact: true }).waitFor();
  await pause(3_500);
  await click(page.locator('[data-route="/history"]').first());
  await page.locator('.history-table > button').first().waitFor();
  await scene('05 / Every decision has a history', 'A call to another recipient no longer prompts for approval. History preserves the decision, result, and timeline.');
  await pause(2_500);
  await click(page.locator('.history-table > button').filter({ hasText: 'Project team' }).first());
  await page.getByRole('dialog').locator('.timeline li').first().waitFor();
  await pause(4_000);
  await click(page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }));
  await click(page.locator('[data-route="/system"]').first());
  await page.getByText('Demo Mac · Safari', { exact: true }).waitFor();
  await scene('06 / Manage your notifications', 'Named devices, Test, and Remove in one place. This demo does not send system notifications.');
  await pause(3_500);
  await click(page.getByRole('button', { name: 'Dark theme', exact: true }).first());
  await pause(2_000);
  await scene('Start at localhost:43127', 'Find Docker setup, OAuth client configuration, profiles, and backup instructions in the README.');
  assert.equal(simulatedExecutions, 3);
  assert.deepEqual(errors, []);
  await context.close(); context = undefined;
  await video.saveAs(join(outputDir, 'approval-mcp-demo.webm'));
  console.log(`Video and poster saved to ${outputDir}`);
} finally {
  signal.abort();
  await context?.close();
  await browser?.close();
  await app.close();
  await state.close();
  await rm(temporaryDir, { recursive: true, force: true });
}
