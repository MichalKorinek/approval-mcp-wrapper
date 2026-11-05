import type { FastifyInstance } from 'fastify';
import { PluginManagerError, type PluginManager } from '../plugins/plugin-manager.js';
import type { SessionService } from '../session-store.js';
import { authorizeAdmin } from './authorization.js';

export async function registerPluginRoutes(app: FastifyInstance, options: {
  sessions: SessionService;
  pluginManager?: PluginManager;
}): Promise<void> {
  const manager = options.pluginManager;
  if (manager === undefined) return;
  app.get('/api/admin/plugins/catalog', async (request, reply) => {
    if (!await authorizeAdmin(request, reply, options.sessions, false)) return;
    return manager.list();
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
          const known = error instanceof PluginManagerError;
          return reply.code(known ? error.status : 502).send({ error: {
            code: known ? error.code : 'plugin.operation_failed',
            message: 'Plugin operation failed', requestId: request.id,
          } });
        }
      },
    });
  }
}
