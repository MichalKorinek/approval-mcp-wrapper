import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';

import type { Approval, JsonValue } from '@approval-mcp/contracts';
import type { ApprovalRecord } from '@approval-mcp/gateway';
import type { ConfigStateStore } from '@approval-mcp/state-store';
import webPush from 'web-push';
import { z } from 'zod';

const VAPID_SETTING_ID = 'web-push-vapid';
const MAX_PUSH_DEVICES = 32;

const encryptedEnvelopeSchema = z.object({
  algorithm: z.literal('aes-256-gcm'),
  ciphertext: z.string().min(1),
  nonce: z.string().min(1),
  tag: z.string().min(1),
  version: z.literal(1),
});

type EncryptedEnvelope = z.infer<typeof encryptedEnvelopeSchema>;

const browserPushSubscriptionSchema = z.object({
  endpoint: z.url().max(2_048),
  expirationTime: z.number().nonnegative().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(20).max(512),
    auth: z.string().min(8).max(256),
  }),
});

export type BrowserPushSubscription = z.infer<
  typeof browserPushSubscriptionSchema
>;

const pushDeviceInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  locale: z.string().trim().min(2).max(24),
  platform: z.string().trim().min(1).max(80),
  subscription: browserPushSubscriptionSchema,
});

export type PushDeviceInput = z.infer<typeof pushDeviceInputSchema>;

const pushDeviceRecordSchema = z.object({
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  version: z.number().int().positive(),
  name: z.string(),
  locale: z.string(),
  platform: z.string(),
  endpointHash: z.string().length(64),
  subscription: encryptedEnvelopeSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastAttemptAt: z.string().optional(),
  lastDeliveredAt: z.string().optional(),
  lastFailureAt: z.string().optional(),
  lastFailureReason: z.string().optional(),
});

type PushDeviceRecord = z.infer<typeof pushDeviceRecordSchema>;

const vapidSettingSchema = z.object({
  schemaVersion: z.literal(1),
  publicKey: z.string().min(1),
  privateKey: encryptedEnvelopeSchema,
  createdAt: z.string(),
});

export interface PushDeviceView {
  id: string;
  name: string;
  locale: string;
  platform: string;
  endpointHash: string;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt?: string;
  lastDeliveredAt?: string;
  lastFailureAt?: string;
  lastFailureReason?: string;
}

export type PushDeliveryResult = 'accepted' | 'expired' | 'failed';

export interface PushSender {
  sendNotification(
    subscription: webPush.PushSubscription,
    payload: string,
    options: webPush.RequestOptions,
  ): Promise<unknown>;
}

export class PushRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushRegistrationError';
  }
}

interface PushNotificationServiceOptions {
  state: ConfigStateStore;
  masterKey: Uint8Array;
  vapidSubject: string;
  sender?: PushSender;
  generateVapidKeys?(): webPush.VapidKeys;
  now?(): Date;
  onBootstrapChanged?(value: BootstrapPushConfig): Promise<void>;
}

/** Deliberate cold-start exception: delivery material, never the storage key. */
export interface BootstrapPushConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
  devices: { locale: string; subscription: BrowserPushSubscription }[];
}

export class PushSecretVault {
  readonly #masterKey: Buffer;

  constructor(masterKey: Uint8Array) {
    if (masterKey.byteLength !== 32) {
      throw new Error('Push secret master key must be exactly 32 bytes');
    }
    this.#masterKey = Buffer.from(masterKey);
  }

  encrypt(scope: string, value: unknown): EncryptedEnvelope {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#masterKey, nonce);
    cipher.setAAD(this.#authenticatedData(scope));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return {
      algorithm: 'aes-256-gcm',
      ciphertext: ciphertext.toString('base64'),
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      version: 1,
    };
  }

  decrypt(scope: string, envelope: EncryptedEnvelope): unknown {
    const parsed = encryptedEnvelopeSchema.parse(envelope);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.#masterKey,
      Buffer.from(parsed.nonce, 'base64'),
    );
    decipher.setAAD(this.#authenticatedData(scope));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as unknown;
  }

  #authenticatedData(scope: string): Buffer {
    return Buffer.from(`approval-mcp:web-push:${scope}:v1`, 'utf8');
  }
}

function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

export function assertTrustedPushEndpoint(endpoint: string): void {
  const url = new URL(endpoint);
  const hostname = url.hostname.toLowerCase();
  const trusted =
    hostname === 'web.push.apple.com' ||
    hostname.endsWith('.push.apple.com') ||
    hostname === 'fcm.googleapis.com' ||
    hostname.endsWith('.push.services.mozilla.com') ||
    hostname.endsWith('.notify.windows.com');
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    !trusted
  ) {
    throw new PushRegistrationError('Unsupported Web Push endpoint');
  }
}

function deliveryStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return undefined;
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function notificationBody(locale: string): string {
  return locale.toLowerCase().startsWith('cs')
    ? 'Nový požadavek čeká na schválení.'
    : 'A new request is waiting for approval.';
}

function testNotificationBody(locale: string): string {
  return locale.toLowerCase().startsWith('cs')
    ? 'Testovací notifikace dorazila. Schvalování nejsou nijak ovlivněna.'
    : 'Test notification received. No approval was affected.';
}

function toView(record: PushDeviceRecord): PushDeviceView {
  return {
    id: record.id,
    name: record.name,
    locale: record.locale,
    platform: record.platform,
    endpointHash: record.endpointHash,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.lastAttemptAt === undefined
      ? {}
      : { lastAttemptAt: record.lastAttemptAt }),
    ...(record.lastDeliveredAt === undefined
      ? {}
      : { lastDeliveredAt: record.lastDeliveredAt }),
    ...(record.lastFailureAt === undefined
      ? {}
      : { lastFailureAt: record.lastFailureAt }),
    ...(record.lastFailureReason === undefined
      ? {}
      : { lastFailureReason: record.lastFailureReason }),
  };
}

export class PushNotificationService {
  readonly #onBootstrapChanged: PushNotificationServiceOptions['onBootstrapChanged'];
  readonly #state: ConfigStateStore;
  readonly #vault: PushSecretVault;
  readonly #sender: PushSender;
  readonly #now: () => Date;
  readonly #vapidSubject: string;
  readonly #privateKey: string;
  readonly publicKey: string;

  private constructor(
    options: PushNotificationServiceOptions,
    keys: webPush.VapidKeys,
  ) {
    this.#state = options.state;
    this.#vault = new PushSecretVault(options.masterKey);
    this.#sender = options.sender ?? webPush;
    this.#now = options.now ?? (() => new Date());
    this.#vapidSubject = options.vapidSubject;
    this.publicKey = keys.publicKey;
    this.#privateKey = keys.privateKey;
    this.#onBootstrapChanged = options.onBootstrapChanged;
  }

  static async create(
    options: PushNotificationServiceOptions,
  ): Promise<PushNotificationService> {
    const vault = new PushSecretVault(options.masterKey);
    const existing = options.state.read(
      (state) => state.settings[VAPID_SETTING_ID],
    );
    let keys: webPush.VapidKeys;
    if (existing === undefined) {
      keys = (options.generateVapidKeys ?? webPush.generateVAPIDKeys)();
      const setting = {
        schemaVersion: 1 as const,
        publicKey: keys.publicKey,
        privateKey: vault.encrypt('vapid-private-key', keys.privateKey),
        createdAt: (options.now ?? (() => new Date()))().toISOString(),
      };
      await options.state.mutate({
        type: 'record.upserted',
        collection: 'settings',
        id: VAPID_SETTING_ID,
        value: setting as unknown as JsonValue,
      });
    } else {
      const setting = vapidSettingSchema.parse(existing);
      keys = {
        publicKey: setting.publicKey,
        privateKey: z.string().min(1).parse(
          vault.decrypt('vapid-private-key', setting.privateKey),
        ),
      };
    }
    const service = new PushNotificationService(options, keys);
    await service.#syncBootstrap();
    return service;
  }

  listDevices(): readonly PushDeviceView[] {
    return this.#state.read((state) =>
      Object.values(state.pushDevices)
        .map((value) => pushDeviceRecordSchema.parse(value))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(toView),
    );
  }

  async registerDevice(inputValue: unknown): Promise<PushDeviceView> {
    const input = pushDeviceInputSchema.parse(inputValue);
    assertTrustedPushEndpoint(input.subscription.endpoint);
    const hash = endpointHash(input.subscription.endpoint);
    const existing = this.#state.read((state) =>
      Object.values(state.pushDevices)
        .map((value) => pushDeviceRecordSchema.parse(value))
        .find((device) => device.endpointHash === hash),
    );
    if (
      existing === undefined &&
      this.#state.read((state) => Object.keys(state.pushDevices).length) >=
        MAX_PUSH_DEVICES
    ) {
      throw new PushRegistrationError('Web Push device limit reached');
    }
    const now = this.#now().toISOString();
    const id = existing?.id ?? randomUUID();
    const record: PushDeviceRecord = {
      id,
      schemaVersion: 1,
      version: (existing?.version ?? 0) + 1,
      name: input.name,
      locale: input.locale,
      platform: input.platform,
      endpointHash: hash,
      subscription: this.#vault.encrypt(
        `device:${id}:subscription`,
        input.subscription,
      ),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.lastAttemptAt === undefined
        ? {}
        : { lastAttemptAt: existing.lastAttemptAt }),
      ...(existing?.lastDeliveredAt === undefined
        ? {}
        : { lastDeliveredAt: existing.lastDeliveredAt }),
    };
    await this.#save(record);
    await this.#syncBootstrap();
    return toView(record);
  }

  async removeDevice(id: string): Promise<boolean> {
    const exists = this.#state.read(
      (state) => state.pushDevices[id] !== undefined,
    );
    if (!exists) return false;
    await this.#state.mutate({
      type: 'record.deleted',
      collection: 'pushDevices',
      id,
    });
    await this.#syncBootstrap();
    return true;
  }

  async testDevice(id: string): Promise<PushDeliveryResult | undefined> {
    const value = this.#state.read((state) => state.pushDevices[id]);
    if (value === undefined) return undefined;
    const device = pushDeviceRecordSchema.parse(value);
    const testId = randomUUID();
    return this.#deliver(device, JSON.stringify({
      title: 'Approval MCP · Test',
      body: testNotificationBody(device.locale),
      tag: `push-test:${testId}`,
      url: '/system',
    }), 60, testId);
  }

  async notifyPending(approval: Approval): Promise<void> {
    if (approval.status !== 'pending') return;
    const record = this.#state.read(
      (state) => state.approvals[approval.id] as unknown as
        | ApprovalRecord
        | undefined,
    );
    if (record === undefined || record.approval.status !== 'pending') return;
    const ttl = Math.max(
      0,
      Math.min(
        86_400,
        Math.ceil(
          (new Date(record.request.expiresAt).getTime() - this.#now().getTime()) /
            1_000,
        ),
      ),
    );
    const devices = this.#state.read((state) =>
      Object.values(state.pushDevices).map((value) =>
        pushDeviceRecordSchema.parse(value),
      ),
    );
    await Promise.all(devices.map((device) => this.#deliver(
      device,
      JSON.stringify({
        title: 'Approval MCP',
        body: notificationBody(device.locale),
        tag: `approval:${approval.id}`,
        url: `/approvals/${encodeURIComponent(approval.id)}`,
        approvalId: approval.id,
      }),
      ttl,
      approval.id,
    )));
  }

  async #deliver(
    device: PushDeviceRecord,
    payload: string,
    ttl: number,
    topicId: string,
  ): Promise<PushDeliveryResult> {
    const attemptedAt = this.#now().toISOString();
    try {
      const subscription = browserPushSubscriptionSchema.parse(
        this.#vault.decrypt(
          `device:${device.id}:subscription`,
          device.subscription,
        ),
      );
      const providerSubscription: webPush.PushSubscription = {
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        ...(subscription.expirationTime === undefined
          ? {}
          : { expirationTime: subscription.expirationTime }),
      };
      await this.#sender.sendNotification(providerSubscription, payload, {
        TTL: ttl,
        timeout: 10_000,
        urgency: 'high',
        topic: createHash('sha256').update(topicId).digest('base64url').slice(0, 32),
        vapidDetails: {
          subject: this.#vapidSubject,
          publicKey: this.publicKey,
          privateKey: this.#privateKey,
        },
      });
      await this.#updateIfCurrent(device, (current) => {
        const {
          lastFailureAt: _lastFailureAt,
          lastFailureReason: _lastFailureReason,
          ...withoutFailure
        } = current;
        return {
          ...withoutFailure,
          version: current.version + 1,
          updatedAt: attemptedAt,
          lastAttemptAt: attemptedAt,
          lastDeliveredAt: attemptedAt,
        };
      });
      return 'accepted';
    } catch (error) {
      const status = deliveryStatus(error);
      if (status === 404 || status === 410) {
        await this.#removeIfCurrent(device);
        return 'expired';
      }
      await this.#updateIfCurrent(device, (current) => ({
        ...current,
        version: current.version + 1,
        updatedAt: attemptedAt,
        lastAttemptAt: attemptedAt,
        lastFailureAt: attemptedAt,
        lastFailureReason:
          status === undefined ? 'push.delivery_failed' : `push.http_${status}`,
      }));
      return 'failed';
    }
  }

  async #updateIfCurrent(
    expected: PushDeviceRecord,
    update: (record: PushDeviceRecord) => PushDeviceRecord,
  ): Promise<void> {
    const current = this.#state.read(
      (state) => state.pushDevices[expected.id],
    );
    if (current === undefined) return;
    const parsed = pushDeviceRecordSchema.parse(current);
    if (parsed.version !== expected.version) return;
    await this.#save(update(parsed));
  }

  async #removeIfCurrent(expected: PushDeviceRecord): Promise<void> {
    const current = this.#state.read(
      (state) => state.pushDevices[expected.id],
    );
    if (current === undefined) return;
    if (pushDeviceRecordSchema.parse(current).version !== expected.version) return;
    await this.#state.mutate({
      type: 'record.deleted',
      collection: 'pushDevices',
      id: expected.id,
    });
    await this.#syncBootstrap();
  }

  async #syncBootstrap(): Promise<void> {
    if (this.#onBootstrapChanged === undefined) return;
    const devices = this.#state.read((state) => Object.values(state.pushDevices).map((value) => {
      const device = pushDeviceRecordSchema.parse(value);
      return { locale: device.locale, subscription: browserPushSubscriptionSchema.parse(this.#vault.decrypt(`device:${device.id}:subscription`, device.subscription)) };
    }));
    await this.#onBootstrapChanged({ subject: this.#vapidSubject, publicKey: this.publicKey, privateKey: this.#privateKey, devices });
  }

  async #save(record: PushDeviceRecord): Promise<void> {
    await this.#state.mutate({
      type: 'record.upserted',
      collection: 'pushDevices',
      id: record.id,
      value: record as unknown as JsonValue,
    });
  }
}
