import { loadConfig } from './config.js';
import { buildStorageServer } from './storage-server.js';

const app = await buildStorageServer(loadConfig());
await app.listen({ host: process.env['HOST'] ?? '127.0.0.1', port: Number(process.env['PORT'] ?? 3000) });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void app.close().then(() => process.exit(0), () => process.exit(1));
});
