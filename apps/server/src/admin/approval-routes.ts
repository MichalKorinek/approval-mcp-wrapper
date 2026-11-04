import type {
  AdminId,
  ApprovalDecision,
  ApprovalId,
} from '@approval-mcp/contracts';
import { MAX_DENIAL_REASON_LENGTH } from '@approval-mcp/contracts';
import type {
  ApprovalOrchestrator,
  ApprovalRecord,
} from '@approval-mcp/gateway';
import type { ConfigStateStore } from '@approval-mcp/state-store';
import type { FastifyInstance } from 'fastify';

import type { SessionService } from '../session-store.js';
import { authorizeAdmin } from './authorization.js';
import { entityDisplayNames } from './entity-display-names.js';
import type { ApprovalEventBroker } from './sse-broker.js';

export function parseApprovalDecision(value: unknown): ApprovalDecision | undefined {
  if (typeof value !== 'object' || value === null || !('action' in value)) {
    return undefined;
  }
  const decision = value as Record<string, unknown>;
  if (decision['action'] === 'deny') {
    if (
      decision['reason'] !== undefined &&
      (typeof decision['reason'] !== 'string' ||
        decision['reason'].length > MAX_DENIAL_REASON_LENGTH)
    ) {
      return undefined;
    }
    const reason =
      typeof decision['reason'] === 'string'
        ? decision['reason'].trim()
        : undefined;
    return reason === undefined || reason.length === 0
      ? { action: 'deny' }
      : { action: 'deny', reason };
  }
  return ['allow_once', 'allow_until', 'allow_forever'].includes(
    String(decision['action']),
  )
    ? (value as ApprovalDecision)
    : undefined;
}

export function openSseResponse(response: {
  writeHead(
    statusCode: number,
    headers: Record<string, string>,
  ): unknown;
  flushHeaders(): void;
  write(chunk: string): unknown;
}): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  response.flushHeaders();
  response.write(': connected\n\n');
}

export async function registerApprovalRoutes(
  app: FastifyInstance,
  options: {
    sessions: SessionService;
    state: ConfigStateStore;
    approvals?: ApprovalOrchestrator;
    broker: ApprovalEventBroker;
  },
): Promise<void> {
  app.get('/api/admin/approvals', async (request, reply) => {
    if (!await authorizeAdmin(request, reply, options.sessions, false)) return;
    return options.state.read((state) =>
      Object.values(state.approvals).filter((value) =>
        (value as unknown as ApprovalRecord).approval.status === 'pending',
      ).map((value) => {
        const record = value as unknown as ApprovalRecord;
        return {
          ...record,
          ...entityDisplayNames(
            state,
            record.request.clientTokenId,
            record.request.upstreamId,
          ),
        };
      }),
    );
  });

  app.post('/api/admin/approvals/:id/decision', async (request, reply) => {
    const session = await authorizeAdmin(request, reply, options.sessions, true);
    if (session === undefined) return;
    if (options.approvals === undefined) throw new Error('Approval service unavailable');
    const { id } = request.params as { id: string };
    const body = request.body as {
      decision?: unknown;
      requestHash?: unknown;
    };
    const decision = parseApprovalDecision(body.decision);
    if (
      decision === undefined ||
      typeof body.requestHash !== 'string' ||
      body.requestHash.length === 0
    ) {
      reply.code(400);
      return { error: { code: 'input.invalid', message: 'Invalid approval decision', requestId: request.id } };
    }
    const approval = await options.approvals.decide(
      id as ApprovalId,
      decision,
      session.adminId as AdminId,
      body.requestHash,
    );
    return approval;
  });

  app.get('/api/admin/approvals/events', async (request, reply) => {
    if (!await authorizeAdmin(request, reply, options.sessions, false)) return;
    reply.hijack();
    const response = reply.raw;
    openSseResponse(response);
    const write = (event: { id: string; data: unknown }) => {
      response.write(`id: ${event.id}\ndata: ${JSON.stringify(event.data)}\n\n`);
    };
    const lastEventId =
      typeof request.headers['last-event-id'] === 'string'
        ? request.headers['last-event-id']
        : typeof (request.query as { lastEventId?: unknown }).lastEventId ===
            'string'
          ? (request.query as { lastEventId: string }).lastEventId
          : undefined;
    const subscription = options.broker.subscribe(lastEventId, write);
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 20_000);
    heartbeat.unref();
    request.raw.once('close', () => {
      clearInterval(heartbeat);
      subscription.close();
    });
  });
}
