import { randomUUID } from 'node:crypto';

import type {
  JsonValue,
  Upstream,
  UpstreamId,
} from '@approval-mcp/contracts';
import type { CredentialVault, UpstreamCredentials } from '@approval-mcp/upstream';
import type { ToolCatalog } from '@approval-mcp/upstream';
import { isValidUpstreamAlias } from '@approval-mcp/gateway';
import type { ConfigState, ConfigStateStore } from '@approval-mcp/state-store';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { SessionService } from '../session-store.js';
import { authorizeAdmin } from './authorization.js';
import { SELF_UPSTREAM_ALIAS } from '../self-mcp-tools.js';
import {
  invalidInput,
  MAX_DESCRIPTION_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  optionalText,
  upstreamMetadata,
} from './upstream-validation.js';

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
    ...(record.managedBy === undefined ? {} : { managedBy: record.managedBy }),
  };
}

/** Whether an upstream other than `exceptId` already uses `alias`. */
function aliasTaken(state: Readonly<ConfigState>, alias: string, exceptId?: string): boolean {
  return Object.values(state.upstreams).some((value) => {
    const upstream = value as unknown as Upstream;
    return upstream.alias === alias && upstream.id !== exceptId;
  });
}

function aliasConflict(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(409).send({
    error: {
      code: 'upstream.alias_conflict',
      message: 'Another upstream already uses this alias',
      requestId: request.id,
    },
  });
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
      !isValidUpstreamAlias(body.alias) ||
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
    // Checked in the same step of the state queue as the write, so a concurrent
    // write (another admin, declarative setup) cannot add the alias in between.
    const created = await options.state.transact((state) => aliasTaken(state, record.alias)
      ? { result: false }
      : {
          event: {
            type: 'record.upserted',
            collection: 'upstreams',
            id,
            value: record as unknown as JsonValue,
          },
          result: true,
        });
    if (!created) return aliasConflict(request, reply);
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
    // The version check and the write run in one step of the state queue, so a
    // concurrent write (another admin, declarative setup) cannot be overwritten.
    const outcome = await options.state.transact<
      | { kind: 'not_found' }
      | { kind: 'conflict' }
      | { kind: 'invalid_pin' }
      | { kind: 'alias_conflict' }
      | { kind: 'invalid_alias' }
      | { kind: 'updated'; record: Upstream }
    >((state) => {
      if (!Object.hasOwn(state.upstreams, id)) return { result: { kind: 'not_found' } };
      const record = state.upstreams[id] as unknown as Upstream;
      if (body.version !== record.version) return { result: { kind: 'conflict' } };
      // A new alias must be valid and unused. Keeping the current alias is always
      // allowed, so an upstream stored before validation can still be edited
      // and renamed to a valid alias.
      if (typeof body.alias === 'string' && body.alias !== record.alias) {
        if (!isValidUpstreamAlias(body.alias)) return { result: { kind: 'invalid_alias' } };
        if (aliasTaken(state, body.alias, record.id)) return { result: { kind: 'alias_conflict' } };
      }
      if (
        pluginChanged &&
        !removesPlugin &&
        !(body.pluginId === record.pluginId && body.pluginVersion === record.pluginVersion) &&
        !(options.getPlugins?.() ?? options.plugins)?.some(
          (plugin) =>
            plugin.id === body.pluginId && plugin.version === body.pluginVersion,
        )
      ) {
        return { result: { kind: 'invalid_pin' } };
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
      return {
        event: {
          type: 'record.upserted',
          collection: 'upstreams',
          id,
          value: updated as unknown as JsonValue,
        },
        result: { kind: 'updated', record: updated },
      };
    });
    if (outcome.kind === 'not_found') {
      reply.code(404);
      return { error: { code: 'upstream.not_found', message: 'Upstream not found', requestId: request.id } };
    }
    if (outcome.kind === 'conflict') return conflict(request, reply);
    if (outcome.kind === 'alias_conflict') return aliasConflict(request, reply);
    if (outcome.kind === 'invalid_alias') {
      reply.code(400);
      return { error: { code: 'input.invalid', message: 'Invalid upstream alias', requestId: request.id } };
    }
    if (outcome.kind === 'invalid_pin') {
      reply.code(400);
      return {
        error: {
          code: 'plugin.invalid_pin',
          message: 'Invalid plugin pin',
          requestId: request.id,
        },
      };
    }
    await options.onUpstreamsChanged?.();
    return publicUpstream(outcome.record);
  });

  app.delete('/api/admin/upstreams/:id', async (request, reply) => {
    if (!await authorizeAdmin(request, reply, options.sessions, true)) return;
    const { id } = request.params as { id: string };
    const body = request.body as { version?: unknown };
    const outcome = await options.state.transact<'deleted' | 'not_found' | 'conflict'>((state) => {
      if (!Object.hasOwn(state.upstreams, id)) return { result: 'not_found' };
      const record = state.upstreams[id] as unknown as Upstream;
      if (body.version !== record.version) return { result: 'conflict' };
      const idsReferencing = (collection: Record<string, unknown>) => Object.entries(collection)
        .filter(([, value]) => (value as { upstreamId?: unknown }).upstreamId === id)
        .map(([recordId]) => recordId);
      return {
        event: {
          type: 'records.batch',
          operations: [
            ...idsReferencing(state.grants).map((grantId) => ({
              type: 'record.deleted' as const,
              collection: 'grants' as const,
              id: grantId,
            })),
            ...idsReferencing(state.policies).map((policyId) => ({
              type: 'record.deleted' as const,
              collection: 'policies' as const,
              id: policyId,
            })),
            ...idsReferencing(state.profileRules).map((profileRuleId) => ({
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
        },
        result: 'deleted',
      };
    });
    if (outcome === 'not_found') {
      reply.code(404);
      return {
        error: {
          code: 'upstream.not_found',
          message: 'Upstream not found',
          requestId: request.id,
        },
      };
    }
    if (outcome === 'conflict') return conflict(request, reply);
    await options.onUpstreamsChanged?.();
    return reply.code(204).send();
  });
}
