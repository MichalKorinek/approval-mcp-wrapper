import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { saveUnlockPush, sendUnlockPush } from './storage-unlock-push.js';
const config = { subject: 'mailto:admin@example.com', publicKey: 'public', privateKey: 'private', devices: [{ locale: 'cs', subscription: { endpoint: 'https://web.push.apple.com/fixture', keys: { p256dh: 'fixture', auth: 'fixture' } } }] };

describe('cold-start unlock notifications', () => {
  it('sends a generic unlock link without opening the main vault', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'approval-unlock-push-'));
    await saveUnlockPush(dir, config);
    const sender = vi.fn().mockResolvedValue({});
    expect(await sendUnlockPush(dir, sender)).toEqual({ accepted: 1, failed: 0 });
    const [, payload, options] = sender.mock.calls[0]!;
    expect(JSON.parse(payload)).toMatchObject({ url: '/unlock', tag: 'storage-unlock' });
    expect(JSON.parse(payload).body).toContain('zamčený');
    expect(options.vapidDetails.privateKey).toBe('private');
    expect(await readFile(join(dir, 'storage-unlock-push.json'), 'utf8')).not.toContain('masterKey');
  });
  it('rejects untrusted destinations and removes expired subscriptions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'approval-unlock-push-'));
    await saveUnlockPush(dir, { ...config, devices: [...config.devices, { ...config.devices[0]!, subscription: { ...config.devices[0]!.subscription, endpoint: 'https://127.0.0.1/private' } }] });
    const sender = vi.fn().mockRejectedValue({ statusCode: 410 });
    expect(await sendUnlockPush(dir, sender)).toEqual({ accepted: 0, failed: 2 });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(dir, 'storage-unlock-push.json'), 'utf8')).devices).toHaveLength(1);
  });
});
