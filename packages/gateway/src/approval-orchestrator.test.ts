import type {
  AdminId,
  ApprovalId,
  ApprovalRequestInput,
  CallId,
  ClientTokenId,
  UpstreamId,
} from '@approval-mcp/contracts';
import { describe, expect, it } from 'vitest';
import { grantMatches } from '@approval-mcp/policy';

import {
  ApprovalConflictError,
  ApprovalOrchestrator,
  InMemoryApprovalRepository,
} from './approval-orchestrator.js';

const actor = 'admin-1' as AdminId;

function input(call = 'call-1'): ApprovalRequestInput {
  return {
    callId: call as CallId,
    clientTokenId: 'token-1' as ClientTokenId,
    upstreamId: 'upstream-1' as UpstreamId,
    toolName: 'send_message',
    requestHash: `hash-${call}`,
    context: { groupId: 'family' },
    normalizationVersion: 1,
    reasonCode: 'approval.required',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

async function pendingId(repository: InMemoryApprovalRepository): Promise<ApprovalId> {
  const pending = (await repository.list()).find(
    (record) => record.approval.status === 'pending',
  );
  if (pending === undefined) throw new Error('Expected a pending approval');
  return pending.approval.id;
}

describe('ApprovalOrchestrator', () => {
  it('interrupts only pending approvals for a deleted agent', async () => {
    const repository = new InMemoryApprovalRepository();
    const orchestrator = new ApprovalOrchestrator(repository);
    const first = orchestrator.request(input('first'), new AbortController().signal);
    const secondInput = { ...input('second'), clientTokenId: 'token-2' as ClientTokenId };
    const second = orchestrator.request(secondInput, new AbortController().signal);
    await repository.list();

    await orchestrator.interruptForToken('token-1' as ClientTokenId);

    await expect(first).resolves.toMatchObject({ status: 'interrupted' });
    const remaining = (await repository.list()).find((record) => record.request.clientTokenId === 'token-2');
    expect(remaining?.approval.status).toBe('pending');
    if (remaining === undefined) throw new Error('Missing second approval');
    await orchestrator.decide(remaining.approval.id, { action: 'deny' }, actor, secondInput.requestHash);
    await expect(second).resolves.toMatchObject({ status: 'denied' });
  });

  it('notifies listeners immediately after persisting a pending approval', async () => {
    const repository = new InMemoryApprovalRepository();
    const statuses: string[] = [];
    const controller = new AbortController();
    const orchestrator = new ApprovalOrchestrator(
      repository,
      () => new Date(),
      () => false,
      (approval) => statuses.push(approval.status),
    );

    const waiting = orchestrator.request(input(), controller.signal);
    await pendingId(repository);

    expect(statuses).toEqual(['pending']);
    controller.abort();
    await waiting;
    expect(statuses).toEqual(['pending', 'abandoned']);
  });

  it('transitions pending to approved and creates a one-time grant', async () => {
    const repository = new InMemoryApprovalRepository();
    const orchestrator = new ApprovalOrchestrator(repository);
    const waiting = orchestrator.request(input(), new AbortController().signal);
    const id = await pendingId(repository);

    await orchestrator.decide(
      id,
      { action: 'allow_once' },
      actor,
      'hash-call-1',
    );

    await expect(waiting).resolves.toMatchObject({
      status: 'approved',
      grant: { callId: 'call-1' },
    });
  });

  it('creates a reusable grant only from a server-stored plugin scope', async () => {
    const repository = new InMemoryApprovalRepository();
    const orchestrator = new ApprovalOrchestrator(repository);
    const request = input();
    request.presentation = {
      source: 'plugin',
      pluginId: 'minutes',
      pluginVersion: '1.0.0',
      title: {
        key: 'minutes.send_message',
        fallback: { en: 'Send message', cs: 'Odeslat zprávu' },
      },
      sections: [],
      proposedScopes: [
        {
          id: 'conversation',
          label: {
            key: 'minutes.scope.conversation',
            fallback: {
              en: 'Conversation: Family',
              cs: 'Konverzace: Rodina',
            },
          },
          predicates: [
            { path: '/conversationId', operator: 'equals', value: 'family' },
          ],
          durations: ['hour', 'forever'],
        },
      ],
    };
    const waiting = orchestrator.request(
      request,
      new AbortController().signal,
    );
    const id = await pendingId(repository);

    await orchestrator.decide(
      id,
      { action: 'allow_forever', scopeId: 'conversation' },
      actor,
      request.requestHash,
    );

    await expect(waiting).resolves.toMatchObject({
      status: 'approved',
      grant: {
        predicates: [
          { path: '/conversationId', operator: 'equals', value: 'family' },
        ],
        presentation: {
          pluginId: 'minutes',
          scope: { fallback: { cs: 'Konverzace: Rodina' } },
        },
      },
    });
  });

  it.each(['plugin', 'generic', undefined] as const)(
    'creates an unscoped hour grant for a %s presentation',
    async (source) => {
      const repository = new InMemoryApprovalRepository();
      const now = new Date();
      const orchestrator = new ApprovalOrchestrator(repository, () => now);
      const request = input();
      if (source !== undefined) {
        request.presentation = {
          source,
          title: { key: 'title', fallback: { en: 'Send message' } },
          sections: [],
          proposedScopes: [],
        };
      }
      const waiting = orchestrator.request(request, new AbortController().signal);
      const id = await pendingId(repository);
      const expiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();
      await orchestrator.decide(id, { action: 'allow_until', expiresAt }, actor, request.requestHash);
      const outcome = await waiting;
      if (outcome.status !== 'approved') throw new Error('Expected approval');
      const grant = outcome.grant;
      expect(grant.predicates).toEqual([]);
      expect(grant.expiresAt).toBe(expiresAt);
      expect(grant).not.toHaveProperty('callId');
      expect(grant).not.toHaveProperty('requestHash');
      expect((await repository.find(id))?.grant).toEqual(grant);

      const nextCall = {
        clientTokenId: request.clientTokenId,
        upstreamId: request.upstreamId,
        toolName: request.toolName,
        normalizationVersion: request.normalizationVersion,
        context: { groupId: 'different-chat', message: 'different content' },
        callId: 'next-call',
        requestHash: 'different-hash',
        now: now.toISOString(),
      };
      expect(grantMatches(grant, nextCall)).toBe(true);
      for (const overrides of [
        { clientTokenId: 'another-agent' },
        { upstreamId: 'another-upstream' },
        { toolName: 'another-tool' },
        { normalizationVersion: 2 },
        { now: expiresAt },
        { now: new Date(Date.parse(expiresAt) + 1_000).toISOString() },
      ]) {
        expect(grantMatches(grant, { ...nextCall, ...overrides })).toBe(false);
      }
      expect(grantMatches({ ...grant, revokedAt: now.toISOString() }, nextCall)).toBe(false);
    },
  );

  it('rejects permanent, invalid and overlong unscoped grants without closing approval', async () => {
    const repository = new InMemoryApprovalRepository();
    const now = new Date();
    const orchestrator = new ApprovalOrchestrator(repository, () => now);
    const controller = new AbortController();
    const request = input();
    const waiting = orchestrator.request(request, controller.signal);
    const id = await pendingId(repository);

    await expect(orchestrator.decide(id, { action: 'allow_forever' }, actor, request.requestHash))
      .rejects.toThrow('constrained scope');
    for (const expiresAt of [
      'invalid-date',
      now.toISOString(),
      new Date(now.getTime() + 2 * 60 * 60_000).toISOString(),
    ]) {
      await expect(orchestrator.decide(id, { action: 'allow_until', expiresAt }, actor, request.requestHash))
        .rejects.toBeInstanceOf(ApprovalConflictError);
    }
    expect((await repository.find(id))?.approval.status).toBe('pending');
    expect((await repository.find(id))?.grant).toBeUndefined();
    controller.abort();
    await waiting;
  });

  it('rejects a reusable grant with an unknown plugin scope', async () => {
    const repository = new InMemoryApprovalRepository();
    const orchestrator = new ApprovalOrchestrator(repository);
    const controller = new AbortController();
    const request = input();
    request.presentation = {
      source: 'plugin',
      title: { key: 'title', fallback: { en: 'Title' } },
      sections: [],
      proposedScopes: [],
    };
    const waiting = orchestrator.request(request, controller.signal);
    const id = await pendingId(repository);

    await expect(
      orchestrator.decide(
        id,
        { action: 'allow_forever', scopeId: 'invented' },
        actor,
        request.requestHash,
      ),
    ).rejects.toThrow('scope');
    controller.abort();
    await waiting;
  });

  it('supports deny and rejects every second terminal transition', async () => {
    const repository = new InMemoryApprovalRepository();
    const orchestrator = new ApprovalOrchestrator(repository);
    const waiting = orchestrator.request(input(), new AbortController().signal);
    const id = await pendingId(repository);
    await orchestrator.decide(
      id,
      { action: 'deny', reason: '  This would notify the wrong group.  ' },
      actor,
      'hash-call-1',
    );

    await expect(waiting).resolves.toMatchObject({
      status: 'denied',
      approval: {
        denialReason: 'This would notify the wrong group.',
      },
    });
    await expect(repository.find(id)).resolves.toMatchObject({
      approval: { denialReason: 'This would notify the wrong group.' },
      request: { context: {} },
    });
    expect((await repository.find(id))?.request).not.toHaveProperty(
      'presentation',
    );
    await expect(
      orchestrator.decide(id, { action: 'deny' }, actor, 'hash-call-1'),
    ).rejects.toBeInstanceOf(ApprovalConflictError);
  });

  it('abandons a pending approval before resolving an aborted request', async () => {
    const repository = new InMemoryApprovalRepository();
    const orchestrator = new ApprovalOrchestrator(repository);
    const controller = new AbortController();
    const waiting = orchestrator.request(input(), controller.signal);
    const id = await pendingId(repository);

    controller.abort();

    await expect(waiting).resolves.toMatchObject({ status: 'abandoned' });
    await expect(repository.find(id)).resolves.toMatchObject({
      approval: { status: 'abandoned' },
    });
  });

  it('rejects a changed request hash', async () => {
    const repository = new InMemoryApprovalRepository();
    const orchestrator = new ApprovalOrchestrator(repository);
    void orchestrator.request(input(), new AbortController().signal);
    const id = await pendingId(repository);

    await expect(
      orchestrator.decide(id, { action: 'allow_once' }, actor, 'changed'),
    ).rejects.toThrow('hash');
  });

  it('expires a pending request before applying a late decision', async () => {
    const repository = new InMemoryApprovalRepository();
    let current = Date.now();
    const orchestrator = new ApprovalOrchestrator(
      repository,
      () => new Date(current),
    );
    const request = input();
    request.expiresAt = new Date(current + 1_000).toISOString();
    const waiting = orchestrator.request(request, new AbortController().signal);
    const id = await pendingId(repository);
    current += 2_000;

    await orchestrator.decide(id, { action: 'allow_once' }, actor, request.requestHash);

    await expect(waiting).resolves.toMatchObject({ status: 'expired' });
  });

  it('revalidates an explicit deny at decision time', async () => {
    const repository = new InMemoryApprovalRepository();
    let denied = false;
    const orchestrator = new ApprovalOrchestrator(
      repository,
      () => new Date(),
      () => denied,
    );
    const waiting = orchestrator.request(input(), new AbortController().signal);
    const id = await pendingId(repository);
    denied = true;

    await orchestrator.decide(
      id,
      { action: 'allow_once' },
      actor,
      'hash-call-1',
    );

    await expect(waiting).resolves.toMatchObject({
      status: 'denied',
      approval: { reasonCode: 'policy.explicit_deny' },
    });
  });

  it('allows exactly one of two concurrent decisions', async () => {
    const repository = new InMemoryApprovalRepository();
    const orchestrator = new ApprovalOrchestrator(repository);
    const waiting = orchestrator.request(input(), new AbortController().signal);
    const id = await pendingId(repository);

    const results = await Promise.allSettled([
      orchestrator.decide(id, { action: 'allow_once' }, actor, 'hash-call-1'),
      orchestrator.decide(id, { action: 'deny' }, actor, 'hash-call-1'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(waiting).resolves.toHaveProperty('status');
  });

  it('interrupts persisted pending approvals on startup recovery', async () => {
    const repository = new InMemoryApprovalRepository();
    const first = new ApprovalOrchestrator(repository);
    void first.request(input(), new AbortController().signal);
    const second = new ApprovalOrchestrator(repository);

    await second.interruptAll('server.restarted');

    await expect(repository.list()).resolves.toEqual([
      expect.objectContaining({ approval: expect.objectContaining({ status: 'interrupted' }) }),
    ]);
  });
});
