import { randomUUID } from 'node:crypto';

import type {
  EncryptedCredentialEnvelope,
  JsonValue,
  Upstream,
  UpstreamId,
} from '@approval-mcp/contracts';
import type { ConfigState, ConfigStateStore, StateOperation } from '@approval-mcp/state-store';
import type { CredentialVault, UpstreamCredentials } from '@approval-mcp/upstream';

import {
  parseCredentials,
  parseSetupDeclaration,
  withoutCredentials,
  type SetupDeclaration,
} from './setup-declaration.js';
import { SetupError } from './setup-error.js';
import {
  computeSetupPlan,
  type DesiredUpstream,
  type SetupAction,
  type SetupPlan,
  type SetupPlanItem,
} from './setup-plan.js';

export const SETUP_REQUEST_LIFETIME_MS = 15 * 60_000;
export const MAX_PENDING_SETUP_REQUESTS = 10;
/** How long a decided request stays readable, so a polling CLI sees the outcome. */
export const DECIDED_SETUP_RETENTION_MS = 5 * 60_000;

export type SetupRequestStatus = 'pending' | 'applied' | 'denied';

export interface SetupResult {
  alias: string;
  action: SetupAction;
  upstreamId: string;
}

/** On the approval page, an URL change also shows the address being replaced. */
export type PendingPlanItem = SetupPlanItem & { previousUrl?: string };

export interface PendingSetupRequest {
  id: string;
  source: string;
  createdAt: string;
  expiresAt: string;
  planDigest: string;
  items: PendingPlanItem[];
}

/**
 * Pending requests live only in memory: credentials of a request nobody approved
 * never reach the disk, and a restart simply drops them (the CLI is run again).
 */
interface SetupRequest {
  id: string;
  status: SetupRequestStatus;
  createdAt: Date;
  /** Approval deadline while pending; removal time once decided. */
  expiresAt: Date;
  /** Includes plaintext credentials until the request is decided. */
  declaration: SetupDeclaration;
  plan: SetupPlan;
  results?: SetupResult[];
}

export type SubmitResult =
  | { status: 'unchanged'; items: SetupPlanItem[] }
  | {
      status: 'pending';
      requestId: string;
      approvalUrl: string;
      expiresAt: string;
      planDigest: string;
      items: SetupPlanItem[];
    };

export interface SetupServiceOptions {
  state: ConfigStateStore;
  credentialVault: CredentialVault;
  publicOrigin: string;
  onUpstreamsChanged?(): Promise<void>;
  now?: () => Date;
}

function upstreamsOf(state: Readonly<ConfigState>): Upstream[] {
  return Object.values(state.upstreams).map((value) => value as unknown as Upstream);
}

function buildUpstream(input: {
  id: UpstreamId;
  alias: string;
  desired: DesiredUpstream;
  base: Upstream | undefined;
  source: string;
  now: string;
  credentials: EncryptedCredentialEnvelope | undefined;
}): Upstream {
  const { desired, base } = input;
  return {
    id: input.id,
    alias: input.alias,
    url: desired.url,
    allowPrivateNetwork: desired.allowPrivateNetwork,
    ...(desired.displayName === undefined ? {} : { displayName: desired.displayName }),
    ...(desired.description === undefined ? {} : { description: desired.description }),
    ...(desired.metadata === undefined ? {} : { metadata: desired.metadata }),
    // The plugin is assigned in the admin UI; setup keeps whatever is there.
    ...(base?.pluginId === undefined ? {} : { pluginId: base.pluginId }),
    ...(base?.pluginVersion === undefined ? {} : { pluginVersion: base.pluginVersion }),
    ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
    managedBy: input.source,
    schemaVersion: 1,
    createdAt: base?.createdAt ?? input.now,
    updatedAt: input.now,
    version: (base?.version ?? 0) + 1,
  };
}

export class SetupService {
  readonly #options: SetupServiceOptions;
  readonly #now: () => Date;
  readonly #requests = new Map<string, SetupRequest>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: SetupServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  /** Runs submit/approve/deny one at a time, so one request is never applied twice. */
  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #plan(declaration: SetupDeclaration): SetupPlan {
    return this.#options.state.read((state) => computeSetupPlan(declaration, {
      upstreams: upstreamsOf(state),
      readCredentials: (upstream) => upstream.credentials === undefined
        ? undefined
        : this.#options.credentialVault.decrypt(upstream.id, upstream.credentials),
    }));
  }

  #prune(): void {
    const now = this.#now().getTime();
    for (const [id, request] of this.#requests) {
      if (request.expiresAt.getTime() <= now) this.#requests.delete(id);
    }
  }

  #get(id: string): SetupRequest {
    this.#prune();
    const request = this.#requests.get(id);
    if (request === undefined) throw new SetupError('setup.request_not_found', 404);
    return request;
  }

  #pending(id: string): SetupRequest {
    const request = this.#get(id);
    if (request.status !== 'pending') throw new SetupError('setup.request_not_found', 404);
    return request;
  }

  #decide(request: SetupRequest, status: SetupRequestStatus, results?: SetupResult[]): void {
    request.status = status;
    request.expiresAt = new Date(this.#now().getTime() + DECIDED_SETUP_RETENTION_MS);
    request.declaration = withoutCredentials(request.declaration);
    if (results !== undefined) request.results = results;
  }

  submit(input: unknown): Promise<SubmitResult> {
    const declaration = parseSetupDeclaration(input);
    return this.#serialize(async () => {
      const plan = this.#plan(declaration);
      if (plan.items.every((item) => item.action === 'unchanged')) {
        return { status: 'unchanged', items: plan.items };
      }
      this.#prune();
      const pending = [...this.#requests.values()].filter((request) => request.status === 'pending');
      if (pending.length >= MAX_PENDING_SETUP_REQUESTS) {
        throw new SetupError('setup.too_many_pending', 429);
      }
      const now = this.#now();
      const request: SetupRequest = {
        id: randomUUID(),
        status: 'pending',
        createdAt: now,
        expiresAt: new Date(now.getTime() + SETUP_REQUEST_LIFETIME_MS),
        declaration,
        plan,
      };
      this.#requests.set(request.id, request);
      return {
        status: 'pending',
        requestId: request.id,
        approvalUrl: `${this.#options.publicOrigin}/setup/requests/${request.id}`,
        expiresAt: request.expiresAt.toISOString(),
        planDigest: plan.digest,
        items: plan.items,
      };
    });
  }

  status(id: string): { status: SetupRequestStatus; items: SetupPlanItem[]; results?: SetupResult[] } {
    const request = this.#get(id);
    return {
      status: request.status,
      items: request.plan.items,
      ...(request.results === undefined ? {} : { results: request.results }),
    };
  }

  pending(id: string): PendingSetupRequest {
    const request = this.#pending(id);
    const stored = this.#options.state.read((state) =>
      new Map(upstreamsOf(state).map((upstream) => [upstream.id as string, upstream])));
    return {
      id: request.id,
      source: request.declaration.source,
      createdAt: request.createdAt.toISOString(),
      expiresAt: request.expiresAt.toISOString(),
      planDigest: request.plan.digest,
      items: request.plan.items.map((item) => {
        const previousUrl = item.changes.includes('url') && item.upstreamId !== undefined
          ? stored.get(item.upstreamId)?.url
          : undefined;
        return previousUrl === undefined ? item : { ...item, previousUrl };
      }),
    };
  }

  #enteredCredentials(plan: SetupPlan, value: unknown): Map<string, UpstreamCredentials> {
    const required = new Set(plan.items
      .filter((item) => item.credentials === 'required')
      .map((item) => item.alias));
    if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
      throw new SetupError('input.invalid');
    }
    const entered = new Map<string, UpstreamCredentials>();
    for (const [alias, credentials] of Object.entries((value ?? {}) as Record<string, unknown>)) {
      if (!required.has(alias)) throw new SetupError('setup.credentials_unexpected');
      entered.set(alias, parseCredentials(credentials));
    }
    if ([...required].some((alias) => !entered.has(alias))) {
      throw new SetupError('setup.credentials_missing');
    }
    return entered;
  }

  #applyOperations(
    request: SetupRequest,
    entered: ReadonlyMap<string, UpstreamCredentials>,
  ): { operations: StateOperation[]; results: SetupResult[] } {
    const vault = this.#options.credentialVault;
    const now = this.#now().toISOString();
    const existing = this.#options.state.read((state) =>
      new Map(upstreamsOf(state).map((upstream) => [upstream.id as string, upstream])));
    const declared = new Map(request.declaration.upstreams.map((item) => [item.alias, item]));
    const operations: StateOperation[] = [];
    const results: SetupResult[] = [];
    for (const item of request.plan.items) {
      if (item.action === 'unchanged') {
        results.push({ alias: item.alias, action: 'unchanged', upstreamId: item.upstreamId ?? '' });
        continue;
      }
      const upstreamId = (item.upstreamId ?? randomUUID()) as UpstreamId;
      const base = item.upstreamId === undefined ? undefined : existing.get(item.upstreamId);
      const plaintext = item.credentials === 'provided'
        ? declared.get(item.alias)?.credentials
        : item.credentials === 'required'
          ? entered.get(item.alias)
          : undefined;
      const credentials = item.credentials === 'keep'
        ? base?.credentials
        : plaintext === undefined
          ? undefined
          : vault.encrypt(upstreamId, plaintext);
      const upstream = buildUpstream({
        id: upstreamId,
        alias: item.alias,
        desired: item.desired,
        base,
        source: request.declaration.source,
        now,
        credentials,
      });
      operations.push({
        type: 'record.upserted',
        collection: 'upstreams',
        id: upstreamId,
        value: upstream as unknown as JsonValue,
      });
      results.push({ alias: item.alias, action: item.action, upstreamId });
    }
    return { operations, results };
  }

  approve(
    id: string,
    input: { planDigest: string; credentials: unknown },
  ): Promise<{ status: 'applied'; results: SetupResult[] }> {
    return this.#serialize(async () => {
      const request = this.#pending(id);
      if (input.planDigest !== request.plan.digest) {
        throw new SetupError('setup.plan_mismatch', 409);
      }
      const entered = this.#enteredCredentials(request.plan, input.credentials);
      // Upstreams may have changed since submission (for example by hand in the admin UI).
      // A different plan means the operator approved something else, so start over.
      let current: SetupPlan | undefined;
      try {
        current = this.#plan(request.declaration);
      } catch (error) {
        if (!(error instanceof SetupError)) throw error;
      }
      if (current?.digest !== request.plan.digest) {
        this.#requests.delete(id);
        throw new SetupError('setup.plan_stale', 409);
      }
      const { operations, results } = this.#applyOperations(request, entered);
      if (operations.length > 0) {
        await this.#options.state.mutate({ type: 'records.batch', operations });
      }
      this.#decide(request, 'applied', results);
      await this.#options.onUpstreamsChanged?.();
      return { status: 'applied', results };
    });
  }

  deny(id: string): Promise<{ status: 'denied' }> {
    return this.#serialize(async () => {
      this.#decide(this.#pending(id), 'denied');
      return { status: 'denied' };
    });
  }
}
