import { EventEmitter } from 'node:events';

import type { Upstream, UpstreamId } from '@approval-mcp/contracts';

import type { CredentialVault } from './credential-envelope.js';
import {
  OfficialMcpConnectionFactory,
  type McpConnection,
  type McpConnectionFactory,
  type McpTool,
} from './mcp-client.js';

export interface ToolCatalog {
  upstreamId: UpstreamId;
  refreshedAt: string;
  tools: readonly McpTool[];
}

export interface UpstreamCall {
  upstreamId: UpstreamId;
  toolName: string;
  arguments?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface UpstreamResourceRead {
  upstreamId: UpstreamId;
  uri: string;
  timeoutMs?: number;
}

export type UpstreamHealth =
  | { status: 'unknown' }
  | { status: 'healthy'; checkedAt: string }
  | { status: 'unhealthy'; checkedAt: string; error: string };

interface RegistryOptions {
  upstreams: readonly Upstream[];
  connectionFactory?: McpConnectionFactory;
  credentialVault?: CredentialVault;
  now?: () => Date;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown upstream error';
}

export class UpstreamRegistry extends EventEmitter {
  readonly #upstreams = new Map<UpstreamId, Upstream>();
  readonly #connections = new Map<UpstreamId, McpConnection>();
  readonly #catalogs = new Map<UpstreamId, ToolCatalog>();
  readonly #health = new Map<UpstreamId, UpstreamHealth>();
  readonly #refreshes = new Map<UpstreamId, Promise<ToolCatalog>>();
  readonly #connectionFactory: McpConnectionFactory;
  readonly #credentialVault: CredentialVault | undefined;
  readonly #now: () => Date;
  #generation = 0;
  #reconfiguration: Promise<void> = Promise.resolve();

  constructor(options: RegistryOptions) {
    super();
    for (const upstream of options.upstreams) {
      this.#upstreams.set(upstream.id, upstream);
    }
    this.#connectionFactory =
      options.connectionFactory ?? new OfficialMcpConnectionFactory();
    this.#credentialVault = options.credentialVault;
    this.#now = options.now ?? (() => new Date());
  }

  replaceUpstreams(upstreams: readonly Upstream[]): Promise<void> {
    return this.syncUpstreams(() => upstreams);
  }

  /**
   * Reconfigures the registry from `load`. Reconfigurations run one at a time,
   * and `load` runs inside that queue, so the newest stored configuration always
   * wins even when closing old connections takes a while.
   */
  syncUpstreams(load: () => readonly Upstream[]): Promise<void> {
    const run = this.#reconfiguration.then(async () => {
      // Install the new configuration before closing the old connections, so a
      // call that reconnects meanwhile already uses the new settings.
      this.#upstreams.clear();
      this.#catalogs.clear();
      this.#health.clear();
      for (const upstream of load()) {
        this.#upstreams.set(upstream.id, upstream);
      }
      await this.close();
    });
    this.#reconfiguration = run.catch(() => undefined);
    return run;
  }

  upstreamIds(): readonly UpstreamId[] {
    return [...this.#upstreams.keys()];
  }

  async refresh(upstreamId: UpstreamId): Promise<ToolCatalog> {
    this.#requireUpstream(upstreamId);
    const ongoing = this.#refreshes.get(upstreamId);
    if (ongoing !== undefined) return ongoing;
    const refresh = this.#refreshCatalog(upstreamId);
    this.#refreshes.set(upstreamId, refresh);
    try {
      return await refresh;
    } finally {
      if (this.#refreshes.get(upstreamId) === refresh) {
        this.#refreshes.delete(upstreamId);
      }
    }
  }

  async #refreshCatalog(upstreamId: UpstreamId): Promise<ToolCatalog> {
    const upstream = this.#requireUpstream(upstreamId);
    const generation = this.#generation;
    const previous = this.#connections.get(upstreamId);
    let connection = previous;
    try {
      if (connection === undefined) connection = await this.#connect(upstream);
      let result: Awaited<ReturnType<McpConnection['listTools']>>;
      try {
        result = await connection.listTools();
      } catch (error) {
        if (connection !== previous) throw error;
        connection = await this.#connect(upstream);
        result = await connection.listTools();
      }
      if (generation !== this.#generation) {
        throw new Error('Upstream configuration changed during discovery');
      }
      const tools = [...result.tools].sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      const checkedAt = this.#now().toISOString();
      const catalog: ToolCatalog = {
        upstreamId,
        refreshedAt: checkedAt,
        tools,
      };
      if (connection !== previous) {
        this.#connections.set(upstreamId, connection);
        if (previous !== undefined) await previous.close().catch(() => undefined);
      }
      const oldCatalog = this.#catalogs.get(upstreamId);
      this.#catalogs.set(upstreamId, catalog);
      this.#health.set(upstreamId, { status: 'healthy', checkedAt });
      if (oldCatalog === undefined || JSON.stringify(oldCatalog.tools) !== JSON.stringify(catalog.tools)) {
        this.emit('catalogChanged', catalog);
      }
      return catalog;
    } catch (error) {
      if (connection !== undefined && connection !== previous && this.#connections.get(upstreamId) !== connection) {
        await connection.close().catch(() => undefined);
      }
      if (generation === this.#generation) {
        this.#health.set(upstreamId, {
          status: 'unhealthy',
          checkedAt: this.#now().toISOString(),
          error: errorMessage(error),
        });
      }
      throw error;
    }
  }

  async #connect(upstream: Upstream): Promise<McpConnection> {
    const credentials = upstream.credentials === undefined
      ? undefined
      : this.#requireCredentialVault().decrypt(upstream.id, upstream.credentials);
    return this.#connectionFactory.connect({
      url: new URL(upstream.url),
      allowPrivateNetwork: upstream.allowPrivateNetwork,
      ...(credentials === undefined ? {} : { credentials }),
    });
  }

  getCatalog(upstreamId: UpstreamId): ToolCatalog | undefined {
    return this.#catalogs.get(upstreamId);
  }

  async call(input: UpstreamCall): Promise<unknown> {
    const connection =
      this.#connections.get(input.upstreamId) ??
      (await this.#connectAndReturn(input.upstreamId));
    return connection.callTool(
      {
        name: input.toolName,
        ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
      },
      {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      },
    );
  }

  async readResource(input: UpstreamResourceRead): Promise<unknown> {
    const connection =
      this.#connections.get(input.upstreamId) ??
      (await this.#connectAndReturn(input.upstreamId));
    return connection.readResource(
      { uri: input.uri },
      input.timeoutMs === undefined ? undefined : { timeoutMs: input.timeoutMs },
    );
  }

  health(upstreamId: UpstreamId): UpstreamHealth {
    this.#requireUpstream(upstreamId);
    return this.#health.get(upstreamId) ?? { status: 'unknown' };
  }

  async close(): Promise<void> {
    this.#generation += 1;
    // Detach first, so no call picks up a connection that is being replaced.
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.allSettled(this.#refreshes.values());
    await Promise.all(connections.map((connection) => connection.close()));
  }

  async #connectAndReturn(upstreamId: UpstreamId): Promise<McpConnection> {
    await this.refresh(upstreamId);
    const connection = this.#connections.get(upstreamId);
    if (connection === undefined) throw new Error('Upstream connection missing');
    return connection;
  }

  #requireCredentialVault(): CredentialVault {
    if (this.#credentialVault === undefined) {
      throw new Error('Credential vault is required for encrypted credentials');
    }
    return this.#credentialVault;
  }

  #requireUpstream(upstreamId: UpstreamId): Upstream {
    const upstream = this.#upstreams.get(upstreamId);
    if (upstream === undefined) {
      throw new Error(`Unknown upstream: ${upstreamId}`);
    }
    return upstream;
  }
}
