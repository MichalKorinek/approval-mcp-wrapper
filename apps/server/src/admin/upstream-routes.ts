import { randomUUID } from 'node:crypto';

import type {
  JsonValue,
  Upstream,
  UpstreamId,
} from '@approval-mcp/contracts';
import type { CredentialVault, UpstreamCredentials } from '@approval-mcp/upstream';
import type { ToolCatalog } from '@approval-mcp/upstream';
import type { ConfigStateStore } from '@approval-mcp/state-store';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { SessionService } from '../session-store.js';
import { authorizeAdmin } from './authorization.js';
import { SELF_UPSTREAM_ALIAS } from '../self-mcp-tools.js';

const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_METADATA_ENTRIES = 20;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_VALUE_LENGTH = 500;
const METADATA_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const FORBIDDEN_METADATA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const invalidInput = Symbol('invalidInput');

function optionalText(value: unknown, maxLength: number) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return invalidInput;
  const normalized = value.trim();
  if (normalized.length > maxLength) return invalidInput;
  return normalized === '' ? undefined : normalized;
}

function upstreamMetadata(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return invalidInput;
  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_ENTRIES) return invalidInput;
  const metadata: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim();
    if (
      typeof rawValue !== 'string' ||
      key.length === 0 ||
      key.length > MAX_METADATA_KEY_LENGTH ||
      !METADATA_KEY_PATTERN.test(key) ||
      FORBIDDEN_METADATA_KEYS.has(key) ||
      rawValue.length > MAX_METADATA_VALUE_LENGTH ||
      Object.hasOwn(metadata, key)
    ) {
      return invalidInput;
    }
    metadata[key] = rawValue.trim();
  }
  return entries.length === 0 ? undefined : metadata;
}

function publicUpstream(record: Upstream) {
  return {
    id: record.id,
    alias: record.alias,
    ...(record.displayName === undefined
      ? {}
      : { displayName: record.displayName }),
    ...(record.description === undefined
      ? {}
      : { description: record.description }),
    ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
    url: record.url,
    allowPrivateNetwork: record.allowPrivateNetwork,
    credentialsConfigured: record.credentials !== undefined,
    schemaVersion: record.schemaVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    version: record.version,
    ...(record.pluginId === undefined ? {} : { pluginId: record.pluginId }),
    ...(record.pluginVersion === undefined
      ? {}
      : { pluginVersion: record.pluginVersion }),
  };
}

function conflict(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(409).send({
    error: {
      code: 'state.version_conflict',
      message: 'The record has changed',
      requestId: request.id,
    },
  });
}

export async function registerUpstreamRoutes(
  app: FastifyInstance,
  options: {
    sessions: SessionService;
    state: ConfigStateStore;
    credentialVault?: CredentialVault;
    onUpstreamsChanged?(): Promise<void>;
    discoverTools?(upstreamId: UpstreamId): Promise<ToolCatalog>;
    plugins?: readonly Readonly<{ id: string; version: string }>[];
    getPlugins?(): readonly Readonly<{ id: string; version: string }>[];
  },
): Promise<void> {
  app.get('/api/admin/upstreams', async (request, reply) => {
    if (!await authorizeAdmin(request, reply, options.sessions, false)) return;
    return options.state.read((state) =>
      Object.values(state.upstreams).map((value) =>
        publicUpstream(value as unknown as Upstream),
      ),
    );
  });

  app.get('/api/admin/upstreams/:id/tools', async (request, reply) => {
    if (!await authorizeAdmin(request, reply, options.sessions, false)) return;
    const { id } = request.params as { id: string };
    const upstream = options.state.read((state) => state.upstreams[id]);
    if (upstream === undefined) {
      reply.code(404);
      return {
        error: {
          code: 'upstream.not_found',
          message: 'Upstream not found',
          requestId: request.id,
        },
      };
    }
    if (options.discoverTools === undefined) {
      reply.code(503);
      return {
        error: {
          code: 'upstream.discovery_unavailable',
          message: 'Tool discovery is unavailable',
          requestId: request.id,
        },
      };
    }
    try {
      const catalog = await options.discoverTools(id as UpstreamId);
      return {
        ...catalog,
        tools: [...catalog.tools].sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      };
    } catch {
      reply.code(502);
      return {
        error: {
          code: 'upstream.discovery_failed',
          message: 'The upstream tool catalog could not be loaded',
          requestId: request.id,
        },
      };
    }
  });

  app.get(
    '/api/admin/upstreams/:id/deletion-impact',
    async (request, reply) => {
      if (!await authorizeAdmin(request, reply, options.sessions, false)) return;
      const { id } = request.params as { id: string };
      const impact = options.state.read((state) => {
        if (state.upstreams[id] === undefined) return undefined;
        return {
          policies: Object.values(state.policies).filter(
            (record) =>
              (record as { upstreamId?: unknown }).upstreamId === id,
          ).length,
          profileRules: Object.values(state.profileRules).filter(
            (record) =>
              (record as { upstreamId?: unknown }).upstreamId === id,
          ).length,
          grants: Object.values(state.grants).filter(
            (record) =>
              (record as { upstreamId?: unknown }).upstreamId === id,
          ).length,
        };
      });
      if (impact === undefined) {
        reply.code(404);
        return {
          error: {
            code: 'upstream.not_found',
            message: 'Upstream not found',
            requestId: request.id,
          },
        };
      }
      return impact;
    },
  );

  app.post('/api/admin/upstreams', async (request, reply) => {
    if (!await authorizeAdmin(request, reply, options.sessions, true)) return;
    const body = request.body as {
      alias?: unknown;
      url?: unknown;
      allowPrivateNetwork?: unknown;
      credentials?: UpstreamCredentials;
      pluginId?: unknown;
      pluginVersion?: unknown;
      displayName?: unknown;
      description?: unknown;
      metadata?: unknown;
    };
    const displayName = optionalText(
      body.displayName,
      MAX_DISPLAY_NAME_LENGTH,
    );
    const description = optionalText(
      body.description,
      MAX_DESCRIPTION_LENGTH,
    );
    const metadata = upstreamMetadata(body.metadata);
    if (
      typeof body.alias !== 'string' ||
      body.alias === SELF_UPSTREAM_ALIAS ||
      typeof body.url !== 'string' ||
      typeof body.allowPrivateNetwork !== 'boolean' ||
      displayName === invalidInput ||
      description === invalidInput ||
      metadata === invalidInput
    ) {
      reply.code(400);
      return { error: { code: 'input.invalid', message: 'Invalid upstream', requestId: request.id } };
    }
    if (
      (body.pluginId !== undefined || body.pluginVersion !== undefined) &&
      !(options.getPlugins?.() ?? options.plugins)?.some(
        (plugin) =>
          plugin.id === body.pluginId && plugin.version === body.pluginVersion,
      )
    ) {
      reply.code(400);
      return {
        error: {
          code: 'plugin.invalid_pin',
          message: 'Invalid plugin pin',
          requestId: request.id,
        },
      };
    }
    const id = randomUUID() as UpstreamId;
    const now = new Date().toISOString();
    const record: Upstream = {
      id,
      alias: body.alias,
      ...(displayName === undefined ? {} : { displayName }),
      ...(description === undefined ? {} : { description }),
      ...(metadata === undefined ? {} : { metadata }),
      url: new URL(body.url).href,
      allowPrivateNetwork: body.allowPrivateNetwork,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      version: 1,
      ...(typeof body.pluginId === 'string' ? { pluginId: body.pluginId } : {}),
      ...(typeof body.pluginVersion === 'string'
        ? { pluginVersion: body.pluginVersion }
        : {}),
      ...(body.credentials === undefined
        ? {}
        : {
            credentials: options.credentialVault?.encrypt(id, body.credentials) ??
              (() => { throw new Error('Credential vault is unavailable'); })(),
          }),
    };
    await options.state.mutate({
      type: 'record.upserted',
      collection: 'upstreams',
      id,
      value: record as unknown as JsonValue,
    });
    await options.onUpstreamsChanged?.();
    reply.code(201);
    return publicUpstream(record);
  });

  app.put('/api/admin/upstreams/:id', async (request, reply) => {
    if (!await authorizeAdmin(request, reply, options.sessions, true)) return;
    const { id } = request.params as { id: string };
    const body = request.body as {
      version?: unknown;
      alias?: unknown;
      url?: unknown;
      allowPrivateNetwork?: unknown;
      credentials?: UpstreamCredentials | null;
      pluginId?: unknown;
      pluginVersion?: unknown;
      displayName?: unknown;
      description?: unknown;
      metadata?: unknown;
    };
    const current = options.state.read((state) => state.upstreams[id]);
    if (current === undefined) {
      reply.code(404);
      return { error: { code: 'upstream.not_found', message: 'Upstream not found', requestId: request.id } };
    }
    const record = current as unknown as Upstream;
    if (body.version !== record.version) return conflict(request, reply);
    const displayName = optionalText(
      body.displayName,
      MAX_DISPLAY_NAME_LENGTH,
    );
    const description = optionalText(
      body.description,
      MAX_DESCRIPTION_LENGTH,
    );
    const metadata = upstreamMetadata(body.metadata);
    if (
      displayName === invalidInput ||
      description === invalidInput ||
      metadata === invalidInput ||
      body.alias === SELF_UPSTREAM_ALIAS
    ) {
      reply.code(400);
      return {
        error: {
          code: 'input.invalid',
          message: 'Invalid upstream metadata',
          requestId: request.id,
        },
      };
    }
    const pluginChanged =
      body.pluginId !== undefined || body.pluginVersion !== undefined;
    const removesPlugin =
      body.pluginId === null && body.pluginVersion === null;
    if (
      pluginChanged &&
      !removesPlugin &&
      !(body.pluginId === record.pluginId && body.pluginVersion === record.pluginVersion) &&
      !(options.getPlugins?.() ?? options.plugins)?.some(
        (plugin) =>
          plugin.id === body.pluginId && plugin.version === body.pluginVersion,
      )
    ) {
      reply.code(400);
      return {
        error: {
          code: 'plugin.invalid_pin',
          message: 'Invalid plugin pin',
          requestId: request.id,
        },
      };
    }
    let updated: Upstream = {
      ...record,
      ...(typeof body.alias === 'string' ? { alias: body.alias } : {}),
      ...(typeof body.url === 'string' ? { url: new URL(body.url).href } : {}),
      ...(typeof body.allowPrivateNetwork === 'boolean'
        ? { allowPrivateNetwork: body.allowPrivateNetwork }
        : {}),
      updatedAt: new Date().toISOString(),
      version: record.version + 1,
    };
    if (body.displayName !== undefined) {
      if (displayName === undefined) {
        const { displayName: _removed, ...withoutDisplayName } = updated;
        updated = withoutDisplayName;
      } else {
        updated = { ...updated, displayName };
      }
    }
    if (body.description !== undefined) {
      if (description === undefined) {
        const { description: _removed, ...withoutDescription } = updated;
        updated = withoutDescription;
      } else {
        updated = { ...updated, description };
      }
    }
    if (body.metadata !== undefined) {
      if (metadata === undefined) {
        const { metadata: _removed, ...withoutMetadata } = updated;
        updated = withoutMetadata;
      } else {
        updated = { ...updated, metadata };
      }
    }
    if (removesPlugin) {
      const {
        pluginId: _removedPluginId,
        pluginVersion: _removedPluginVersion,
        ...withoutPlugin
      } = updated;
      updated = withoutPlugin;
    } else if (
      typeof body.pluginId === 'string' &&
      typeof body.pluginVersion === 'string'
    ) {
      updated = {
        ...updated,
        pluginId: body.pluginId,
        pluginVersion: body.pluginVersion,
      };
    }
    if (body.credentials === null) {
      const { credentials: _removed, ...withoutCredentials } = updated;
      updated = withoutCredentials;
    } else if (body.credentials !== undefined) {
      updated = {
        ...updated,
        credentials:
          options.credentialVault?.encrypt(record.id, body.credentials) ??
          (() => {
            throw new Error('Credential vault is unavailable');
          })(),
      };
    }
    await options.state.mutate({
      type: 'record.upserted',
      collection: 'upstreams',
      id,
      value: updated as unknown as JsonValue,
    });
    await options.onUpstreamsChanged?.();
    return publicUpstream(updated);
  });

  app.delete('/api/admin/upstreams/:id', async (request, reply) => {
    if (!await authorizeAdmin(request, reply, options.sessions, true)) return;
    const { id } = request.params as { id: string };
    const body = request.body as { version?: unknown };
    const deletion = options.state.read((state) => {
      const current = state.upstreams[id];
      if (current === undefined) return undefined;
      const record = current as unknown as Upstream;
      const policyIds = Object.entries(state.policies)
        .filter(
          ([, value]) =>
            (value as { upstreamId?: unknown }).upstreamId === id,
        )
        .map(([policyId]) => policyId);
      const grantIds = Object.entries(state.grants)
        .filter(
          ([, value]) =>
            (value as { upstreamId?: unknown }).upstreamId === id,
        )
        .map(([grantId]) => grantId);
      const profileRuleIds = Object.entries(state.profileRules)
        .filter(
          ([, value]) =>
            (value as { upstreamId?: unknown }).upstreamId === id,
        )
        .map(([profileRuleId]) => profileRuleId);
      return { record, policyIds, grantIds, profileRuleIds };
    });
    if (deletion === undefined) {
      reply.code(404);
      return {
        error: {
          code: 'upstream.not_found',
          message: 'Upstream not found',
          requestId: request.id,
        },
      };
    }
    if (body.version !== deletion.record.version) {
      return conflict(request, reply);
    }
    await options.state.mutate({
      type: 'records.batch',
      operations: [
        ...deletion.grantIds.map((grantId) => ({
          type: 'record.deleted' as const,
          collection: 'grants' as const,
          id: grantId,
        })),
        ...deletion.policyIds.map((policyId) => ({
          type: 'record.deleted' as const,
          collection: 'policies' as const,
          id: policyId,
        })),
        ...deletion.profileRuleIds.map((profileRuleId) => ({
          type: 'record.deleted' as const,
          collection: 'profileRules' as const,
          id: profileRuleId,
        })),
        {
          type: 'record.deleted',
          collection: 'upstreams',
          id,
        },
      ],
    });
    await options.onUpstreamsChanged?.();
    return reply.code(204).send();
  });
}
