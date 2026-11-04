import { randomUUID } from 'node:crypto';

import { MAX_DENIAL_REASON_LENGTH } from '@approval-mcp/contracts';
import type {
  AdminId,
  Approval,
  ApprovalDecision,
  ApprovalId,
  ApprovalOutcome,
  ApprovalRequestInput,
  ClientTokenId,
  Grant,
  GrantId,
} from '@approval-mcp/contracts';

export interface ApprovalRecord {
  approval: Approval;
  request: ApprovalRequestInput;
  grant?: Grant;
}

export interface ApprovalRepository {
  create(record: ApprovalRecord): Promise<void>;
  find(id: ApprovalId): Promise<ApprovalRecord | undefined>;
  list(): Promise<readonly ApprovalRecord[]>;
  transition(
    id: ApprovalId,
    update: (current: ApprovalRecord) => ApprovalRecord,
  ): Promise<ApprovalRecord>;
}

export class ApprovalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalConflictError';
  }
}

export class InMemoryApprovalRepository implements ApprovalRepository {
  readonly #records = new Map<ApprovalId, ApprovalRecord>();
  #queue: Promise<void> = Promise.resolve();

  async create(record: ApprovalRecord): Promise<void> {
    await this.#serialized(() => {
      if (this.#records.has(record.approval.id)) {
        throw new ApprovalConflictError('Approval already exists');
      }
      this.#records.set(record.approval.id, structuredClone(record));
    });
  }

  async find(id: ApprovalId): Promise<ApprovalRecord | undefined> {
    await this.#queue;
    const record = this.#records.get(id);
    return record === undefined ? undefined : structuredClone(record);
  }

  async list(): Promise<readonly ApprovalRecord[]> {
    await this.#queue;
    return [...this.#records.values()].map((record) => structuredClone(record));
  }

  async transition(
    id: ApprovalId,
    update: (current: ApprovalRecord) => ApprovalRecord,
  ): Promise<ApprovalRecord> {
    let result: ApprovalRecord | undefined;
    await this.#serialized(() => {
      const current = this.#records.get(id);
      if (current === undefined) throw new Error(`Unknown approval: ${id}`);
      result = structuredClone(update(structuredClone(current)));
      this.#records.set(id, result);
    });
    if (result === undefined) throw new Error('Approval transition failed');
    return structuredClone(result);
  }

  async #serialized(operation: () => void): Promise<void> {
    const run = this.#queue.then(operation);
    this.#queue = run.catch(() => undefined);
    await run;
  }
}

interface PendingWaiter {
  resolve(outcome: ApprovalOutcome): void;
  removeAbortListener(): void;
  clearExpiry(): void;
}

function terminalRequest(
  request: ApprovalRequestInput,
): ApprovalRequestInput {
  const { presentation: _presentation, ...withoutPresentation } = request;
  return { ...withoutPresentation, context: {} };
}

function terminalApproval(
  record: ApprovalRecord,
  status: 'abandoned' | 'expired' | 'interrupted',
  reasonCode: string,
  now: string,
): ApprovalRecord {
  if (record.approval.status !== 'pending') {
    throw new ApprovalConflictError('Approval is already terminal');
  }
  return {
    ...record,
    request: terminalRequest(record.request),
    approval: {
      ...record.approval,
      status,
      reasonCode,
      updatedAt: now,
      version: record.approval.version + 1,
    },
  };
}

export class ApprovalOrchestrator {
  readonly #repository: ApprovalRepository;
  readonly #pending = new Map<ApprovalId, PendingWaiter>();
  readonly #now: () => Date;
  readonly #isExplicitlyDenied: (input: ApprovalRequestInput) => boolean;
  readonly #onChanged: (approval: Approval) => void;

  constructor(
    repository: ApprovalRepository,
    now: () => Date = () => new Date(),
    isExplicitlyDenied: (input: ApprovalRequestInput) => boolean = () => false,
    onChanged: (approval: Approval) => void = () => undefined,
  ) {
    this.#repository = repository;
    this.#now = now;
    this.#isExplicitlyDenied = isExplicitlyDenied;
    this.#onChanged = onChanged;
  }

  async request(
    input: ApprovalRequestInput,
    signal: AbortSignal,
  ): Promise<ApprovalOutcome> {
    const now = this.#now().toISOString();
    if (input.expiresAt <= now) {
      throw new Error('Approval request is already expired');
    }
    const approval: Approval = {
      id: randomUUID() as ApprovalId,
      callId: input.callId,
      requestHash: input.requestHash,
      status: 'pending',
      reasonCode: input.reasonCode,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await this.#repository.create({ approval, request: structuredClone(input) });
    this.#onChanged(structuredClone(approval));

    return new Promise<ApprovalOutcome>((resolve) => {
      const onAbort = () => {
        void this.#finishPending(
          approval.id,
          'abandoned',
          'call.disconnected',
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const expiryTimer = setTimeout(() => {
        void this.#finishPending(approval.id, 'expired', 'approval.expired');
      }, Math.max(0, new Date(input.expiresAt).getTime() - this.#now().getTime()));
      expiryTimer.unref();
      this.#pending.set(approval.id, {
        resolve,
        removeAbortListener: () =>
          signal.removeEventListener('abort', onAbort),
        clearExpiry: () => clearTimeout(expiryTimer),
      });
      if (signal.aborted) onAbort();
    });
  }

  async decide(
    id: ApprovalId,
    decision: ApprovalDecision,
    actor: AdminId,
    expectedRequestHash: string,
  ): Promise<Approval> {
    const now = this.#now().toISOString();
    const record = await this.#repository.transition(id, (current) => {
      if (current.approval.status !== 'pending') {
        throw new ApprovalConflictError('Approval is already terminal');
      }
      if (
        current.approval.requestHash !== expectedRequestHash ||
        current.request.requestHash !== expectedRequestHash
      ) {
        throw new ApprovalConflictError('Approval request hash changed');
      }
      if (current.request.expiresAt <= now) {
        return terminalApproval(current, 'expired', 'approval.expired', now);
      }
      if (this.#isExplicitlyDenied(current.request)) {
        return {
          ...current,
          request: terminalRequest(current.request),
          approval: {
            ...current.approval,
            status: 'denied',
            reasonCode: 'policy.explicit_deny',
            decidedAt: now,
            decidedBy: actor,
            updatedAt: now,
            version: current.approval.version + 1,
          },
        };
      }
      if (decision.action === 'deny') {
        const denialReason = decision.reason?.trim();
        if (
          denialReason !== undefined &&
          denialReason.length > MAX_DENIAL_REASON_LENGTH
        ) {
          throw new ApprovalConflictError('Denial reason is too long');
        }
        return {
          ...current,
          request: terminalRequest(current.request),
          approval: {
            ...current.approval,
            status: 'denied',
            reasonCode: 'approval.denied',
            ...(denialReason === undefined || denialReason.length === 0
              ? {}
              : { denialReason }),
            decidedAt: now,
            decidedBy: actor,
            updatedAt: now,
            version: current.approval.version + 1,
          },
        };
      }
      const grant = this.#createGrant(current.request, decision, actor, now);
      return {
        ...current,
        request: terminalRequest(current.request),
        grant,
        approval: {
          ...current.approval,
          status: 'approved',
          reasonCode: 'approval.approved',
          decidedAt: now,
          decidedBy: actor,
          updatedAt: now,
          version: current.approval.version + 1,
        },
      };
    });
    this.#onChanged(structuredClone(record.approval));
    this.#resolve(record);
    return structuredClone(record.approval);
  }

  async interruptAll(reasonCode: 'server.restarted'): Promise<void> {
    const pending = (await this.#repository.list()).filter(
      (record) => record.approval.status === 'pending',
    );
    await Promise.all(
      pending.map((record) =>
        this.#finishPending(record.approval.id, 'interrupted', reasonCode),
      ),
    );
  }

  async interruptForToken(clientTokenId: ClientTokenId): Promise<void> {
    const pending = (await this.#repository.list()).filter(
      (record) => record.approval.status === 'pending' &&
        record.request.clientTokenId === clientTokenId,
    );
    await Promise.all(pending.map((record) =>
      this.#finishPending(record.approval.id, 'interrupted', 'token.deleted'),
    ));
  }

  #createGrant(
    request: ApprovalRequestInput,
    decision: Exclude<ApprovalDecision, { action: 'deny' }>,
    actor: AdminId,
    now: string,
  ): Grant {
    let expiresAt: string | undefined;
    if (decision.action === 'allow_until') {
      const expiryTime = Date.parse(decision.expiresAt);
      if (!Number.isFinite(expiryTime) || expiryTime <= Date.parse(now)) {
        throw new ApprovalConflictError('Grant expiry must be a valid future date');
      }
      expiresAt = new Date(expiryTime).toISOString();
    }
    const toolWide = decision.action === 'allow_until' &&
      decision.scopeId === undefined && decision.predicate === undefined;
    const selectedScope =
      decision.action === 'allow_once'
        ? undefined
        : this.#selectedScope(request, decision.scopeId);
    if (
      selectedScope !== undefined &&
      decision.action !== 'allow_once' &&
      !(selectedScope.durations ?? ['hour', 'forever']).includes(
        decision.action === 'allow_forever' ? 'forever' : 'hour',
      )
    ) {
      throw new ApprovalConflictError(
        'Grant duration is not allowed for the selected scope',
      );
    }
    if (
      (selectedScope !== undefined || toolWide) &&
      decision.action === 'allow_until' &&
      expiresAt !== undefined && Date.parse(expiresAt) >
        new Date(now).getTime() + 60 * 60_000 + 1_000
    ) {
      throw new ApprovalConflictError(
        'Hour grant cannot exceed one hour',
      );
    }
    const predicates =
      decision.action === 'allow_once'
        ? []
        : selectedScope === undefined
          ? decision.predicate === undefined
            ? []
            : [decision.predicate]
          : [...selectedScope.predicates];
    if (decision.action !== 'allow_once' && predicates.length === 0 && !toolWide) {
      throw new ApprovalConflictError(
        'Reusable grant requires a constrained scope',
      );
    }
    return {
      id: randomUUID() as GrantId,
      clientTokenId: request.clientTokenId,
      upstreamId: request.upstreamId,
      toolName: request.toolName,
      predicates,
      normalizationVersion: request.normalizationVersion,
      approvedBy: actor,
      ...(selectedScope === undefined || request.presentation === undefined
        ? {}
        : {
            presentation: {
              source: request.presentation.source,
              ...(request.presentation.pluginId === undefined
                ? {}
                : { pluginId: request.presentation.pluginId }),
              ...(request.presentation.pluginVersion === undefined
                ? {}
                : { pluginVersion: request.presentation.pluginVersion }),
              title: structuredClone(request.presentation.title),
              scope: structuredClone(selectedScope.label),
            },
          }),
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      version: 1,
      ...(decision.action === 'allow_once'
        ? { requestHash: request.requestHash, callId: request.callId }
        : {}),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  }

  #selectedScope(
    request: ApprovalRequestInput,
    scopeId: string | undefined,
  ) {
    if (scopeId === undefined) return undefined;
    const scope = request.presentation?.proposedScopes.find(
      (candidate) => candidate.id === scopeId,
    );
    if (scope === undefined) {
      throw new ApprovalConflictError('Unknown proposed grant scope');
    }
    return scope;
  }

  async #finishPending(
    id: ApprovalId,
    status: 'abandoned' | 'expired' | 'interrupted',
    reasonCode: string,
  ): Promise<void> {
    try {
      const now = this.#now().toISOString();
      const record = await this.#repository.transition(id, (current) =>
        terminalApproval(current, status, reasonCode, now),
      );
      this.#onChanged(structuredClone(record.approval));
      this.#resolve(record);
    } catch (error) {
      if (!(error instanceof ApprovalConflictError)) throw error;
    }
  }

  #resolve(record: ApprovalRecord): void {
    const waiter = this.#pending.get(record.approval.id);
    if (waiter === undefined) return;
    waiter.removeAbortListener();
    waiter.clearExpiry();
    this.#pending.delete(record.approval.id);
    if (record.approval.status === 'approved' && record.grant !== undefined) {
      waiter.resolve({
        status: 'approved',
        approval: structuredClone(record.approval),
        grant: structuredClone(record.grant),
      });
    } else if (record.approval.status === 'denied') {
      waiter.resolve({
        status: 'denied',
        approval: structuredClone(record.approval),
      });
    } else if (
      record.approval.status === 'abandoned' ||
      record.approval.status === 'expired' ||
      record.approval.status === 'interrupted'
    ) {
      waiter.resolve({
        status: record.approval.status,
        approval: structuredClone(record.approval),
      });
    }
  }
}
