import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { authorizeAdmin } from '../admin/authorization.js';
import type { AuthPasskeyService } from '../auth-routes.js';
import type { SessionService } from '../session-store.js';
import { SetupError } from './setup-error.js';
import type { SetupRequester, SetupService } from './setup-service.js';

const MAX_SETUP_BODY_BYTES = 64 * 1024;

/** Maps errors raised by Fastify itself (body parsing, limits) to setup error codes. */
function frameworkError(error: unknown): SetupError {
  if (error instanceof SetupError) return error;
  const status = typeof error === 'object' && error !== null && 'statusCode' in error
    ? (error as { statusCode?: unknown }).statusCode
    : undefined;
  if (status === 400) return new SetupError('input.invalid', 400);
  if (status === 413) return new SetupError('input.too_large', 413);
  if (status === 415) return new SetupError('input.unsupported_media_type', 415);
  return new SetupError('server.internal_error', 500);
}

const BEARER = /^Bearer\s+(\S+)$/i;

function requestId(request: FastifyRequest): string {
  return (request.params as { id: string }).id;
}

export async function registerSetupRoutes(
  app: FastifyInstance,
  options: {
    setup: SetupService;
    passkeys: AuthPasskeyService;
    sessions: SessionService;
    /** Resolves an MCP client token (Access → Tokens) to the requester it identifies. */
    authenticateRequester(token: string): Promise<SetupRequester | undefined>;
  },
): Promise<void> {
  const { setup } = options;

  /** Setup requests are tied to the client token they were submitted with. */
  async function requester(request: FastifyRequest): Promise<SetupRequester> {
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
    const found = token === undefined ? undefined : await options.authenticateRequester(token);
    if (found === undefined) throw new SetupError('auth.token_required', 401);
    return found;
  }

  // Encapsulated so the error handler and the no-store hook apply to setup routes only,
  // including errors Fastify raises before a handler runs.
  await app.register(async (scope) => {
    scope.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'no-store');
      return payload;
    });

    scope.setErrorHandler((error, request, reply) => {
      const failure = frameworkError(error);
      if (failure.status >= 500) request.log.error({ error }, 'Setup request failed');
      return reply.code(failure.status).send({
        error: {
          code: failure.code,
          message: 'The setup request could not be processed',
          requestId: request.id,
        },
      });
    });

    scope.post('/api/setup/requests', { bodyLimit: MAX_SETUP_BODY_BYTES }, async (request, reply) => {
      const contentType = request.headers['content-type'] ?? '';
      if (!contentType.toLowerCase().startsWith('application/json')) {
        throw new SetupError('input.unsupported_media_type', 415);
      }
      const result = await setup.submit(request.body, await requester(request));
      return reply.code(result.status === 'unchanged' ? 200 : 202).send(result);
    });

    scope.get('/api/setup/requests/:id/status', async (request) =>
      setup.status(requestId(request), await requester(request)));

    scope.get('/api/setup/requests/:id', async (request, reply) => {
      if (!await authorizeAdmin(request, reply, options.sessions, false)) return reply;
      return setup.pending(requestId(request));
    });

    scope.post('/api/setup/requests/:id/approve', { bodyLimit: MAX_SETUP_BODY_BYTES }, async (request, reply) => {
      const session = await authorizeAdmin(request, reply, options.sessions, true);
      if (session === undefined) return reply;
      const body = (request.body ?? {}) as {
        planDigest?: unknown;
        credentials?: unknown;
        passkey?: unknown;
      };
      if (
        typeof body.planDigest !== 'string' ||
        typeof body.passkey !== 'object' ||
        body.passkey === null
      ) {
        throw new SetupError('input.invalid');
      }
      const id = requestId(request);
      setup.pending(id);
      const verified = await options.passkeys
        .verifyLogin(body.passkey as AuthenticationResponseJSON)
        .catch(() => { throw new SetupError('auth.passkey_invalid', 403); });
      if (verified.adminId !== session.adminId) {
        throw new SetupError('auth.passkey_invalid', 403);
      }
      const result = await setup.approve(id, {
        planDigest: body.planDigest,
        credentials: body.credentials,
      });
      request.log.info({ setupRequestId: id, adminId: session.adminId, results: result.results }, 'Setup request applied');
      return result;
    });

    scope.post('/api/setup/requests/:id/deny', async (request, reply) => {
      const session = await authorizeAdmin(request, reply, options.sessions, true);
      if (session === undefined) return reply;
      const result = await setup.deny(requestId(request));
      request.log.info({ setupRequestId: requestId(request), adminId: session.adminId }, 'Setup request denied');
      return result;
    });
  });
}
