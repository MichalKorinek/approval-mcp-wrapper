import type { FastifyInstance } from 'fastify';
import { PluginManagerError, type PluginManager } from '../plugins/plugin-manager.js';
import type { SessionService } from '../session-store.js';
import { authorizeAdmin } from './authorization.js';
import { z } from 'zod';

export async function registerPluginRoutes(app: FastifyInstance, options: {
  sessions: SessionService;
  pluginManager?: PluginManager;
}): Promise<void> {
  const manager = options.pluginManager;
  if (manager === undefined) return;
  const fail = (error: unknown, requestId: string) => {
    const known = error instanceof PluginManagerError;
    return { status: known ? error.status : 502, body: { error: {
      code: known ? error.code : 'plugin.operation_failed', message: 'Plugin operation failed', requestId,
    } } };
  };
  for (const url of ['/api/admin/plugins/sources', '/api/admin/plugins/catalog']) app.get(url, async (request, reply) => {
    if (!await authorizeAdmin(request, reply, options.sessions, false)) return;
    return manager.list();
  });
  app.post('/api/admin/plugins/preview', async (request, reply) => {
    const session = await authorizeAdmin(request, reply, options.sessions, true);
    if (session === undefined) return;
    const input = z.object({ repository: z.string().min(1).max(250) }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'plugin.invalid_repository' } });
    try { return await manager.preview(input.data.repository, session.id); }
    catch (error) { const result = fail(error, request.id); return reply.code(result.status).send(result.body); }
  });
  app.post('/api/admin/plugins/sources', async (request, reply) => {
    const session = await authorizeAdmin(request, reply, options.sessions, true);
    if (session === undefined) return;
    const input = z.object({ previewId: z.uuid(), trustCode: z.literal(true) }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'plugin.trust_required' } });
    try {
      await manager.add(input.data.previewId, session.id);
      return reply.code(201).send(manager.list());
    } catch (error) { const result = fail(error, request.id); return reply.code(result.status).send(result.body); }
  });
  for (const action of ['install', 'check', 'update', 'enable', 'disable', 'remove'] as const) {
    app.route({
      method: action === 'remove' ? 'DELETE' : 'POST',
      url: `/api/admin/plugins/:id${action === 'remove' ? '' : `/${action}`}`,
      handler: async (request, reply) => {
        if (!await authorizeAdmin(request, reply, options.sessions, true)) return;
        const { id } = request.params as { id: string };
        try {
          if (action === 'enable' || action === 'disable') await manager.setEnabled(id, action === 'enable');
          else if (action === 'check') await manager.checkUpdate(id);
          else await manager[action](id);
          return manager.list();
        } catch (error) {
          const result = fail(error, request.id);
          return reply.code(result.status).send(result.body);
        }
      },
    });
  }
}
