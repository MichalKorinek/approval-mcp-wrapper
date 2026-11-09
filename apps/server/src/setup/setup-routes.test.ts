import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonValue, Upstream, UpstreamId } from '@approval-mcp/contracts';
import { createConfigStateStore } from '@approval-mcp/state-store';
import { CredentialVault } from '@approval-mcp/upstream';
import { afterEach, describe, expect, it } from 'vitest';

import { buildServerApp } from '../app.js';
import { InMemoryRecoveryRepository, RecoveryService } from '../recovery-service.js';
import { InMemorySessionRepository, SessionService } from '../session-store.js';
import { registerSetupRoutes } from './setup-routes.js';
import {
  DECIDED_SETUP_RETENTION_MS,
  SETUP_REQUEST_LIFETIME_MS,
  SetupService,
} from './setup-service.js';

const SECRET = 'Bearer secret-token-123';
const apps: Awaited<ReturnType<typeof buildServerApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture(options: { passkeyAdminId?: string } = {}) {
  const store = await createConfigStateStore(await mkdtemp(join(tmpdir(), 'approval-setup-')));
  const sessions = new SessionService(new InMemorySessionRepository());
  const session = await sessions.create('admin');
  const vault = new CredentialVault(Buffer.alloc(32, 7));
  let clock = new Date('2026-11-06T10:00:00.000Z');
  let upstreamChanges = 0;
  const passkeys = {
    bootstrapOptions: async () => ({}),
    verifyBootstrap: async () => ({ adminId: 'admin' }),
    loginOptions: async () => ({}),
    verifyLogin: async () => ({ adminId: options.passkeyAdminId ?? 'admin' }),
  };
  const app = await buildServerApp({
    auth: {
      passkeys,
      sessions,
      recovery: new RecoveryService(new InMemoryRecoveryRepository()),
      secureCookies: true,
    },
  });
  const setup = new SetupService({
    state: store,
    credentialVault: vault,
    publicOrigin: 'http://localhost:3000',
    onUpstreamsChanged: async () => { upstreamChanges += 1; },
    now: () => clock,
  });
  await registerSetupRoutes(app, { setup, passkeys, sessions });
  apps.push(app);
  const authHeaders = {
    cookie: `amcp_admin=${session.plaintext}`,
    'x-csrf-token': session.csrfToken,
  };
  return {
    app,
    setup,
    store,
    vault,
    authHeaders,
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    upstreamChanges: () => upstreamChanges,
    upstreams: () => store.read((state) =>
      Object.values(state.upstreams).map((value) => value as unknown as Upstream)),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const jira = { alias: 'jira', url: 'https://jira.example.com/mcp', displayName: 'Jira' };

function submit(f: Fixture, upstreams: unknown[]) {
  return f.app.inject({
    method: 'POST',
    url: '/api/setup/requests',
    payload: { source: 'usy_smarta_agentg01', upstreams },
  });
}

function approve(f: Fixture, id: string, body: Record<string, unknown>) {
  return f.app.inject({
    method: 'POST',
    url: `/api/setup/requests/${id}/approve`,
    headers: f.authHeaders,
    payload: { passkey: { id: 'passkey' }, ...body },
  });
}

describe('declarative upstream setup API', () => {
  it('creates an upstream with credentials sent in the call after passkey approval', async () => {
    const f = await fixture();
    const created = await submit(f, [{ ...jira, credentials: { authorization: SECRET } }]);
    expect(created.statusCode).toBe(202);
    expect(created.body).not.toContain(SECRET);
    const { requestId, planDigest, approvalUrl, items } = created.json();
    expect(approvalUrl).toBe(`http://localhost:3000/setup/requests/${requestId}`);
    expect(items).toEqual([expect.objectContaining({ alias: 'jira', action: 'create', credentials: 'provided' })]);

    const view = await f.app.inject({ method: 'GET', url: `/api/setup/requests/${requestId}`, headers: { cookie: f.authHeaders.cookie } });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ source: 'usy_smarta_agentg01', planDigest });
    expect(view.body).not.toContain(SECRET);

    const approved = await approve(f, requestId, { planDigest });
    expect(approved.statusCode).toBe(200);
    expect(approved.body).not.toContain(SECRET);
    expect(approved.json()).toMatchObject({ status: 'applied', results: [{ alias: 'jira', action: 'create' }] });

    const [stored] = f.upstreams();
    expect(stored).toMatchObject({ alias: 'jira', url: 'https://jira.example.com/mcp', displayName: 'Jira', managedBy: 'usy_smarta_agentg01', version: 1 });
    expect(f.vault.decrypt(stored!.id, stored!.credentials!)).toEqual({ authorization: SECRET });
    expect(f.upstreamChanges()).toBe(1);

    const status = await f.app.inject({ method: 'GET', url: `/api/setup/requests/${requestId}/status` });
    expect(status.json()).toMatchObject({ status: 'applied' });
    expect(status.body).not.toContain(SECRET);
  });

  it('answers unchanged for a repeated declaration and creates no duplicate', async () => {
    const f = await fixture();
    const first = await submit(f, [{ ...jira, credentials: { authorization: SECRET } }]);
    await approve(f, first.json().requestId, { planDigest: first.json().planDigest });
    const again = await submit(f, [{ ...jira, credentials: { authorization: SECRET } }]);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: 'unchanged', items: [{ alias: 'jira', action: 'unchanged', credentials: 'keep' }] });
    expect(again.json()).not.toHaveProperty('requestId');
    expect(f.upstreams()).toHaveLength(1);
  });

  it('requires the operator to enter credentials when the call does not carry them', async () => {
    const f = await fixture();
    const created = await submit(f, [{ ...jira, credentialsRequired: true }]);
    const { requestId, planDigest, items } = created.json();
    expect(items[0]).toMatchObject({ credentials: 'required' });

    const missing = await approve(f, requestId, { planDigest });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('setup.credentials_missing');
    expect(f.upstreams()).toHaveLength(0);

    const unexpected = await approve(f, requestId, { planDigest, credentials: { other: { authorization: SECRET } } });
    expect(unexpected.json().error.code).toBe('setup.credentials_unexpected');

    const entered = await approve(f, requestId, { planDigest, credentials: { jira: { authorization: SECRET } } });
    expect(entered.statusCode).toBe(200);
    expect(entered.body).not.toContain(SECRET);
    const [stored] = f.upstreams();
    expect(f.vault.decrypt(stored!.id, stored!.credentials!)).toEqual({ authorization: SECRET });
  });

  it('creates upstreams that need no credentials', async () => {
    const f = await fixture();
    const created = await submit(f, [{ alias: 'k8s', url: 'http://k8s-mcp:8080/mcp', allowPrivateNetwork: true }]);
    const approved = await approve(f, created.json().requestId, { planDigest: created.json().planDigest });
    expect(approved.statusCode).toBe(200);
    expect(f.upstreams()[0]).toMatchObject({ alias: 'k8s', allowPrivateNetwork: true });
    expect(f.upstreams()[0]).not.toHaveProperty('credentials');
  });

  it('does not carry stored credentials to a changed URL', async () => {
    const f = await fixture();
    const first = await submit(f, [{ ...jira, credentials: { authorization: SECRET } }]);
    await approve(f, first.json().requestId, { planDigest: first.json().planDigest });

    const moved = await submit(f, [{ ...jira, url: 'https://other.example.com/mcp' }]);
    expect(moved.json().items[0]).toMatchObject({ action: 'update', credentials: 'remove', changes: ['url', 'credentials'] });
    await approve(f, moved.json().requestId, { planDigest: moved.json().planDigest });
    const [stored] = f.upstreams();
    expect(stored).toMatchObject({ url: 'https://other.example.com/mcp', version: 2 });
    expect(stored).not.toHaveProperty('credentials');
  });

  it('rejects a plan that became stale before approval', async () => {
    const f = await fixture();
    const created = await submit(f, [jira]);
    const now = new Date().toISOString();
    const manual: Upstream = {
      id: 'manual' as UpstreamId, alias: 'jira', url: 'https://manual.example.com/mcp',
      allowPrivateNetwork: false, schemaVersion: 1, createdAt: now, updatedAt: now, version: 1,
    };
    await f.store.mutate({ type: 'record.upserted', collection: 'upstreams', id: manual.id, value: manual as unknown as JsonValue });

    const stale = await approve(f, created.json().requestId, { planDigest: created.json().planDigest });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('setup.plan_stale');
    expect(f.upstreams()).toEqual([manual]);
    const status = await f.app.inject({ method: 'GET', url: `/api/setup/requests/${created.json().requestId}/status` });
    expect(status.statusCode).toBe(404);
  });

  it('marks the request stale when the plan can no longer be computed', async () => {
    const f = await fixture();
    const created = await submit(f, [jira]);
    const now = new Date().toISOString();
    for (const id of ['a', 'b']) {
      await f.store.mutate({ type: 'record.upserted', collection: 'upstreams', id, value: {
        id, alias: 'jira', url: 'https://jira.example.com/mcp', allowPrivateNetwork: false,
        schemaVersion: 1, createdAt: now, updatedAt: now, version: 1,
      } });
    }
    const stale = await approve(f, created.json().requestId, { planDigest: created.json().planDigest });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('setup.plan_stale');
  });

  it('keeps the plugin assigned in the admin UI', async () => {
    const f = await fixture();
    const now = new Date().toISOString();
    await f.store.mutate({ type: 'record.upserted', collection: 'upstreams', id: 'u', value: {
      id: 'u', alias: 'jira', url: 'https://jira.example.com/mcp', allowPrivateNetwork: false,
      pluginId: 'jira', pluginVersion: '1.0.0', schemaVersion: 1, createdAt: now, updatedAt: now, version: 1,
    } });
    const changed = await submit(f, [{ ...jira, displayName: 'Jira (work)' }]);
    await approve(f, changed.json().requestId, { planDigest: changed.json().planDigest });
    expect(f.upstreams()[0]).toMatchObject({ displayName: 'Jira (work)', pluginId: 'jira', pluginVersion: '1.0.0', version: 2 });
    const rejected = await submit(f, [{ ...jira, pluginId: 'jira' }]);
    expect(rejected.statusCode).toBe(400);
  });

  it('rejects a digest that differs from the presented plan', async () => {
    const f = await fixture();
    const created = await submit(f, [jira]);
    const wrong = await approve(f, created.json().requestId, { planDigest: '0'.repeat(64) });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.code).toBe('setup.plan_mismatch');
  });

  it('requires an admin session, CSRF, and the same admin passkey', async () => {
    const f = await fixture({ passkeyAdminId: 'someone-else' });
    const created = await submit(f, [jira]);
    const { requestId, planDigest } = created.json();
    expect((await f.app.inject({ method: 'GET', url: `/api/setup/requests/${requestId}` })).statusCode).toBe(401);
    const noCsrf = await f.app.inject({
      method: 'POST', url: `/api/setup/requests/${requestId}/approve`,
      headers: { cookie: f.authHeaders.cookie }, payload: { planDigest, passkey: {} },
    });
    expect(noCsrf.statusCode).toBe(403);
    const otherAdmin = await approve(f, requestId, { planDigest });
    expect(otherAdmin.statusCode).toBe(403);
    expect(f.upstreams()).toHaveLength(0);
  });

  it('denies, expires, and limits pending requests', async () => {
    const f = await fixture();
    const denied = await submit(f, [jira]);
    const deny = await f.app.inject({ method: 'POST', url: `/api/setup/requests/${denied.json().requestId}/deny`, headers: f.authHeaders });
    expect(deny.json()).toEqual({ status: 'denied' });

    const expiring = await submit(f, [jira]);
    f.advance(SETUP_REQUEST_LIFETIME_MS + 1);
    const expired = await f.app.inject({ method: 'GET', url: `/api/setup/requests/${expiring.json().requestId}/status` });
    expect(expired.statusCode).toBe(404);
    expect((await approve(f, expiring.json().requestId, { planDigest: expiring.json().planDigest })).statusCode).toBe(404);

    for (let index = 0; index < 10; index += 1) {
      expect((await submit(f, [jira])).statusCode).toBe(202);
    }
    const overflow = await submit(f, [jira]);
    expect(overflow.statusCode).toBe(429);
    expect(overflow.json().error.code).toBe('setup.too_many_pending');
  });

  it('accepts only JSON and validates the declaration', async () => {
    const f = await fixture();
    const form = await f.app.inject({
      method: 'POST', url: '/api/setup/requests',
      headers: { 'content-type': 'text/plain' }, payload: 'source=x',
    });
    expect(form.statusCode).toBe(415);
    const invalid = await submit(f, [{ alias: 'approval_mcp', url: 'https://example.com/mcp' }]);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('input.invalid');
  });
});

describe('declarative upstream setup hardening', () => {
  it('shows the replaced address to the approval page only', async () => {
    const f = await fixture();
    const first = await submit(f, [{ ...jira, credentials: { authorization: SECRET } }]);
    await approve(f, first.json().requestId, { planDigest: first.json().planDigest });

    const moved = await submit(f, [{ ...jira, url: 'https://other.example.com/mcp' }]);
    expect(moved.json().items[0]).not.toHaveProperty('previousUrl');
    const view = await f.app.inject({ method: 'GET', url: `/api/setup/requests/${moved.json().requestId}`, headers: { cookie: f.authHeaders.cookie } });
    expect(view.json().items[0]).toMatchObject({ action: 'update', previousUrl: 'https://jira.example.com/mcp' });
    expect(view.body).not.toContain(SECRET);
    const status = await f.app.inject({ method: 'GET', url: `/api/setup/requests/${moved.json().requestId}/status` });
    expect(status.json().items[0]).not.toHaveProperty('previousUrl');
  });

  it('treats aliases and ids named like Object.prototype members as plain keys', async () => {
    const f = await fixture();
    const created = await submit(f, [
      { alias: 'constructor', url: 'https://a.example.com/mcp' },
      { alias: 'toString', url: 'https://b.example.com/mcp', credentials: { authorization: SECRET } },
    ]);
    expect(created.statusCode).toBe(202);
    const approved = await approve(f, created.json().requestId, { planDigest: created.json().planDigest });
    expect(approved.statusCode).toBe(200);
    expect(f.upstreams().map((upstream) => upstream.alias).sort()).toEqual(['constructor', 'toString']);
    expect(f.upstreams().find((upstream) => upstream.alias === 'constructor')).not.toHaveProperty('credentials');

    for (const id of ['constructor', '__proto__', 'toString']) {
      const status = await f.app.inject({ method: 'GET', url: `/api/setup/requests/${id}/status` });
      expect(status.statusCode).toBe(404);
      expect(status.json().error.code).toBe('setup.request_not_found');
    }
  });

  it('maps framework errors and always sends no-store', async () => {
    const f = await fixture();
    const malformed = await f.app.inject({
      method: 'POST', url: '/api/setup/requests',
      headers: { 'content-type': 'application/json' }, payload: '{"source":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('input.invalid');
    expect(malformed.headers['cache-control']).toBe('no-store');

    const empty = await f.app.inject({
      method: 'POST', url: '/api/setup/requests',
      headers: { 'content-type': 'application/json' }, payload: '',
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe('input.invalid');

    const large = await f.app.inject({
      method: 'POST', url: '/api/setup/requests',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ source: 'x'.repeat(70 * 1024), upstreams: [] }),
    });
    expect(large.statusCode).toBe(413);
    expect(large.json().error.code).toBe('input.too_large');
    expect(large.headers['cache-control']).toBe('no-store');

    const xml = await f.app.inject({
      method: 'POST', url: '/api/setup/requests',
      headers: { 'content-type': 'application/xml' }, payload: '<x/>',
    });
    expect(xml.statusCode).toBe(415);
    expect(xml.json().error.code).toBe('input.unsupported_media_type');
    expect(xml.headers['cache-control']).toBe('no-store');

    const unauthorized = await f.app.inject({ method: 'GET', url: '/api/setup/requests/x' });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers['cache-control']).toBe('no-store');
  });

  it('keeps a decided request readable for a while, then drops it', async () => {
    const f = await fixture();
    const created = await submit(f, [jira]);
    const id: string = created.json().requestId;
    f.advance(SETUP_REQUEST_LIFETIME_MS - 1);
    await approve(f, id, { planDigest: created.json().planDigest });
    f.advance(DECIDED_SETUP_RETENTION_MS - 1);
    expect((await f.app.inject({ method: 'GET', url: `/api/setup/requests/${id}/status` })).json().status).toBe('applied');
    f.advance(1);
    expect((await f.app.inject({ method: 'GET', url: `/api/setup/requests/${id}/status` })).statusCode).toBe(404);
  });
});
