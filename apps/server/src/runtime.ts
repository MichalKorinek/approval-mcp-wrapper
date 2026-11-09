import { buildServerApp } from './app.js';
import {
  StatePasskeyRepository,
  StateRecoveryRepository,
  StateSessionRepository,
} from './auth-state-repositories.js';
import type { ServerConfig } from './config.js';
import { PasskeyService } from './passkey-service.js';
import { RecoveryService } from './recovery-service.js';
import { SessionService } from './session-store.js';
import { OAuthService } from './oauth-service.js';
import { registerSetupRoutes } from './setup/setup-routes.js';
import { SetupService } from './setup/setup-service.js';
import { createConfigStateStore, createNodeFileOperations } from '@approval-mcp/state-store';
import type { StorageCodec } from '@approval-mcp/contracts';
import { createCallJournal } from '@approval-mcp/call-journal';
import {
  ApprovalOrchestrator,
  buildTokenCatalog,
  type CatalogSourceTool,
  createMcpHttpHandler,
  evaluateToolInspection,
  PolicyCallCoordinator,
  StateStoreApprovalRepository,
  StateStoreTokenRepository,
  TokenScopedGateway,
  TokenService,
  type ToolInspection,
  withPolicyDescription,
} from '@approval-mcp/gateway';
import {
  CredentialVault,
  UpstreamRegistry,
} from '@approval-mcp/upstream';
import { PluginManager } from './plugins/plugin-manager.js';
import {
  createGenericDescription,
  PluginRegistry,
} from '@approval-mcp/plugin-sdk';
import { join } from 'node:path';
import {
  ApprovalEventBroker,
  HistoryEventBroker,
  registerAdminRoutes,
} from './admin/index.js';
import fastifyStatic from '@fastify/static';
import type {
  ClientTokenId,
  Grant,
  JsonValue,
  Policy,
  PolicyId,
  Profile,
  ProfileRule,
  TokenProfileAssignment,
  Upstream,
} from '@approval-mcp/contracts';
import {
  evaluatePolicy,
  resolveApprovalTimeoutSeconds,
  resolveProfileRules,
  resolveToolCallTimeoutSeconds,
} from '@approval-mcp/policy';
import { readiness } from './operations/health.js';
import { startRetentionJob } from './operations/retention-job.js';
import { PushNotificationService, type BootstrapPushConfig } from './push-notification-service.js';
import {
  callSelfTool,
  MANAGER_TOOL_NAMES,
  SELF_TOOLS,
  SELF_UPSTREAM_ALIAS,
  SELF_UPSTREAM_ID,
} from './self-mcp-tools.js';

export async function buildRuntime(config: ServerConfig & { masterKey: Buffer }, codec: StorageCodec, onPushChanged?: (value: BootstrapPushConfig) => Promise<void>, initialStoragePasskey?: { id: string; publicKey: string; counter: number }) {
const stateStore = await createConfigStateStore(config.dataDir, createNodeFileOperations(codec));
if (initialStoragePasskey !== undefined && stateStore.read((state) => Object.keys(state.passkeys).length === 0)) {
  const timestamp = new Date().toISOString();
  await new StatePasskeyRepository(stateStore).createFirst({ ...initialStoragePasskey, adminId: 'admin', createdAt: timestamp, updatedAt: timestamp });
}
const historyBroker = new HistoryEventBroker();
const journal = await createCallJournal(
  join(config.dataDir, 'calls'),
  (event) => historyBroker.publish({
    callId: event.callId,
    timestamp: event.timestamp,
    type: event.type,
  }),
  codec,
);
const sessions = new SessionService(new StateSessionRepository(stateStore));
const oauth = new OAuthService(
  stateStore,
  config.expectedOrigin,
  () => new Date(),
  config.oauthOrigins,
  (event) => console.info(JSON.stringify(event)),
  codec,
);
const credentialVault = new CredentialVault(config.masterKey);
const pushNotifications = await PushNotificationService.create({
  state: stateStore,
  masterKey: config.masterKey,
  vapidSubject: config.vapidSubject,
  ...(onPushChanged === undefined ? {} : { onBootstrapChanged: onPushChanged }),
});
const configuredUpstreams = () =>
  stateStore.read((state) =>
    Object.values(state.upstreams).map((value) => value as unknown as Upstream),
  );
const upstreams = new UpstreamRegistry({
  upstreams: configuredUpstreams(),
  credentialVault,
});
const pluginRegistry = new PluginRegistry([]);
const pluginManager = new PluginManager({
  directory: config.pluginsDir,
  state: stateStore,
  registry: pluginRegistry,
  host: {
    async findContact(upstreamId, source, identifier) {
      return upstreams.call({
        upstreamId: upstreamId as Upstream['id'],
        toolName: source === 'whatsapp' ? 'search_contacts' : 'contacts_search',
        arguments: source === 'whatsapp'
          ? { query: identifier.replace(/@s\.whatsapp\.net$/i, '') }
          : { phone: identifier },
        timeoutMs: 3_000,
      });
    },
    async findChat(upstreamId, identifier) {
      return upstreams.call({
        upstreamId: upstreamId as Upstream['id'],
        toolName: 'get_chat',
        arguments: { chat_jid: identifier },
        timeoutMs: 3_000,
      });
    },
    async findMessage(upstreamId, identifier) {
      return upstreams.call({
        upstreamId: upstreamId as Upstream['id'],
        toolName: 'get_message_context',
        arguments: { message_id: identifier },
        timeoutMs: 3_000,
      });
    },
    async listWellnessServices(upstreamId) {
      return upstreams.call({
        upstreamId: upstreamId as Upstream['id'],
        toolName: 'services',
        arguments: {},
        timeoutMs: 3_000,
      });
    },
    async findCalendarEvents(upstreamId, start, end) {
      return upstreams.call({
        upstreamId: upstreamId as Upstream['id'],
        toolName: 'events_fetch',
        arguments: { start, end },
        timeoutMs: 5_000,
      });
    },
    async readMessage(upstreamId, messageId) {
      return upstreams.call({
        upstreamId: upstreamId as Upstream['id'],
        toolName: 'get_message',
        arguments: { messageId },
        timeoutMs: 3_000,
      });
    },
    async readJson(upstreamId, uri) {
      const result = (await upstreams.readResource({
        upstreamId: upstreamId as Upstream['id'],
        uri,
        timeoutMs: 3_000,
      })) as {
        contents?: readonly Readonly<{ text?: unknown }>[];
      };
      const text = result.contents?.find(
        (content) => typeof content.text === 'string',
      )?.text;
      if (typeof text !== 'string') return undefined;
      return JSON.parse(text) as JsonValue;
    },
  },
});
await pluginManager.restore();
const directPolicies = () =>
  stateStore.read((state) =>
    Object.values(state.policies).map((value) => value as unknown as Policy),
  );
const profiles = () =>
  stateStore.read((state) =>
    Object.values(state.profiles).map((value) => value as unknown as Profile),
  );
const profileRules = () =>
  stateStore.read((state) =>
    Object.values(state.profileRules).map(
      (value) => value as unknown as ProfileRule,
    ),
  );
const profileAssignments = () =>
  stateStore.read((state) =>
    Object.values(state.tokenProfileAssignments).map(
      (value) => value as unknown as TokenProfileAssignment,
    ),
  );
const policiesFor = (
  clientTokenId: ClientTokenId,
  upstreamId: Upstream['id'],
  toolName: string,
): Policy[] => {
  const resolved = resolveProfileRules({
    clientTokenId,
    upstreamId,
    toolName,
    profiles: profiles(),
    rules: profileRules(),
    assignments: profileAssignments(),
  });
  return [
    ...directPolicies(),
    ...resolved.rules.map((rule) => ({
      ...rule,
      id: rule.id as unknown as PolicyId,
      clientTokenId,
      toolName,
    })),
  ];
};
const grants = () =>
  stateStore.read((state) =>
    Object.values(state.grants).map((value) => value as unknown as Grant),
  );
const approvalBroker = new ApprovalEventBroker();
const approvals = new ApprovalOrchestrator(
  new StateStoreApprovalRepository(stateStore),
  () => new Date(),
  (input) =>
    stateStore.read((state) => {
      const token = state.clientTokens[input.clientTokenId] as {
        revokedAt?: string;
        deletedAt?: string;
      } | undefined;
      return token === undefined || token.revokedAt !== undefined || token.deletedAt !== undefined;
    }) || evaluatePolicy({
      visible: true,
      clientTokenId: input.clientTokenId,
      upstreamId: input.upstreamId,
      toolName: input.toolName,
      context: input.context,
      requestHash: input.requestHash,
      normalizationVersion: input.normalizationVersion,
      policies: policiesFor(input.clientTokenId, input.upstreamId, input.toolName),
      grants: [],
      now: new Date().toISOString(),
    }).reasonCode === 'policy.explicit_deny',
  (approval) => {
    approvalBroker.publish({
      approvalId: approval.id,
      status: approval.status,
    });
    void pushNotifications.notifyPending(approval).catch(() => undefined);
  },
);
await approvals.interruptAll('server.restarted');
const tokens = new TokenService(new StateStoreTokenRepository(stateStore));
const timeoutsFor = (clientTokenId: ClientTokenId) => ({
  approvalTimeoutSeconds: resolveApprovalTimeoutSeconds({
    clientTokenId,
    profiles: profiles(),
    assignments: profileAssignments(),
  }),
  toolCallTimeoutSeconds: resolveToolCallTimeoutSeconds({
    clientTokenId,
    profiles: profiles(),
    assignments: profileAssignments(),
  }),
});
const canManageApprovalMcp = (tokenId: ClientTokenId) => stateStore.read((state) => {
  const token = state.clientTokens[tokenId] as {
    canManageApprovalMcp?: boolean;
    revokedAt?: string;
  } | undefined;
  return token?.canManageApprovalMcp === true && token.revokedAt === undefined;
});
const selfInspectFallback = (clientTokenId: ClientTokenId, toolName: string): Policy[] => {
  if (toolName !== 'inspect_tool') return [];
  const resolved = resolveProfileRules({
    clientTokenId, upstreamId: SELF_UPSTREAM_ID, toolName,
    profiles: profiles(), rules: profileRules(), assignments: profileAssignments(),
  });
  if (resolved.outcome !== 'unconfigured') return [];
  return [{
    id: 'approval-mcp-inspect-default' as PolicyId,
    clientTokenId, upstreamId: SELF_UPSTREAM_ID, toolName,
    outcome: 'allow', predicates: [], enabled: true, schemaVersion: 1,
    createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z', version: 1,
  }];
};
const coordinator = new PolicyCallCoordinator({
  isClientActive: (clientTokenId) => stateStore.read((state) => {
    const token = state.clientTokens[clientTokenId] as {
      revokedAt?: string;
      deletedAt?: string;
      expiresAt?: string;
    } | undefined;
    return token !== undefined && token.revokedAt === undefined && token.deletedAt === undefined &&
      (token.expiresAt === undefined || token.expiresAt > new Date().toISOString());
  }),
  policies: (input) =>
    [...policiesFor(input.clientTokenId, input.upstreamId, input.toolName),
      ...(input.upstreamId === SELF_UPSTREAM_ID ? selfInspectFallback(input.clientTokenId, input.toolName) : [])],
  approvalTimeoutMs: (input) =>
    timeoutsFor(input.clientTokenId).approvalTimeoutSeconds * 1_000,
  toolCallTimeoutMs: (input) =>
    timeoutsFor(input.clientTokenId).toolCallTimeoutSeconds * 1_000,
  grants,
  describe: async (input) => {
    if (input.upstreamId === SELF_UPSTREAM_ID) {
      return {
        description: createGenericDescription({
          upstreamId: SELF_UPSTREAM_ID,
          upstreamAlias: SELF_UPSTREAM_ALIAS,
          toolName: input.toolName,
          arguments: input.arguments as JsonValue,
        }),
        normalizationVersion: 1,
        ...(input.toolName === 'inspect_tool' || input.toolName === 'get_tool_info'
          ? { sensitivePaths: ['/arguments'] } : {}),
      };
    }
    const upstream = configuredUpstreams().find(
      (candidate) => candidate.id === input.upstreamId,
    );
    if (upstream === undefined) {
      throw new Error(`Unknown upstream: ${input.upstreamId}`);
    }
    const toolDescription = upstreams
      .getCatalog(input.upstreamId)
      ?.tools.find((tool) => tool.name === input.toolName)?.description;
    const pluginInput = {
      upstreamId: input.upstreamId,
      upstreamAlias: upstream.alias,
      toolName: input.toolName,
      ...(toolDescription === undefined
        ? {}
        : { toolDescription }),
      arguments: input.arguments as JsonValue,
    };
    if (
      upstream.pluginId === undefined ||
      upstream.pluginVersion === undefined
    ) {
      return {
        description: createGenericDescription(pluginInput),
        normalizationVersion: 1,
      };
    }
    const pin = {
      id: upstream.pluginId,
      version: upstream.pluginVersion,
    };
    return {
      description: await pluginRegistry.describe(pin, pluginInput),
      normalizationVersion: pluginRegistry.normalizationVersion(pin),
      pluginId: pin.id,
      pluginVersion: pin.version,
    };
  },
  approvals,
  upstream: {
    call: (input) => input.upstreamId === SELF_UPSTREAM_ID
      ? callSelfTool({
          journal, upstreams, configuredUpstreams,
          catalogFor: (tokenId) => catalogFor(tokenId, false),
          inspectTool, canManage: canManageApprovalMcp,
        }, input.clientTokenId, input.toolName, input.arguments ?? {})
      : upstreams.call(input),
  },
  journal,
});
const sourceToolsFor = async (refreshCatalogs: boolean) => {
  const sourceTools: CatalogSourceTool[] = SELF_TOOLS.map((tool) => ({
    upstreamId: SELF_UPSTREAM_ID,
    upstreamAlias: SELF_UPSTREAM_ALIAS,
    tool,
  }));
  for (const upstreamId of upstreams.upstreamIds()) {
    const configured = configuredUpstreams().find(
      (candidate) => candidate.id === upstreamId,
    );
    if (configured === undefined) continue;
    try {
      const catalog = refreshCatalogs
        ? await upstreams.refresh(upstreamId)
        : upstreams.getCatalog(upstreamId) ?? await upstreams.refresh(upstreamId);
      for (const tool of catalog.tools) {
        sourceTools.push({
          upstreamId,
          upstreamAlias: configured.alias,
          tool,
        });
      }
    } catch {
      const cached = upstreams.getCatalog(upstreamId);
      if (cached === undefined) continue;
      for (const tool of cached.tools) {
        sourceTools.push({
          upstreamId,
          upstreamAlias: configured.alias,
          tool,
        });
      }
    }
  }
  return sourceTools;
};
const catalogFor = async (
  tokenId: ClientTokenId,
  refreshCatalogs = true,
) => {
  const sourceTools = await sourceToolsFor(refreshCatalogs);
  const visible = new Set<string>();
  const approvalByTool = new Map<string, boolean>();
  const timeouts = timeoutsFor(tokenId);
  for (const source of sourceTools) {
    if (source.upstreamId === SELF_UPSTREAM_ID &&
      MANAGER_TOOL_NAMES.has(source.tool.name) && !canManageApprovalMcp(tokenId)) continue;
    const resolved = resolveProfileRules({
      clientTokenId: tokenId,
      upstreamId: source.upstreamId,
      toolName: source.tool.name,
      profiles: profiles(),
      rules: profileRules(),
      assignments: profileAssignments(),
    });
    const matchingDirect = directPolicies().filter(
      (policy) =>
        policy.enabled &&
        policy.clientTokenId === tokenId &&
        policy.upstreamId === source.upstreamId &&
        policy.toolName === source.tool.name,
    );
    const outcomes = [
      ...(resolved.outcome === 'unconfigured' ? [] : [resolved.outcome]),
      ...matchingDirect.map((policy) => policy.outcome),
    ];
    if (
      (outcomes.length > 0 || (source.upstreamId === SELF_UPSTREAM_ID && source.tool.name === 'inspect_tool')) &&
      !outcomes.includes('deny')
    ) {
      const publicName = `${source.upstreamAlias}__${source.tool.name}`;
      visible.add(publicName);
      approvalByTool.set(publicName, outcomes.includes('require_approval'));
    }
  }
  return buildTokenCatalog(
    tokenId,
    sourceTools.map((source) => {
      const approvalMayBeRequired = approvalByTool.get(
        `${source.upstreamAlias}__${source.tool.name}`,
      );
      return approvalMayBeRequired === undefined
        ? source
        : {
            ...source,
            tool: withPolicyDescription(source.tool, {
              approvalMayBeRequired,
              ...timeouts,
            }),
          };
    }),
    new Map([[tokenId, visible]]),
  );
};
const inspectTool = async (
  tokenId: ClientTokenId,
  toolName: string,
  argumentsValue: Record<string, unknown>,
): Promise<ToolInspection | undefined> => {
  const tool = (await catalogFor(tokenId, false)).find(
    (candidate) => candidate.name === toolName,
  );
  if (tool === undefined) return undefined;
  return evaluateToolInspection({
    publicToolName: toolName,
    clientTokenId: tokenId,
    upstreamId: tool.upstreamId,
    upstreamToolName: tool.upstreamToolName,
    argumentsValue,
    policies: [
      ...policiesFor(tokenId, tool.upstreamId, tool.upstreamToolName),
      ...(tool.upstreamId === SELF_UPSTREAM_ID
        ? selfInspectFallback(tokenId, tool.upstreamToolName) : []),
    ],
    grants: grants(),
    ...timeoutsFor(tokenId),
  });
};
const mcpGateway = new TokenScopedGateway({
  coordinator,
  catalogFor,
});
const mcpHandler = createMcpHttpHandler({
  allowedOrigins: config.oauthOrigins,
  originForHost: (host) => oauth.originForHost(host),
  resourceMetadataUrl: (origin) => origin === undefined
    ? undefined : `${origin}/.well-known/oauth-protected-resource/mcp`,
  authenticate: async (plaintext, origin) =>
    (origin === undefined ? undefined : oauth.authenticate(plaintext, origin)) ??
    (await tokens.authenticate(plaintext))?.id,
  gateway: mcpGateway,
});
const onCatalogChanged = () => mcpHandler.notifyToolsChanged();
upstreams.on('catalogChanged', onCatalogChanged);
let catalogRefreshRunning = false;
const catalogRefreshTimer = setInterval(() => {
  if (catalogRefreshRunning) return;
  catalogRefreshRunning = true;
  void Promise.allSettled(
    upstreams.upstreamIds().map((upstreamId) => upstreams.refresh(upstreamId)),
  ).finally(() => { catalogRefreshRunning = false; });
}, 30_000);
catalogRefreshTimer.unref();
const passkeys = new PasskeyService({
  rpName: 'Approval MCP Wrapper',
  rpId: config.rpId,
  expectedOrigin: config.expectedOrigin,
  repository: new StatePasskeyRepository(stateStore),
});
const upstreamsChanged = async () => {
  // Setup and admin share this path; the registry reads the newest stored
  // configuration inside its own queue.
  await upstreams.syncUpstreams(configuredUpstreams);
  mcpHandler.notifyToolsChanged();
};
const app = await buildServerApp({
  oauth,
  readiness: () =>
    readiness(config.dataDir, {
      stateLoaded: true,
      masterKeyLoaded: true,
    }),
  auth: {
    passkeys,
    sessions,
    recovery: new RecoveryService(new StateRecoveryRepository(stateStore)),
    secureCookies: config.secureCookies,
  },
});
const retention = startRetentionJob({
  journal,
  retentionDays: Number(process.env['APPROVAL_MCP_RETENTION_DAYS'] ?? 90),
});
await registerAdminRoutes(app, {
  sessions,
  state: stateStore,
  tokens,
  credentialVault,
  approvals,
  broker: approvalBroker,
  historyBroker,
  journal,
  getPlugins: () => pluginRegistry.list(),
  pluginManager,
  push: pushNotifications,
  onUpstreamsChanged: upstreamsChanged,
  onVisibilityChanged: () => mcpHandler.notifyToolsChanged(),
  discoverTools: (upstreamId) => upstreams.refresh(upstreamId),
});
const setup = new SetupService({
  state: stateStore,
  credentialVault,
  publicOrigin: config.expectedOrigin,
  onUpstreamsChanged: upstreamsChanged,
});
await registerSetupRoutes(app, {
  setup,
  passkeys,
  sessions,
  authenticateRequester: async (token) => {
    const record = await tokens.authenticate(token);
    return record === undefined ? undefined : { id: record.id, label: record.label };
  },
});
app.route({
  method: ['GET', 'POST', 'DELETE'],
  url: '/mcp',
  handler: async (request, reply) => {
    reply.hijack();
    await mcpHandler(request.raw, reply.raw, request.body);
  },
});
await app.register(fastifyStatic, {
  root: join(process.cwd(), 'apps', 'web', 'dist'),
  wildcard: false,
});
app.setNotFoundHandler((request, reply) => {
  if (request.method === 'GET' && !request.url.startsWith('/api/')) {
    return reply.sendFile('index.html');
  }
  return reply.code(404).send({
    error: {
      code: 'route.not_found',
      message: 'Route not found',
      requestId: request.id,
    },
  });
});

app.addHook('onClose', async () => {
  clearInterval(catalogRefreshTimer);
  upstreams.off('catalogChanged', onCatalogChanged);
  retention.close();
  await pluginManager.close();
  await mcpHandler.close();
  await upstreams.close();
  await stateStore.close();
});

await app.ready();
return { app, sessions };
}
