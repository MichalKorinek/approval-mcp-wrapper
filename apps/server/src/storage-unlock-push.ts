import webPush from 'web-push';
import { join } from 'node:path';
import { z } from 'zod';
import { createNodeFileOperations } from '@approval-mcp/state-store';
import { assertTrustedPushEndpoint, type BootstrapPushConfig } from './push-notification-service.js';

const schema = z.object({ subject: z.string().min(1).max(2048), publicKey: z.string().max(256), privateKey: z.string().max(256), devices: z.array(z.object({ locale: z.string().max(24), subscription: z.object({ endpoint: z.url().max(2048), expirationTime: z.number().nullable().optional(), keys: z.object({ p256dh: z.string().max(512), auth: z.string().max(256) }) }) })).max(32) });
const queues = new Map<string, Promise<void>>();
async function serialized(dataDir: string, operation: () => Promise<void>): Promise<void> {
  const pending = (queues.get(dataDir) ?? Promise.resolve()).then(operation);
  const tail = pending.catch(() => undefined); queues.set(dataDir, tail);
  try { await pending; } finally { if (queues.get(dataDir) === tail) queues.delete(dataDir); }
}

export async function saveUnlockPush(dataDir: string, value: BootstrapPushConfig): Promise<void> {
  await serialized(dataDir, () => createNodeFileOperations().writeAtomic(join(dataDir, 'storage-unlock-push.json'), JSON.stringify(schema.parse(value))));
}

/** One generic notification per cold start; slow providers never block serving unlock. */
export async function sendUnlockPush(dataDir: string, send = webPush.sendNotification): Promise<{ accepted: number; failed: number }> {
  const text = await createNodeFileOperations().readText(join(dataDir, 'storage-unlock-push.json'));
  if (text === undefined) return { accepted: 0, failed: 0 };
  const config = schema.parse(JSON.parse(text));
  let accepted = 0; let failed = 0;
  const remaining: typeof config.devices = [];
  await Promise.all(config.devices.map(async (device) => {
    try {
      assertTrustedPushEndpoint(device.subscription.endpoint);
      const cs = device.locale.toLowerCase().startsWith('cs');
      await send({ endpoint: device.subscription.endpoint, keys: device.subscription.keys, ...(device.subscription.expirationTime === undefined ? {} : { expirationTime: device.subscription.expirationTime }) }, JSON.stringify({ title: 'Approval MCP', body: cs ? 'Server je zamčený. Odemkněte jej pomocí passkey.' : 'The server is locked. Unlock it with your passkey.', tag: 'storage-unlock', url: '/unlock' }), {
        TTL: 3600, timeout: 10_000, urgency: 'high', topic: 'storage-unlock', vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
      });
      accepted++; remaining.push(device);
    } catch (e) {
      failed++;
      const status = (e as { statusCode?: number }).statusCode;
      if (status !== 404 && status !== 410) remaining.push(device);
    }
  }));
  // Expired destinations are not retried every restart. Runtime synchronizes removals again after unlocking.
  if (remaining.length !== config.devices.length) await serialized(dataDir, async () => {
    const files = createNodeFileOperations(); const path = join(dataDir, 'storage-unlock-push.json');
    if (await files.readText(path) === text) await files.writeAtomic(path, JSON.stringify({ ...config, devices: remaining }));
  });
  return { accepted, failed };
}
