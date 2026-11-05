import type { ConfigStateStore } from '@approval-mcp/state-store';
import type { TokenService } from '@approval-mcp/gateway';
import type { ApprovalOrchestrator } from '@approval-mcp/gateway';
import type { CredentialVault, ToolCatalog } from '@approval-mcp/upstream';
import type { CallJournal } from '@approval-mcp/call-journal';
import type { UpstreamId } from '@approval-mcp/contracts';
import type { FastifyInstance } from 'fastify';

import type { SessionService } from '../session-store.js';
import { registerTokenRoutes } from './token-routes.js';
import { registerApprovalRoutes } from './approval-routes.js';
import { registerHistoryRoutes } from './history-routes.js';
import { registerGrantRoutes } from './grant-routes.js';
import { registerPolicyRoutes } from './policy-routes.js';
import { registerProfileRoutes } from './profile-routes.js';
import { registerPushRoutes, type PushAdminService } from './push-routes.js';
import { registerSystemRoutes } from './system-routes.js';
import { registerPluginRoutes } from './plugin-routes.js';
import type { PluginManager } from '../plugins/plugin-manager.js';
import { registerUpstreamRoutes } from './upstream-routes.js';
import {
  ApprovalEventBroker,
  HistoryEventBroker,
} from './sse-broker.js';

export interface AdminRouteOptions {
  sessions: SessionService;
  state: ConfigStateStore;
  tokens: TokenService;
  credentialVault?: CredentialVault;
  approvals?: ApprovalOrchestrator;
  journal?: CallJournal;
  broker?: ApprovalEventBroker;
  historyBroker?: HistoryEventBroker;
  pluginManager?: PluginManager;
  getPlugins?(): readonly Readonly<{ id: string; version: string; normalizationVersion: number }>[];
  plugins?: readonly Readonly<{
    id: string;
    version: string;
    normalizationVersion: number;
  }>[];
  push?: PushAdminService;
  onUpstreamsChanged?(): Promise<void>;
  onVisibilityChanged?(): void;
  discoverTools?(upstreamId: UpstreamId): Promise<ToolCatalog>;
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  options: AdminRouteOptions,
): Promise<void> {
  await registerTokenRoutes(app, options);
  await registerUpstreamRoutes(app, options);
  await registerPolicyRoutes(app, options);
  await registerProfileRoutes(app, options);
  await registerGrantRoutes(app, options);
  await registerApprovalRoutes(app, {
    ...options,
    broker: options.broker ?? new ApprovalEventBroker(),
  });
  await registerHistoryRoutes(app, {
    ...options,
    historyBroker: options.historyBroker ?? new HistoryEventBroker(),
  });
  await registerPushRoutes(app, options);
  await registerSystemRoutes(app, options);
  await registerPluginRoutes(app, options);
}

export * from './sse-broker.js';
