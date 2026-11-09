import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonValue, Upstream, UpstreamId } from '@approval-mcp/contracts';
import {
  createConfigStateStore,
  createNodeFileOperations,
  type StateStoreFileOperations,
} from '@approval-mcp/state-store';
import { CredentialVault } from '@approval-mcp/upstream';
import { afterEach, describe, expect, it } from 'vitest';

import { registerUpstreamRoutes } from '../admin/upstream-routes.js';
import { buildServerApp } from '../app.js';
import { InMemoryRecoveryRepository, RecoveryService } from '../recovery-service.js';
import { InMemorySessionRepository, SessionService } from '../session-store.js';
import { registerSetupRoutes } from './setup-routes.js';
import {
  DECIDED_SETUP_RETENTION_MS,
  MAX_PENDING_SETUP_REQUESTS_PER_TOKEN,
  SETUP_REQUEST_LIFETIME_MS,
  SetupService,
} from './setup-service.js';

const SECRET = 'Bearer secret-token-123';
const TOKENS: Record<string, { id: string; label: string }> = {
  'token-a': { id: 'a', label: 'Agent A' },
  'token-b': { id: 'b', label: 'Agent B' },
};
const apps: Awaited<ReturnType<typeof buildServerApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** File operations whose durable append can be held, to keep a write in flight. */
function gatedFiles() {
  const node = createNodeFileOperations();
  let gate: Promise<void> | undefined;
  let release = () => {};
  const files: StateStoreFileOperations = {
    ...node,
    appendDurable: async (path, contents) => {
      if (gate !== undefined) await gate;
      await node.appendDurable(path, contents);
    },
  };
  return {
    files,
    hold: () => { gate = new Promise((resolve) => { release = resolve; }); },
    release: () => { gate = undefined; release(); },
  };
}

async function fixture(options: { passkeyAdminId?: string } = {}) {
  const io = gatedFiles();
  const store = await createConfigStateStore(await mkdtemp(join(tmpdir(), 'approval-setup-')), io.files);
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
  await registerSetupRoutes(app, {
    setup,
    passkeys,
    sessions,
    authenticateRequester: async (token) => (Object.hasOwn(TOKENS, token) ? TOKENS[token] : undefined),
  });
  await registerUpstreamRoutes(app, { sessions, state: store, credentialVault: vault });
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
    io,
    authHeaders,
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    upstreamChanges: () => upstreamChanges,
    upstreams: () => store.read((state) =>
      Object.values(state.upstreams).map((value) => value as unknown as Upstream)),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const jira = { alias: 'jira', url: 'https://jira.example.com/mcp', displayName: 'Jira' };

function submit(f: Fixture, upstreams: unknown[], token = 'token-a') {
  return f.app.inject({
    method: 'POST',
    url: '/api/setup/requests',
    headers: { authorization: `Bearer ${token}` },
    payload: { source: 'usy_smarta_agentg01', upstreams },
  });
}

function status(f: Fixture, id: string, token = 'token-a') {
  return f.app.inject({
    method: 'GET',
    url: `/api/setup/requests/${id}/status`,
    headers: { authorization: `Bearer ${token}` },
  });
}

/** The admin's approval view, which carries the plan digest the approval is bound to. */
async function view(f: Fixture, id: string) {
  return f.app.inject({ method: 'GET', url: `/api/setup/requests/${id}`, headers: { cookie: f.authHeaders.cookie } });
}

async function digest(f: Fixture, id: string): Promise<string> {
  return (await view(f, id)).json().planDigest;
}

function approve(f: Fixture, id: string, body: Record<string, unknown>) {
  return f.app.inject({
    method: 'POST',
    url: `/api/setup/requests/${id}/approve`,
    headers: f.authHeaders,
    payload: { passkey: { id: 'passkey' }, ...body },
  });
}

/** Submits and approves in one step, returning the approval response. */
async function apply(f: Fixture, upstreams: unknown[], body: Record<string, unknown> = {}) {
  const id: string = (await submit(f, upstreams)).json().requestId;
  return approve(f, id, { planDigest: await digest(f, id), ...body });
}

async function seed(f: Fixture, upstream: Partial<Upstream> & { id: string }) {
  const now = new Date().toISOString();
  const record = {
    alias: 'jira', url: 'https://jira.example.com/mcp', allowPrivateNetwork: false,
    schemaVersion: 1, createdAt: now, updatedAt: now, version: 1, ...upstream,
  };
  await f.store.mutate({ type: 'record.upserted', collection: 'upstreams', id: record.id, value: record as unknown as JsonValue });
  return record as Upstream;
}

describe('declarative upstream setup API', () => {
  it('creates an upstream with credentials sent in the call after passkey approval', async () => {
    const f = await fixture();
    const created = await submit(f, [{ ...jira, credentials: { authorization: SECRET } }]);
    expect(created.statusCode).toBe(202);
    expect(created.body).not.toContain(SECRET);
    const { requestId, approvalUrl, items } = created.json();
    expect(approvalUrl).toBe(`http://localhost:3000/setup/requests/${requestId}`);
    expect(items).toEqual([{ alias: 'jira', action: 'create' }]);

    const pending = await view(f, requestId);
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({
      source: 'usy_smarta_agentg01',
      requestedWith: 'Agent A',
      items: [{ alias: 'jira', action: 'create', credentials: 'provided' }],
    });
    expect(pending.body).not.toContain(SECRET);

    const approved = await approve(f, requestId, { planDigest: pending.json().planDigest });
    expect(approved.statusCode).toBe(200);
    expect(approved.body).not.toContain(SECRET);
    expect(approved.json()).toMatchObject({ status: 'applied', results: [{ alias: 'jira', action: 'create' }] });

    const [stored] = f.upstreams();
    expect(stored).toMatchObject({ alias: 'jira', url: 'https://jira.example.com/mcp', displayName: 'Jira', managedBy: 'usy_smarta_agentg01', version: 1 });
    expect(f.vault.decrypt(stored!.id, stored!.credentials!)).toEqual({ authorization: SECRET });
    expect(f.upstreamChanges()).toBe(1);

    const progress = await status(f, requestId);
    expect(progress.json()).toEqual({
      status: 'applied',
      items: [{ alias: 'jira', action: 'create' }],
      results: [{ alias: 'jira', action: 'create' }],
    });
  });

  it('answers unchanged for a repeated declaration and creates no duplicate', async () => {
    const f = await fixture();
    await apply(f, [{ ...jira, credentials: { authorization: SECRET } }]);
    const again = await submit(f, [{ ...jira, credentials: { authorization: SECRET } }]);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ status: 'unchanged', items: [{ alias: 'jira', action: 'unchanged' }] });
    expect(f.upstreams()).toHaveLength(1);
  });

  it('requires the operator to enter credentials when the call does not carry them', async () => {
    const f = await fixture();
    const requestId: string = (await submit(f, [{ ...jira, credentialsRequired: true }])).json().requestId;
    const pending = (await view(f, requestId)).json();
    expect(pending.items[0]).toMatchObject({ credentials: 'required' });
    const planDigest = pending.planDigest;

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
    const approved = await apply(f, [{ alias: 'k8s', url: 'http://k8s-mcp:8080/mcp', allowPrivateNetwork: true }]);
    expect(approved.statusCode).toBe(200);
    expect(f.upstreams()[0]).toMatchObject({ alias: 'k8s', allowPrivateNetwork: true });
    expect(f.upstreams()[0]).not.toHaveProperty('credentials');
  });

  it('does not carry stored credentials to a changed URL', async () => {
    const f = await fixture();
    await apply(f, [{ ...jira, credentials: { authorization: SECRET } }]);

    const movedId: string = (await submit(f, [{ ...jira, url: 'https://other.example.com/mcp' }])).json().requestId;
    const pending = (await view(f, movedId)).json();
    expect(pending.items[0]).toMatchObject({ action: 'update', credentials: 'remove', changes: ['url', 'credentials'] });
    await approve(f, movedId, { planDigest: pending.planDigest });
    const [stored] = f.upstreams();
    expect(stored).toMatchObject({ url: 'https://other.example.com/mcp', version: 2 });
    expect(stored).not.toHaveProperty('credentials');
  });

  it('rejects a plan that became stale before approval', async () => {
    const f = await fixture();
    const requestId: string = (await submit(f, [jira])).json().requestId;
    const planDigest = await digest(f, requestId);
    const manual = await seed(f, { id: 'manual', url: 'https://manual.example.com/mcp' });

    const stale = await approve(f, requestId, { planDigest });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('setup.plan_stale');
    expect(f.upstreams()).toEqual([manual]);
    expect((await status(f, requestId)).statusCode).toBe(404);
  });

  it('marks the request stale when the plan can no longer be computed', async () => {
    const f = await fixture();
    const requestId: string = (await submit(f, [jira])).json().requestId;
    const planDigest = await digest(f, requestId);
    await seed(f, { id: 'a' });
    await seed(f, { id: 'b' });
    const stale = await approve(f, requestId, { planDigest });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('setup.plan_stale');
  });

  it('keeps the plugin assigned in the admin UI', async () => {
    const f = await fixture();
    await seed(f, { id: 'u', pluginId: 'jira', pluginVersion: '1.0.0' });
    await apply(f, [{ ...jira, displayName: 'Jira (work)' }]);
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
    const requestId: string = (await submit(f, [jira])).json().requestId;
    const planDigest = await digest(f, requestId);
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

  it('denies and expires requests', async () => {
    const f = await fixture();
    const denied = await submit(f, [jira]);
    const deny = await f.app.inject({ method: 'POST', url: `/api/setup/requests/${denied.json().requestId}/deny`, headers: f.authHeaders });
    expect(deny.json()).toEqual({ status: 'denied' });
    expect((await status(f, denied.json().requestId)).json().status).toBe('denied');

    const expiring: string = (await submit(f, [{ ...jira, displayName: 'Other' }])).json().requestId;
    const planDigest = await digest(f, expiring);
    f.advance(SETUP_REQUEST_LIFETIME_MS + 1);
    expect((await status(f, expiring)).statusCode).toBe(404);
    expect((await approve(f, expiring, { planDigest })).statusCode).toBe(404);
  });

  it('accepts only JSON and validates the declaration', async () => {
    const f = await fixture();
    const form = await f.app.inject({
      method: 'POST', url: '/api/setup/requests',
      headers: { 'content-type': 'text/plain', authorization: 'Bearer token-a' }, payload: 'source=x',
    });
    expect(form.statusCode).toBe(415);
    const invalid = await submit(f, [{ alias: 'approval_mcp', url: 'https://example.com/mcp' }]);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('input.invalid');
  });

  it('keeps a decided request readable for a while, then drops it', async () => {
    const f = await fixture();
    const id: string = (await submit(f, [jira])).json().requestId;
    const planDigest = await digest(f, id);
    f.advance(SETUP_REQUEST_LIFETIME_MS - 1);
    await approve(f, id, { planDigest });
    f.advance(DECIDED_SETUP_RETENTION_MS - 1);
    expect((await status(f, id)).json().status).toBe('applied');
    f.advance(1);
    expect((await status(f, id)).statusCode).toBe(404);
  });
});

describe('requester identity and stored configuration', () => {
  it('requires a client token to submit or read progress', async () => {
    const f = await fixture();
    const anonymous = await f.app.inject({
      method: 'POST', url: '/api/setup/requests', payload: { source: 'x', upstreams: [jira] },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe('auth.token_required');
    expect((await submit(f, [jira], 'unknown')).statusCode).toBe(401);

    const id: string = (await submit(f, [jira])).json().requestId;
    expect((await f.app.inject({ method: 'GET', url: `/api/setup/requests/${id}/status` })).statusCode).toBe(401);
    expect((await status(f, id, 'token-b')).statusCode).toBe(404);
    expect((await status(f, id, 'token-a')).statusCode).toBe(200);
  });

  it('does not reveal stored values of an existing upstream to the requester', async () => {
    const f = await fixture();
    await seed(f, {
      id: 'internal-id',
      displayName: 'Internal Jira',
      description: 'Finance team only',
      metadata: { owner: 'finance' },
      credentials: f.vault.encrypt('internal-id' as UpstreamId, { authorization: SECRET }),
      version: 7,
    });
    const created = await submit(f, [{ alias: 'jira', url: 'https://probe.example.com/mcp' }]);
    expect(created.statusCode).toBe(202);
    expect(created.json().items).toEqual([{ alias: 'jira', action: 'update' }]);
    const progress = await status(f, created.json().requestId);
    for (const body of [created.body, progress.body]) {
      for (const hidden of ['Internal Jira', 'Finance team only', 'finance', 'internal-id', 'baseVersion', 'credentials', 'planDigest', 'jira.example.com']) {
        expect(body).not.toContain(hidden);
      }
    }
    // The admin still sees everything needed to decide.
    expect((await view(f, created.json().requestId)).json().items[0]).toMatchObject({
      desired: { displayName: 'Internal Jira', metadata: { owner: 'finance' } },
      previousUrl: 'https://jira.example.com/mcp',
      credentials: 'remove',
    });
  });

  it('limits pending requests per token, so one requester cannot block the others', async () => {
    const f = await fixture();
    const ids = new Set<string>();
    for (let index = 0; index < MAX_PENDING_SETUP_REQUESTS_PER_TOKEN; index += 1) {
      const created = await submit(f, [{ ...jira, displayName: `Jira ${index}` }]);
      expect(created.statusCode).toBe(202);
      ids.add(created.json().requestId);
    }
    expect(ids.size).toBe(MAX_PENDING_SETUP_REQUESTS_PER_TOKEN);
    const overflow = await submit(f, [{ ...jira, displayName: 'One more' }]);
    expect(overflow.statusCode).toBe(429);
    expect(overflow.json().error.code).toBe('setup.too_many_pending');

    expect((await submit(f, [{ ...jira, displayName: 'One more' }], 'token-b')).statusCode).toBe(202);
  });

  it('reuses the pending request only for an identical submission', async () => {
    const f = await fixture();
    const first = await submit(f, [{ ...jira, credentials: { authorization: SECRET } }]);
    for (let index = 0; index < MAX_PENDING_SETUP_REQUESTS_PER_TOKEN + 2; index += 1) {
      const again = await submit(f, [{ ...jira, credentials: { authorization: SECRET } }]);
      expect(again.json().requestId).toBe(first.json().requestId);
    }
    expect((await submit(f, [{ ...jira, displayName: 'Other' }])).statusCode).toBe(202);
  });

  it('never lets a reviewed digest approve a request with changed credentials', async () => {
    const f = await fixture();
    const original: string = (await submit(f, [{ ...jira, credentials: { authorization: 'Bearer reviewed' } }])).json().requestId;
    const planDigest: string = await digest(f, original);

    const changed = await submit(f, [{ ...jira, credentials: { authorization: 'Bearer swapped' } }]);
    expect(changed.statusCode).toBe(202);
    const changedId: string = changed.json().requestId;
    expect(changedId).not.toBe(original);
    for (const body of [changed.body, (await view(f, changedId)).body, (await view(f, original)).body]) {
      expect(body).not.toContain('Bearer reviewed');
      expect(body).not.toContain('Bearer swapped');
    }

    const swapped = await approve(f, changedId, { planDigest });
    expect(swapped.statusCode).toBe(409);
    expect(swapped.json().error.code).toBe('setup.plan_mismatch');
    expect(f.upstreams()).toHaveLength(0);

    // The reviewed digest approves exactly the reviewed content.
    expect((await approve(f, original, { planDigest })).statusCode).toBe(200);
    const [stored] = f.upstreams();
    expect(f.vault.decrypt(stored!.id, stored!.credentials!)).toEqual({ authorization: 'Bearer reviewed' });
  });
});

describe('concurrent upstream writes', () => {
  it('rejects the setup plan when an admin edit is still being written', async () => {
    const f = await fixture();
    await seed(f, { id: 'u', url: 'https://v1.example.com/mcp' });
    const id: string = (await submit(f, [{ alias: 'jira', url: 'https://v1.example.com/mcp', displayName: 'Jira' }])).json().requestId;
    const planDigest = await digest(f, id);

    f.io.hold();
    const adminEdit = f.app.inject({
      method: 'PUT', url: '/api/admin/upstreams/u', headers: f.authHeaders,
      payload: { version: 1, url: 'https://v2.example.com/mcp' },
    });
    // Wait until the admin write is queued, but not yet durable.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.upstreams()[0]).toMatchObject({ url: 'https://v1.example.com/mcp', version: 1 });
    const setupApproval = approve(f, id, { planDigest });
    f.io.release();

    expect((await adminEdit).statusCode).toBe(200);
    const approval = await setupApproval;
    expect(approval.statusCode).toBe(409);
    expect(approval.json().error.code).toBe('setup.plan_stale');
    expect(f.upstreams()[0]).toMatchObject({ url: 'https://v2.example.com/mcp', version: 2 });
  });

  it('rejects an admin edit based on the version a setup is replacing', async () => {
    const f = await fixture();
    await seed(f, { id: 'u', url: 'https://v1.example.com/mcp' });
    const id: string = (await submit(f, [{ alias: 'jira', url: 'https://setup.example.com/mcp' }])).json().requestId;
    const planDigest = await digest(f, id);

    f.io.hold();
    const setupApproval = approve(f, id, { planDigest });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const adminEdit = f.app.inject({
      method: 'PUT', url: '/api/admin/upstreams/u', headers: f.authHeaders,
      payload: { version: 1, url: 'https://admin.example.com/mcp' },
    });
    f.io.release();

    expect((await setupApproval).statusCode).toBe(200);
    const edit = await adminEdit;
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error.code).toBe('state.version_conflict');
    expect(f.upstreams()[0]).toMatchObject({ url: 'https://setup.example.com/mcp', version: 2 });
  });

  /** Starts `first`, keeps its durable write in flight, then starts `second`. */
  async function race<A, B>(f: Fixture, first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
    f.io.hold();
    const a = first();
    // Let the first write reach the held durable append.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b = second();
    f.io.release();
    return [await a, await b];
  }

  const adminCreate = (f: Fixture, alias: string) => f.app.inject({
    method: 'POST', url: '/api/admin/upstreams', headers: f.authHeaders,
    payload: { alias, url: 'https://admin.example.com/mcp', allowPrivateNetwork: false },
  });

  const adminRename = (f: Fixture, id: string, alias: string) => f.app.inject({
    method: 'PUT', url: `/api/admin/upstreams/${id}`, headers: f.authHeaders,
    payload: { version: 1, alias },
  });

  async function pendingCreate(f: Fixture) {
    const id: string = (await submit(f, [jira])).json().requestId;
    return { id, planDigest: await digest(f, id) };
  }

  it('rejects a setup create when an admin create of the same alias is being written', async () => {
    const f = await fixture();
    const request = await pendingCreate(f);
    const [created, approval] = await race(f,
      () => adminCreate(f, 'jira'),
      () => approve(f, request.id, { planDigest: request.planDigest }));
    expect(created.statusCode).toBe(201);
    expect(approval.statusCode).toBe(409);
    expect(approval.json().error.code).toBe('setup.plan_stale');
    expect(f.upstreams().map((upstream) => upstream.url)).toEqual(['https://admin.example.com/mcp']);
  });

  it('rejects an admin create of an alias that a setup approval is writing', async () => {
    const f = await fixture();
    const request = await pendingCreate(f);
    const [approval, created] = await race(f,
      () => approve(f, request.id, { planDigest: request.planDigest }),
      () => adminCreate(f, 'jira'));
    expect(approval.statusCode).toBe(200);
    expect(created.statusCode).toBe(409);
    expect(created.json().error.code).toBe('upstream.alias_conflict');
    expect(f.upstreams().map((upstream) => upstream.url)).toEqual(['https://jira.example.com/mcp']);
  });

  it('rejects a setup create when an admin rename to the same alias is being written', async () => {
    const f = await fixture();
    await seed(f, { id: 'other', alias: 'other', url: 'https://other.example.com/mcp' });
    const request = await pendingCreate(f);
    const [renamed, approval] = await race(f,
      () => adminRename(f, 'other', 'jira'),
      () => approve(f, request.id, { planDigest: request.planDigest }));
    expect(renamed.statusCode).toBe(200);
    expect(approval.statusCode).toBe(409);
    expect(approval.json().error.code).toBe('setup.plan_stale');
    expect(f.upstreams().map((upstream) => `${upstream.alias} ${upstream.url}`)).toEqual(['jira https://other.example.com/mcp']);
  });

  it('rejects an admin rename to an alias that a setup approval is writing', async () => {
    const f = await fixture();
    await seed(f, { id: 'other', alias: 'other', url: 'https://other.example.com/mcp' });
    const request = await pendingCreate(f);
    const [approval, renamed] = await race(f,
      () => approve(f, request.id, { planDigest: request.planDigest }),
      () => adminRename(f, 'other', 'jira'));
    expect(approval.statusCode).toBe(200);
    expect(renamed.statusCode).toBe(409);
    expect(renamed.json().error.code).toBe('upstream.alias_conflict');
    expect(f.upstreams().map((upstream) => upstream.alias).sort()).toEqual(['jira', 'other']);
  });

  it('rejects invalid aliases before storing them, in setup and in admin creates and renames', async () => {
    const f = await fixture();
    await seed(f, { id: 'other', alias: 'other' });
    for (const alias of ['Jira', 'jira__shadow', 'jira-']) {
      const created = await adminCreate(f, alias);
      expect(created.statusCode, alias).toBe(400);
      expect(created.json().error.code).toBe('input.invalid');
      const renamed = await adminRename(f, 'other', alias);
      expect(renamed.statusCode, alias).toBe(400);
      const declared = await submit(f, [{ alias, url: 'https://x.example.com/mcp' }]);
      expect(declared.statusCode, alias).toBe(400);
    }
    expect(f.upstreams().map((upstream) => upstream.alias)).toEqual(['other']);
    for (const alias of ['a', `a${'b'.repeat(62)}c`, 'jira_cloud']) {
      expect((await adminCreate(f, alias)).statusCode, alias).toBe(201);
    }
  });

  it('keeps an upstream stored with an invalid alias editable and renamable', async () => {
    const f = await fixture();
    await seed(f, { id: 'legacy', alias: 'Legacy' });
    const edited = await f.app.inject({
      method: 'PUT', url: '/api/admin/upstreams/legacy', headers: f.authHeaders,
      payload: { version: 1, alias: 'Legacy', displayName: 'Old one' },
    });
    expect(edited.statusCode).toBe(200);
    const renamed = await f.app.inject({
      method: 'PUT', url: '/api/admin/upstreams/legacy', headers: f.authHeaders,
      payload: { version: 2, alias: 'legacy' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(f.upstreams()[0]).toMatchObject({ alias: 'legacy', displayName: 'Old one', version: 3 });
  });

  it('rejects admin creates and renames to an alias already in use', async () => {
    const f = await fixture();
    await seed(f, { id: 'u' });
    await seed(f, { id: 'other', alias: 'other' });
    expect((await adminCreate(f, 'jira')).statusCode).toBe(409);
    expect((await adminRename(f, 'other', 'jira')).json().error.code).toBe('upstream.alias_conflict');
    // Keeping its own alias is not a conflict.
    expect((await adminRename(f, 'u', 'jira')).statusCode).toBe(200);
    expect(f.upstreams().map((upstream) => upstream.alias).sort()).toEqual(['jira', 'other']);
  });

  it('treats aliases and ids named like Object.prototype members as plain keys', async () => {
    const f = await fixture();
    // `constructor` is the only Object.prototype member that is also a valid alias.
    const approved = await apply(f, [
      { alias: 'constructor', url: 'https://a.example.com/mcp' },
      { alias: 'other', url: 'https://b.example.com/mcp', credentials: { authorization: SECRET } },
    ]);
    expect(approved.statusCode).toBe(200);
    expect(f.upstreams().map((upstream) => upstream.alias).sort()).toEqual(['constructor', 'other']);
    expect(f.upstreams().find((upstream) => upstream.alias === 'constructor')).not.toHaveProperty('credentials');

    for (const id of ['constructor', '__proto__', 'toString']) {
      const progress = await status(f, id);
      expect(progress.statusCode).toBe(404);
      expect(progress.json().error.code).toBe('setup.request_not_found');
    }
  });
});

describe('declarative upstream setup hardening', () => {
  it('shows the replaced address to the approval page only', async () => {
    const f = await fixture();
    await apply(f, [{ ...jira, credentials: { authorization: SECRET } }]);
    const moved = await submit(f, [{ ...jira, url: 'https://other.example.com/mcp' }]);
    expect(moved.body).not.toContain('previousUrl');
    const pending = await view(f, moved.json().requestId);
    expect(pending.json().items[0]).toMatchObject({ action: 'update', previousUrl: 'https://jira.example.com/mcp' });
    expect(pending.body).not.toContain(SECRET);
    expect((await status(f, moved.json().requestId)).body).not.toContain('previousUrl');
  });

  it('maps framework errors and always sends no-store', async () => {
    const f = await fixture();
    const json = { 'content-type': 'application/json', authorization: 'Bearer token-a' };
    const malformed = await f.app.inject({ method: 'POST', url: '/api/setup/requests', headers: json, payload: '{"source":' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('input.invalid');
    expect(malformed.headers['cache-control']).toBe('no-store');

    const empty = await f.app.inject({ method: 'POST', url: '/api/setup/requests', headers: json, payload: '' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe('input.invalid');

    const large = await f.app.inject({
      method: 'POST', url: '/api/setup/requests', headers: json,
      payload: JSON.stringify({ source: 'x'.repeat(70 * 1024), upstreams: [] }),
    });
    expect(large.statusCode).toBe(413);
    expect(large.json().error.code).toBe('input.too_large');
    expect(large.headers['cache-control']).toBe('no-store');

    const xml = await f.app.inject({
      method: 'POST', url: '/api/setup/requests',
      headers: { 'content-type': 'application/xml', authorization: 'Bearer token-a' }, payload: '<x/>',
    });
    expect(xml.statusCode).toBe(415);
    expect(xml.json().error.code).toBe('input.unsupported_media_type');
    expect(xml.headers['cache-control']).toBe('no-store');

    const unauthorized = await f.app.inject({ method: 'GET', url: '/api/setup/requests/x' });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers['cache-control']).toBe('no-store');
  });
});
