import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CallJournal } from '@approval-mcp/call-journal';
import { createConfigStateStore } from '@approval-mcp/state-store';
import { CredentialVault } from '@approval-mcp/upstream';
import {
  StateStoreTokenRepository,
  TokenService,
} from '@approval-mcp/gateway';
import { afterEach, describe, expect, it } from 'vitest';

import { buildServerApp } from '../app.js';
import {
  InMemoryRecoveryRepository,
  RecoveryService,
} from '../recovery-service.js';
import {
  InMemorySessionRepository,
  SessionService,
} from '../session-store.js';
import { registerAdminRoutes } from './index.js';

const apps: Awaited<ReturnType<typeof buildServerApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture(options?: {
  plugins?: readonly Readonly<{
    id: string;
    version: string;
    normalizationVersion: number;
  }>[];
  discoverTools?(upstreamId: string): Promise<{
    upstreamId: string;
    refreshedAt: string;
    tools: readonly {
      name: string;
      inputSchema: Record<string, unknown>;
    }[];
  }>;
  onUpstreamsChanged?(): Promise<void>;
  journal?: CallJournal;
  seed?(store: Awaited<ReturnType<typeof createConfigStateStore>>): Promise<void>;
}) {
  const store = await createConfigStateStore(
    await mkdtemp(join(tmpdir(), 'approval-admin-api-')),
  );
  const sessions = new SessionService(new InMemorySessionRepository());
  const session = await sessions.create('admin');
  const app = await buildServerApp({
    auth: {
      passkeys: {
        bootstrapOptions: async () => ({}),
        verifyBootstrap: async () => ({ adminId: 'admin' }),
        loginOptions: async () => ({}),
        verifyLogin: async () => ({ adminId: 'admin' }),
      },
      sessions,
      recovery: new RecoveryService(new InMemoryRecoveryRepository()),
      secureCookies: true,
    },
  });
  await options?.seed?.(store);
  await registerAdminRoutes(app, {
    sessions,
    state: store,
    tokens: new TokenService(new StateStoreTokenRepository(store)),
    journal: options?.journal,
    discoverTools: options?.discoverTools,
    credentialVault: new CredentialVault(Buffer.alloc(32, 7)),
    onUpstreamsChanged: options?.onUpstreamsChanged,
    plugins: options?.plugins,
  });
  apps.push(app);
  return {
    app,
    authHeaders: {
      cookie: `amcp_admin=${session.plaintext}`,
      'x-csrf-token': session.csrfToken,
    },
    store,
  };
}

describe('admin API', () => {
  it('exposes self tools in profile rules and issues manager tokens only when explicitly requested', async () => {
    const { app, authHeaders } = await fixture();
    const catalog = await app.inject({
      method: 'GET', url: '/api/admin/self/tools',
      headers: { cookie: authHeaders.cookie },
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().tools.map((tool: { name: string }) => tool.name)).toContain('list_history');

    const profiles = await app.inject({
      method: 'GET', url: '/api/admin/profiles',
      headers: { cookie: authHeaders.cookie },
    });
    const profileId = profiles.json()[0].id as string;
    const rule = await app.inject({
      method: 'PUT', url: `/api/admin/profiles/${profileId}/rules`,
      headers: authHeaders,
      payload: { upstreamId: 'approval-mcp-self', toolName: 'list_history', outcome: 'allow' },
    });
    expect(rule.statusCode).toBe(200);
    const invalidRule = await app.inject({
      method: 'PUT', url: `/api/admin/profiles/${profileId}/rules`,
      headers: authHeaders,
      payload: { upstreamId: 'approval-mcp-self', toolName: 'unknown', outcome: 'allow' },
    });
    expect(invalidRule.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST', url: '/api/admin/tokens', headers: authHeaders,
      payload: { label: 'Manager', canManageApprovalMcp: true },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().record.canManageApprovalMcp).toBe(true);
  });

  it('lists exact plugin pins and stores one on an upstream', async () => {
    const { app, authHeaders } = await fixture({
      plugins: [
        { id: 'minutes', version: '1.0.0', normalizationVersion: 1 },
      ],
    });

    const plugins = await app.inject({
      method: 'GET',
      url: '/api/admin/plugins',
      headers: { cookie: authHeaders.cookie },
    });
    expect(plugins.json()).toEqual([
      { id: 'minutes', version: '1.0.0', normalizationVersion: 1 },
    ]);

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/upstreams',
      headers: authHeaders,
      payload: {
        alias: 'minutes',
        url: 'http://127.0.0.1:3333/mcp',
        allowPrivateNetwork: true,
        pluginId: 'minutes',
        pluginVersion: '1.0.0',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual(
      expect.objectContaining({
        pluginId: 'minutes',
        pluginVersion: '1.0.0',
      }),
    );

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/admin/upstreams',
      headers: authHeaders,
      payload: {
        alias: 'unknown',
        url: 'http://127.0.0.1:4444/mcp',
        allowPrivateNetwork: true,
        pluginId: 'minutes',
        pluginVersion: '9.0.0',
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: { code: 'plugin.invalid_pin' },
    });
  });

  it('backfills the default tool timeout on existing profiles', async () => {
    const now = '2026-07-30T00:00:00.000Z';
    const { app, authHeaders, store } = await fixture({
      seed: async (state) => {
        await state.mutate({
          type: 'record.upserted',
          collection: 'profiles',
          id: 'legacy-default',
          value: {
            id: 'legacy-default',
            name: 'Default',
            isDefault: true,
            schemaVersion: 1,
            createdAt: now,
            updatedAt: now,
            version: 1,
          },
        });
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/profiles',
      headers: { cookie: authHeaders.cookie },
    });

    expect(response.json()).toEqual([
      expect.objectContaining({
        id: 'legacy-default',
        approvalTimeoutSeconds: 60,
        toolCallTimeoutSeconds: 60,
        version: 2,
      }),
    ]);
    expect(store.read((state) => state.profiles['legacy-default'])).toEqual(
      expect.objectContaining({
        approvalTimeoutSeconds: 60,
        toolCallTimeoutSeconds: 60,
      }),
    );
  });

  it('migrates existing token policies into an assigned profile', async () => {
    const now = '2026-07-30T00:00:00.000Z';
    const { app, authHeaders, store } = await fixture({
      seed: async (state) => {
        await state.mutate({
          type: 'records.batch',
          operations: [
            {
              type: 'record.upserted',
              collection: 'clientTokens',
              id: 'legacy-token',
              value: {
                id: 'legacy-token',
                label: 'Existing agent',
                hash: 'hash',
                salt: 'salt',
                schemaVersion: 1,
                createdAt: now,
                updatedAt: now,
                version: 1,
              },
            },
            {
              type: 'record.upserted',
              collection: 'policies',
              id: 'legacy-policy',
              value: {
                id: 'legacy-policy',
                clientTokenId: 'legacy-token',
                upstreamId: 'signal',
                toolName: 'get_messages',
                outcome: 'require_approval',
                predicates: [],
                enabled: true,
                schemaVersion: 1,
                createdAt: now,
                updatedAt: now,
                version: 1,
              },
            },
            {
              type: 'record.upserted',
              collection: 'policies',
              id: 'legacy-deny',
              value: {
                id: 'legacy-deny',
                clientTokenId: 'legacy-token',
                upstreamId: 'signal',
                toolName: 'get_messages',
                outcome: 'deny',
                predicates: [],
                enabled: true,
                schemaVersion: 1,
                createdAt: now,
                updatedAt: now,
                version: 1,
              },
            },
          ],
        });
      },
    });

    const profiles = await app.inject({
      method: 'GET',
      url: '/api/admin/profiles',
      headers: { cookie: authHeaders.cookie },
    });

    expect(profiles.json()).toEqual([
      expect.objectContaining({ name: 'Default', isDefault: true }),
      expect.objectContaining({ name: 'Migrated: Existing agent' }),
      expect.objectContaining({ name: 'Migrated: Existing agent (2)' }),
    ]);
    expect(
      store.read((state) => ({
        legacyPolicy: state.policies['legacy-policy'],
        rules: Object.values(state.profileRules),
        assignments: Object.values(state.tokenProfileAssignments),
      })),
    ).toEqual({
      legacyPolicy: undefined,
      rules: [
        expect.objectContaining({
          toolName: 'get_messages',
          outcome: 'require_approval',
        }),
        expect.objectContaining({
          toolName: 'get_messages',
          outcome: 'deny',
        }),
      ],
      assignments: [
        expect.objectContaining({ clientTokenId: 'legacy-token' }),
        expect.objectContaining({ clientTokenId: 'legacy-token' }),
      ],
    });
    expect(
      store.read((state) =>
        new Set(
          Object.values(state.profileRules).map(
            (rule) => (rule as { profileId: string }).profileId,
          ),
        ).size,
      ),
    ).toBe(2);
  });

  it('manages profiles, hierarchical rules, and multiple token assignments', async () => {
    const { app, authHeaders } = await fixture();
    const defaults = await app.inject({
      method: 'GET',
      url: '/api/admin/profiles',
      headers: { cookie: authHeaders.cookie },
    });
    expect(defaults.json()).toEqual([
      expect.objectContaining({
        name: 'Default',
        isDefault: true,
        approvalTimeoutSeconds: 60,
        toolCallTimeoutSeconds: 60,
      }),
    ]);

    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/admin/tokens',
      headers: authHeaders,
      payload: { label: 'Claude Code' },
    });
    const tokenId = tokenResponse.json<{ record: { id: string } }>().record.id;
    const upstreamResponse = await app.inject({
      method: 'POST',
      url: '/api/admin/upstreams',
      headers: authHeaders,
      payload: {
        alias: 'signal',
        url: 'https://signal.example/mcp',
        allowPrivateNetwork: false,
      },
    });
    const upstreamId = upstreamResponse.json<{ id: string }>().id;
    const profileResponse = await app.inject({
      method: 'POST',
      url: '/api/admin/profiles',
      headers: authHeaders,
      payload: { name: 'Messaging' },
    });
    const profile = profileResponse.json<{ id: string }>();
    const secondResponse = await app.inject({
      method: 'POST',
      url: '/api/admin/profiles',
      headers: authHeaders,
      payload: { name: 'Read only' },
    });
    const second = secondResponse.json<{ id: string }>();

    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/admin/profiles/${profile.id}/rules`,
          headers: authHeaders,
          payload: { upstreamId, outcome: 'allow' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/admin/profiles/${profile.id}/rules/bulk`,
          headers: authHeaders,
          payload: {
            upstreamId,
            toolNames: ['get_messages', 'list_groups'],
            outcome: 'allow',
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/admin/profiles/${profile.id}/rules`,
          headers: authHeaders,
          payload: {
            upstreamId,
            toolName: 'send_message',
            outcome: 'require_approval',
          },
        })
      ).statusCode,
    ).toBe(200);

    const rules = await app.inject({
      method: 'GET',
      url: `/api/admin/profiles/${profile.id}/rules`,
      headers: { cookie: authHeaders.cookie },
    });
    expect(rules.json()).toEqual([
      expect.objectContaining({ outcome: 'allow' }),
      expect.objectContaining({ toolName: 'get_messages', outcome: 'allow' }),
      expect.objectContaining({ toolName: 'list_groups', outcome: 'allow' }),
      expect.objectContaining({
        toolName: 'send_message',
        outcome: 'require_approval',
      }),
    ]);

    const assigned = await app.inject({
      method: 'PUT',
      url: `/api/admin/tokens/${tokenId}/profiles`,
      headers: authHeaders,
      payload: { profileIds: [profile.id, second.id] },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toEqual({ profileIds: [profile.id, second.id] });

    const tokens = await app.inject({
      method: 'GET',
      url: '/api/admin/tokens',
      headers: { cookie: authHeaders.cookie },
    });
    expect(
      tokens
        .json<{ id: string; profileIds: string[] }[]>()
        .find((token) => token.id === tokenId)?.profileIds,
    ).toEqual([profile.id, second.id]);
  });

  it('creates, validates, and updates both per-profile timeouts', async () => {
    const { app, authHeaders } = await fixture();
    const defaultedResponse = await app.inject({
      method: 'POST',
      url: '/api/admin/profiles',
      headers: authHeaders,
      payload: { name: 'Standard' },
    });
    expect(defaultedResponse.statusCode).toBe(201);
    expect(defaultedResponse.json()).toEqual(
      expect.objectContaining({
        approvalTimeoutSeconds: 60,
        toolCallTimeoutSeconds: 60,
      }),
    );

    const createdResponse = await app.inject({
      method: 'POST',
      url: '/api/admin/profiles',
      headers: authHeaders,
      payload: {
        name: 'Long running',
        approvalTimeoutSeconds: 600,
        toolCallTimeoutSeconds: 1_800,
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json<{
      id: string;
      approvalTimeoutSeconds: number;
      toolCallTimeoutSeconds: number;
      version: number;
    }>();
    expect(created.approvalTimeoutSeconds).toBe(600);
    expect(created.toolCallTimeoutSeconds).toBe(1_800);

    const updatedResponse = await app.inject({
      method: 'PUT',
      url: `/api/admin/profiles/${created.id}`,
      headers: authHeaders,
      payload: {
        version: created.version,
        approvalTimeoutSeconds: 1_200,
        toolCallTimeoutSeconds: 3_600,
      },
    });
    expect(updatedResponse.statusCode).toBe(200);
    expect(updatedResponse.json()).toEqual(
      expect.objectContaining({
        approvalTimeoutSeconds: 1_200,
        toolCallTimeoutSeconds: 3_600,
        version: 2,
      }),
    );

    for (const invalid of [0, 86_401, 1.5, '120']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/profiles',
        headers: authHeaders,
        payload: { name: 'Invalid timeout', toolCallTimeoutSeconds: invalid },
      });
      expect(response.statusCode).toBe(400);
    }
    for (const invalid of [0, 86_401, 1.5, '120']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/profiles',
        headers: authHeaders,
        payload: { name: 'Invalid approval', approvalTimeoutSeconds: invalid },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('retires direct policy writes that would bypass profiles', async () => {
    const { app, authHeaders } = await fixture();

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/policies',
      headers: authHeaders,
      payload: {
        clientTokenId: 'token',
        upstreamId: 'upstream',
        toolName: 'send',
        outcome: 'allow',
      },
    });

    expect(response.statusCode).toBe(410);
  });

  it('keeps exactly one default under concurrent default changes', async () => {
    const { app, authHeaders } = await fixture();
    const [first, second] = await Promise.all(
      ['First', 'Second'].map(async (name) => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/admin/profiles',
          headers: authHeaders,
          payload: { name },
        });
        return response.json<{ id: string; version: number }>();
      }),
    );

    await Promise.all(
      [first, second].map((profile) =>
        app.inject({
          method: 'PUT',
          url: `/api/admin/profiles/${profile.id}`,
          headers: authHeaders,
          payload: { version: profile.version, isDefault: true },
        }),
      ),
    );
    const profiles = await app.inject({
      method: 'GET',
      url: '/api/admin/profiles',
      headers: { cookie: authHeaders.cookie },
    });

    expect(
      profiles
        .json<{ isDefault: boolean }[]>()
        .filter((profile) => profile.isDefault),
    ).toHaveLength(1);
  });

  it('adds concurrent token profile assignments incrementally', async () => {
    const { app, authHeaders } = await fixture();
    const token = await app.inject({
      method: 'POST',
      url: '/api/admin/tokens',
      headers: authHeaders,
      payload: { label: 'Agent' },
    });
    const tokenId = token.json<{ record: { id: string } }>().record.id;
    const profiles = await Promise.all(
      ['One', 'Two'].map(async (name) => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/admin/profiles',
          headers: authHeaders,
          payload: { name },
        });
        return response.json<{ id: string }>();
      }),
    );

    await Promise.all(
      profiles.map((profile) =>
        app.inject({
          method: 'PUT',
          url: `/api/admin/tokens/${tokenId}/profiles/${profile.id}`,
          headers: authHeaders,
          payload: { assigned: true },
        }),
      ),
    );
    const tokens = await app.inject({
      method: 'GET',
      url: '/api/admin/tokens',
      headers: { cookie: authHeaders.cookie },
    });

    expect(
      tokens
        .json<{ id: string; profileIds: string[] }[]>()
        .find((value) => value.id === tokenId)?.profileIds.sort(),
    ).toEqual(profiles.map((profile) => profile.id).sort());
  });

  it('rejects unauthenticated requests and requires CSRF on mutations', async () => {
    const { app, authHeaders } = await fixture();

    expect((await app.inject('/api/admin/tokens')).statusCode).toBe(401);
    expect((await app.inject('/api/admin/history/events')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/admin/tokens',
          headers: { cookie: authHeaders.cookie },
          payload: { label: 'Agent' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('shows a new token once and never serializes its verifier', async () => {
    const { app, authHeaders } = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/tokens',
      headers: authHeaders,
      payload: { label: 'Agent' },
    });
    const plaintext = created.json<{ plaintext: string }>().plaintext;

    expect(plaintext).toMatch(/^amcp_/);
    const listed = await app.inject({
      method: 'GET',
      url: '/api/admin/tokens',
      headers: { cookie: authHeaders.cookie },
    });
    expect(listed.body).not.toContain(plaintext);
    expect(listed.body).not.toContain('scrypt$');
    expect(listed.json()).toEqual([
      expect.objectContaining({ label: 'Agent' }),
    ]);
  });

  it('updates an agent, rotates its token, and deletes it without erasing audit identity', async () => {
    const { app, authHeaders, store } = await fixture();
    const service = new TokenService(new StateStoreTokenRepository(store));
    const created = await app.inject({
      method: 'POST', url: '/api/admin/tokens', headers: authHeaders,
      payload: { label: 'Agent' },
    });
    const { record, plaintext: original } = created.json<{
      record: { id: string; version: number }; plaintext: string;
    }>();

    const edited = await app.inject({
      method: 'PUT', url: `/api/admin/tokens/${record.id}`, headers: authHeaders,
      payload: { version: record.version, label: 'Work agent', canManageApprovalMcp: true },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ label: 'Work agent', canManageApprovalMcp: true });
    await expect(service.authenticate(original)).resolves.toMatchObject({ canManageApprovalMcp: true });

    const rotated = await app.inject({
      method: 'POST', url: `/api/admin/tokens/${record.id}/rotate`, headers: authHeaders,
      payload: { version: edited.json().version },
    });
    expect(rotated.statusCode).toBe(200);
    const replacement = rotated.json<{ plaintext: string; version: number }>().plaintext;
    expect(replacement).not.toBe(original);
    await expect(service.authenticate(original)).resolves.toBeUndefined();
    await expect(service.authenticate(replacement)).resolves.toMatchObject({ label: 'Work agent' });

    const demoted = await app.inject({
      method: 'PUT', url: `/api/admin/tokens/${record.id}`, headers: authHeaders,
      payload: { version: rotated.json().version, canManageApprovalMcp: false },
    });
    expect(demoted.statusCode).toBe(200);
    await expect(service.authenticate(replacement)).resolves.toMatchObject({ canManageApprovalMcp: false });

    const now = new Date().toISOString();
    await store.mutate({
      type: 'record.upserted', collection: 'grants', id: 'agent-grant',
      value: { id: 'agent-grant', clientTokenId: record.id, createdAt: now },
    });
    const deleted = await app.inject({
      method: 'DELETE', url: `/api/admin/tokens/${record.id}`, headers: authHeaders,
      payload: { version: demoted.json().version },
    });
    expect(deleted.statusCode).toBe(204);
    await expect(service.authenticate(replacement)).resolves.toBeUndefined();
    expect(store.read((state) => state.clientTokens[record.id])).toMatchObject({
      label: 'Work agent', hash: '', salt: '', canManageApprovalMcp: false,
      deletedAt: expect.any(String),
    });
    expect(store.read((state) => state.grants['agent-grant'])).toBeUndefined();
    const listed = await app.inject({
      method: 'GET', url: '/api/admin/tokens', headers: { cookie: authHeaders.cookie },
    });
    expect(listed.json()).toEqual([]);
  });

  it('adds agent and upstream display names to approvals and history', async () => {
    const now = '2026-07-30T08:28:22.098Z';
    const event = {
      eventId: 'event-1',
      callId: 'call-1',
      timestamp: now,
      type: 'call.received' as const,
      clientTokenId: 'token-1',
      upstreamId: 'upstream-1',
      toolName: 'send_message',
    };
    const journal: CallJournal = {
      recovery: { truncatedLines: 0 },
      append: async () => undefined,
      compressClosedSegments: async () => [],
      query: async () => ({
        items: [{
          callId: event.callId,
          firstSeenAt: now,
          lastSeenAt: now,
          clientTokenId: event.clientTokenId,
          upstreamId: event.upstreamId,
          toolName: event.toolName,
        }],
      }),
      get: async () => ({ callId: event.callId, events: [event] }),
      export: async function* () {},
      enforceRetention: async () => ({ deletedFiles: [], deletedBytes: 0 }),
    };
    const { app, authHeaders } = await fixture({
      journal,
      seed: async (store) => {
        await store.mutate({
          type: 'records.batch',
          operations: [
            {
              type: 'record.upserted',
              collection: 'clientTokens',
              id: 'token-1',
              value: {
                id: 'token-1',
                label: 'Claude Code',
                hash: 'hash',
                salt: 'salt',
                schemaVersion: 1,
                createdAt: now,
                updatedAt: now,
                version: 1,
              },
            },
            {
              type: 'record.upserted',
              collection: 'upstreams',
              id: 'upstream-1',
              value: {
                id: 'upstream-1',
                alias: 'Signal',
                url: 'https://signal.example/mcp',
                allowPrivateNetwork: false,
                schemaVersion: 1,
                createdAt: now,
                updatedAt: now,
                version: 1,
              },
            },
            {
              type: 'record.upserted',
              collection: 'approvals',
              id: 'approval-1',
              value: {
                approval: {
                  id: 'approval-1',
                  callId: 'call-1',
                  requestHash: 'request-hash',
                  status: 'pending',
                  reasonCode: 'policy.require_approval',
                  schemaVersion: 1,
                  createdAt: now,
                  updatedAt: now,
                  version: 1,
                },
                request: {
                  callId: 'call-1',
                  clientTokenId: 'token-1',
                  upstreamId: 'upstream-1',
                  toolName: 'send_message',
                  requestHash: 'request-hash',
                  context: {},
                  normalizationVersion: 1,
                  reasonCode: 'policy.require_approval',
                  expiresAt: '2099-07-30T08:28:22.098Z',
                },
              },
            },
            {
              type: 'record.upserted',
              collection: 'approvals',
              id: 'approval-completed',
              value: {
                approval: {
                  id: 'approval-completed',
                  callId: 'call-completed',
                  requestHash: 'completed-request-hash',
                  status: 'approved',
                  reasonCode: 'policy.require_approval',
                  schemaVersion: 1,
                  createdAt: now,
                  updatedAt: now,
                  version: 1,
                },
                request: {
                  callId: 'call-completed',
                  clientTokenId: 'token-1',
                  upstreamId: 'upstream-1',
                  toolName: 'send_message',
                  requestHash: 'completed-request-hash',
                  context: { message: 'not for the pending approvals feed' },
                  normalizationVersion: 1,
                  reasonCode: 'policy.require_approval',
                  expiresAt: '2099-07-30T08:28:22.098Z',
                },
              },
            },
          ],
        });
      },
    });
    const headers = { cookie: authHeaders.cookie };

    const approvals = await app.inject({
      method: 'GET',
      url: '/api/admin/approvals',
      headers,
    });
    expect(approvals.json()).toEqual([
      expect.objectContaining({
        approval: expect.objectContaining({ id: 'approval-1' }),
        tokenLabel: 'Claude Code',
        upstreamAlias: 'Signal',
      }),
    ]);

    const history = await app.inject({
      method: 'GET',
      url: '/api/admin/history',
      headers,
    });
    expect(history.json().items).toEqual([
      expect.objectContaining({
        tokenLabel: 'Claude Code',
        upstreamAlias: 'Signal',
      }),
    ]);

    const timeline = await app.inject({
      method: 'GET',
      url: '/api/admin/history/call-1',
      headers,
    });
    expect(timeline.json()).toEqual(expect.objectContaining({
      tokenLabel: 'Claude Code',
      upstreamAlias: 'Signal',
    }));
  });

  it('lists reusable active grants with display names and revokes them', async () => {
    const { app, authHeaders, store } = await fixture();
    const now = '2026-07-30T08:28:22.098Z';
    const activeGrant = {
      id: 'grant-hour',
      clientTokenId: 'token-1',
      upstreamId: 'upstream-1',
      toolName: 'get_conversations',
      predicates: [{ path: '/groupId', operator: 'exists' }],
      expiresAt: '2099-07-30T09:28:22.098Z',
      normalizationVersion: 1,
      approvedBy: 'admin',
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await store.mutate({
      type: 'records.batch',
      operations: [
        {
          type: 'record.upserted',
          collection: 'clientTokens',
          id: 'token-1',
          value: {
            id: 'token-1',
            label: 'Claude Code',
            verifier: 'not-returned',
            schemaVersion: 1,
            createdAt: now,
            updatedAt: now,
            version: 1,
          },
        },
        {
          type: 'record.upserted',
          collection: 'upstreams',
          id: 'upstream-1',
          value: {
            id: 'upstream-1',
            alias: 'signal',
            url: 'https://signal.example/mcp',
            allowPrivateNetwork: false,
            schemaVersion: 1,
            createdAt: now,
            updatedAt: now,
            version: 1,
          },
        },
        {
          type: 'record.upserted',
          collection: 'grants',
          id: activeGrant.id,
          value: activeGrant,
        },
        {
          type: 'record.upserted',
          collection: 'grants',
          id: 'grant-expired',
          value: {
            ...activeGrant,
            id: 'grant-expired',
            expiresAt: '2020-01-01T00:00:00.000Z',
          },
        },
        {
          type: 'record.upserted',
          collection: 'grants',
          id: 'grant-once',
          value: {
            ...activeGrant,
            id: 'grant-once',
            callId: 'call-1',
            requestHash: 'hash-1',
          },
        },
      ],
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/admin/grants',
      headers: { cookie: authHeaders.cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([
      expect.objectContaining({
        id: 'grant-hour',
        tokenLabel: 'Claude Code',
        upstreamAlias: 'signal',
        scope: 'until',
        version: 1,
      }),
    ]);

    const revoked = await app.inject({
      method: 'DELETE',
      url: '/api/admin/grants/grant-hour',
      headers: authHeaders,
      payload: { version: 1 },
    });
    expect(revoked.statusCode).toBe(204);
    expect(
      store.read((state) => state.grants['grant-hour']),
    ).toEqual(expect.objectContaining({
      revokedAt: expect.any(String),
      version: 2,
    }));

    const afterRevoke = await app.inject({
      method: 'GET',
      url: '/api/admin/grants',
      headers: { cookie: authHeaders.cookie },
    });
    expect(afterRevoke.json()).toEqual([]);
  });

  it('discovers tools for one configured upstream', async () => {
    let discoveredId: string | undefined;
    const { app, authHeaders } = await fixture({
      discoverTools: async (upstreamId) => {
        discoveredId = upstreamId;
        return {
          upstreamId,
          refreshedAt: '2026-07-28T00:00:00.000Z',
          tools: [
            { name: 'zeta', inputSchema: { type: 'object' } },
            { name: 'alpha', inputSchema: { type: 'object' } },
          ],
        };
      },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/upstreams',
      headers: authHeaders,
      payload: {
        alias: 'signal',
        url: 'https://signal.example/mcp',
        allowPrivateNetwork: false,
      },
    });
    const upstreamId = created.json<{ id: string }>().id;

    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/upstreams/${upstreamId}/tools`,
      headers: { cookie: authHeaders.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(discoveredId).toBe(upstreamId);
    expect(
      response.json<{ tools: { name: string }[] }>().tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(['alpha', 'zeta']);
  });

  it('bounds unknown and failed upstream discovery responses', async () => {
    const { app, authHeaders } = await fixture({
      discoverTools: async () => {
        throw new Error('secret connection detail');
      },
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/admin/upstreams/missing/tools',
          headers: { cookie: authHeaders.cookie },
        })
      ).statusCode,
    ).toBe(404);
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/upstreams',
      headers: authHeaders,
      payload: {
        alias: 'offline',
        url: 'https://offline.example/mcp',
        allowPrivateNetwork: false,
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/upstreams/${created.json<{ id: string }>().id}/tools`,
      headers: { cookie: authHeaders.cookie },
    });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('secret connection detail');
  });

  it('edits upstream details and metadata while preserving or explicitly removing credentials', async () => {
    const { app, authHeaders } = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/upstreams',
      headers: authHeaders,
      payload: {
        alias: 'signal',
        displayName: 'Work messages',
        description: 'Primary work account',
        metadata: { account: 'work', owner: 'Jiri' },
        url: 'https://signal.example/mcp',
        allowPrivateNetwork: false,
        credentials: { authorization: 'Bearer secret' },
      },
    });
    const upstream = created.json<{ id: string; version: number }>();
    expect(created.json()).toMatchObject({
      displayName: 'Work messages',
      description: 'Primary work account',
      metadata: { account: 'work', owner: 'Jiri' },
    });

    const preserved = await app.inject({
      method: 'PUT',
      url: `/api/admin/upstreams/${upstream.id}`,
      headers: authHeaders,
      payload: {
        version: upstream.version,
        alias: 'signal-home',
        displayName: 'Private messages',
        description: 'Personal account',
        metadata: { account: 'private' },
        url: 'https://signal.example/v2/mcp',
        allowPrivateNetwork: true,
      },
    });
    expect(preserved.statusCode).toBe(200);
    expect(preserved.json()).toMatchObject({
      alias: 'signal-home',
      displayName: 'Private messages',
      description: 'Personal account',
      metadata: { account: 'private' },
      allowPrivateNetwork: true,
      credentialsConfigured: true,
    });

    const removed = await app.inject({
      method: 'PUT',
      url: `/api/admin/upstreams/${upstream.id}`,
      headers: authHeaders,
      payload: {
        version: preserved.json<{ version: number }>().version,
        displayName: null,
        description: null,
        metadata: null,
        credentials: null,
      },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ credentialsConfigured: false });
    expect(removed.json()).not.toHaveProperty('displayName');
    expect(removed.json()).not.toHaveProperty('description');
    expect(removed.json()).not.toHaveProperty('metadata');
  });

  it('rejects malformed or oversized upstream metadata', async () => {
    const { app, authHeaders } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/upstreams',
      headers: authHeaders,
      payload: {
        alias: 'mail',
        displayName: 'x'.repeat(121),
        metadata: { 'invalid key': 'work' },
        url: 'https://mail.example/mcp',
        allowPrivateNetwork: false,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'input.invalid' } });
  });

  it('previews and atomically cascades upstream deletion', async () => {
    let reloads = 0;
    const { app, authHeaders, store } = await fixture({
      onUpstreamsChanged: async () => {
        reloads += 1;
      },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/upstreams',
      headers: authHeaders,
      payload: {
        alias: 'signal',
        url: 'https://signal.example/mcp',
        allowPrivateNetwork: false,
      },
    });
    const upstream = created.json<{ id: string; version: number }>();
    const now = new Date().toISOString();
    await store.mutate({
      type: 'records.batch',
      operations: [
        {
          type: 'record.upserted',
          collection: 'policies',
          id: 'policy-1',
          value: {
            id: 'policy-1',
            clientTokenId: 'token-1',
            upstreamId: upstream.id,
            toolName: 'send',
            outcome: 'allow',
            predicates: [],
            enabled: true,
            schemaVersion: 1,
            createdAt: now,
            updatedAt: now,
            version: 1,
          },
        },
        {
          type: 'record.upserted',
          collection: 'profileRules',
          id: 'profile-rule-1',
          value: {
            id: 'profile-rule-1',
            profileId: 'profile-1',
            upstreamId: upstream.id,
            outcome: 'allow',
            predicates: [],
            enabled: true,
            schemaVersion: 1,
            createdAt: now,
            updatedAt: now,
            version: 1,
          },
        },
        {
          type: 'record.upserted',
          collection: 'grants',
          id: 'grant-1',
          value: {
            id: 'grant-1',
            clientTokenId: 'token-1',
            upstreamId: upstream.id,
            toolName: 'send',
            scope: { kind: 'forever' },
            schemaVersion: 1,
            createdAt: now,
            updatedAt: now,
            version: 1,
          },
        },
      ],
    });

    const impact = await app.inject({
      method: 'GET',
      url: `/api/admin/upstreams/${upstream.id}/deletion-impact`,
      headers: { cookie: authHeaders.cookie },
    });
    expect(impact.json()).toEqual({ policies: 1, profileRules: 1, grants: 1 });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/admin/upstreams/${upstream.id}`,
      headers: authHeaders,
      payload: { version: upstream.version },
    });
    expect(removed.statusCode).toBe(204);
    expect(
      store.read((state) => ({
        upstream: state.upstreams[upstream.id],
        policy: state.policies['policy-1'],
        grant: state.grants['grant-1'],
        profileRule: state.profileRules['profile-rule-1'],
      })),
    ).toEqual({
      upstream: undefined,
      policy: undefined,
      grant: undefined,
      profileRule: undefined,
    });
    expect(reloads).toBe(2);
  });
});
