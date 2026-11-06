import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { generateRegistrationOptions, generateAuthenticationOptions, verifyRegistrationResponse, verifyAuthenticationResponse, type RegistrationResponseJSON, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { ServerConfig } from './config.js';
import { buildRuntime } from './runtime.js';
import { StorageVault, vaultCredentialSchema, wrappingEnvelopeSchema } from './storage-vault.js';
import { saveUnlockPush, sendUnlockPush } from './storage-unlock-push.js';
import { rm } from 'node:fs/promises';

const b64 = z.string().regex(/^[A-Za-z0-9_-]+$/).max(20_000);
const keySchema = b64.refine((value) => Buffer.from(value, 'base64url').length === 32);
const authSchema = z.object({ id: b64, rawId: b64, type: z.literal('public-key'), response: z.object({ clientDataJSON: b64, authenticatorData: b64, signature: b64, userHandle: b64.optional() }).strict(), clientExtensionResults: z.object({}).strict(), authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional() }).strict();
interface BootstrapSession {
  csrf: string; expires: number;
  challenge?: { value: string; purpose: 'register' | 'enroll' | 'unlock'; expires: number; slotId?: string } | undefined;
  draft?: { id: string; vaultId: string; name: string; salt: string; credential: z.infer<typeof vaultCredentialSchema> } | undefined;
  name?: string;
}
const cookie = (request: FastifyRequest, name: string) => request.headers.cookie?.split(';').map((part) => part.trim().split('=')).find(([key]) => key === name)?.[1];
const equal = (left: string, right: string) => { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };

export async function buildStorageServer(config: ServerConfig, options: {
  createRuntime?: typeof buildRuntime;
  notifyLocked?: typeof sendUnlockPush;
  setupToken?: string;
} = {}): Promise<FastifyInstance> {
  const vault = await StorageVault.open(config.dataDir, config.expectedOrigin);
  if (!config.unlockNotifications) await rm(join(config.dataDir, 'storage-unlock-push.json'), { force: true });
  const legacy = await vault.hasLegacyData();
  if (vault.manifest?.phase === 'ready' && await vault.hasCommittedLegacyData()) throw new Error('Legacy data reappeared after migration. Stop old instances and review the volume before starting.');
  const setupToken = options.setupToken ?? randomBytes(24).toString('base64url');
  let runtime: Awaited<ReturnType<typeof buildRuntime>> | undefined;
  let queue = Promise.resolve();
  const serial = <T,>(operation: () => Promise<T>): Promise<T> => {
    const pending = queue.then(operation); queue = pending.then(() => undefined, () => undefined); return pending;
  };
  async function activate(key: Uint8Array): Promise<void> {
    vault.verifyKey(key);
    if (runtime !== undefined) return;
    await vault.unlock(key);
    try {
      runtime = await (options.createRuntime ?? buildRuntime)({ ...config, dataDir: vault.runtimeDir, masterKey: vault.key! }, vault.codec!, config.unlockNotifications ? (value) => saveUnlockPush(config.dataDir, value) : undefined, vault.manifest?.slots[0]?.credential);
    } catch (e) { vault.destroy(); throw e; }
  }
  if (config.masterKey !== undefined) {
    if (vault.manifest === undefined) await vault.initialize(config.masterKey);
    try { await activate(config.masterKey); }
    finally { config.masterKey.fill(0); }
  } else if (vault.manifest === undefined && !legacy) {
    // The only bootstrap secret logged; never log key material or request bodies.
    console.info(`Storage setup code (first installation only): ${setupToken}`);
  }
  const environmentUnlock = config.masterKey !== undefined;
  const app = Fastify({ logger: false, bodyLimit: 64_000, forceCloseConnections: true });
  const sessions = new Map<string, BootstrapSession>();
  const attempts = new Map<string, { count: number; expires: number }>();
  const allowedHosts = new Set(config.oauthOrigins.map((value) => new URL(value).host));
  const sessionFor = (request: FastifyRequest) => sessions.get(cookie(request, 'amcp_storage') ?? '');
  const isAdmin = async (request: FastifyRequest) => {
    const token = cookie(request, 'amcp_admin');
    const csrf = request.headers['x-csrf-token'];
    return runtime !== undefined && token !== undefined && typeof csrf === 'string' &&
      await runtime.sessions.authenticate(token, csrf) !== undefined;
  };
  const authorizeEnrollment = async (request: FastifyRequest) => {
    if (vault.manifest === undefined && !legacy) {
      const input = request.body as { setupToken?: unknown };
      if (typeof input?.setupToken === 'string' && equal(input.setupToken, setupToken)) return;
    } else if (await isAdmin(request)) return;
    throw new Error('Administrator authorization or initial setup code required');
  };
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const path = request.url.split('?')[0]!;
    const health = ['/health', '/health/live', '/health/ready'].includes(path);
    if (!health && !allowedHosts.has(request.headers.host ?? '')) return reply.code(400).send({ error: { code: 'storage.host_invalid' } });
    if (!path.startsWith('/api/storage/') && !health && runtime !== undefined) {
      reply.hijack(); runtime.app.routing(request.raw, reply.raw); return;
    }
    if (!path.startsWith('/api/storage/')) return;
    const now = Date.now();
    for (const [id, value] of sessions) if (value.expires < now) sessions.delete(id);
    for (const [id, value] of attempts) if (value.expires < now) attempts.delete(id);
    if (request.method === 'POST' || request.method === 'DELETE') {
      const session = sessionFor(request);
      if (request.headers.origin !== config.expectedOrigin || request.headers.host !== config.publicUrl.host ||
        session === undefined || session.expires < now || request.headers['x-storage-csrf'] !== session.csrf) {
        return reply.code(403).send({ error: { code: 'storage.csrf_invalid' } });
      }
      const bucket = attempts.get(request.ip) ?? { count: 0, expires: now + 60_000 };
      if (++bucket.count > 30 || attempts.size > 1000) return reply.code(429).header('retry-after', '60').send({ error: { code: 'storage.rate_limited' } });
      attempts.set(request.ip, bucket);
    }
  });
  app.setErrorHandler((_error, _request, reply) => reply.code(400).send({ error: { code: 'storage.operation_failed' } }));
  app.get('/api/storage/status', async (request, reply) => {
    let session = sessionFor(request);
    if (session === undefined) {
      if (sessions.size >= 1000) return reply.code(429).send({ error: { code: 'storage.rate_limited' } });
      const token = randomBytes(32).toString('base64url');
      session = { csrf: randomBytes(32).toString('base64url'), expires: Date.now() + 30 * 60_000 };
      sessions.set(token, session);
      reply.header('set-cookie', `amcp_storage=${token}; Path=/; HttpOnly; SameSite=Strict${config.secureCookies ? '; Secure' : ''}`);
    }
    return { locked: runtime === undefined, initialized: vault.manifest !== undefined, environmentUnlock,
      primaryOrigin: config.expectedOrigin, csrf: session.csrf, legacyKeyRequired: legacy && vault.manifest === undefined,
      migration: vault.manifest?.phase, recoveryAvailable: vault.manifest?.recoveryWrap !== undefined,
      slots: vault.manifest?.slots.map(({ id, name, createdAt }) => ({ id, name, createdAt })) ?? [],
      bootstrapNotifications: config.unlockNotifications };
  });
  app.get('/api/storage/public', async () => ({ id: vault.manifest?.id, recoveryWrap: vault.manifest?.recoveryWrap,
    slots: vault.manifest?.slots.map(({ id, salt, credential, wrap }) => ({ id, salt, credentialId: credential.id, wrap })) ?? [] }));
  async function authenticationOptions(session: BootstrapSession, purpose: 'enroll' | 'unlock', slotId?: string) {
    const slot = purpose === 'enroll' ? session.draft : vault.manifest?.slots.find((v) => v.id === slotId);
    if (slot === undefined || (vault.manifest !== undefined && vault.manifest.origin !== config.expectedOrigin)) throw new Error('Use the original storage passkey origin');
    const result = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', allowCredentials: [{ id: slot.credential.id }] });
    Object.assign(result, { extensions: { prf: { eval: { first: slot.salt } } } });
    session.challenge = { value: result.challenge, purpose, expires: Date.now() + 120_000, ...(slotId === undefined ? {} : { slotId }) };
    return result;
  }
  async function verify(session: BootstrapSession, purpose: 'enroll' | 'unlock', raw: unknown) {
    const input = authSchema.parse(raw);
    const challenge = session.challenge; session.challenge = undefined;
    if (challenge?.purpose !== purpose || challenge.expires <= Date.now()) throw new Error('Challenge expired');
    const slot = purpose === 'enroll' ? session.draft : vault.manifest?.slots.find((v) => v.id === challenge.slotId);
    if (slot === undefined) throw new Error('Unknown credential');
    const result = await verifyAuthenticationResponse({ response: input as AuthenticationResponseJSON, expectedChallenge: challenge.value, expectedOrigin: config.expectedOrigin,
      expectedRPID: config.rpId, requireUserVerification: true, credential: { id: slot.credential.id, publicKey: Buffer.from(slot.credential.publicKey, 'base64url'), counter: slot.credential.counter } });
    if (!result.verified) throw new Error('Authentication failed');
    return { slot, counter: result.authenticationInfo.newCounter };
  }
  app.post('/api/storage/enroll/options', (request) => serial(async () => {
    await authorizeEnrollment(request);
    const body = z.object({ name: z.string().trim().min(1).max(64), setupToken: z.string().optional() }).strict().parse(request.body);
    const session = sessionFor(request)!;
    const result = await generateRegistrationOptions({ rpName: 'Approval MCP · Storage', rpID: config.rpId, userName: 'storage-admin', attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: vault.manifest?.slots.map((v) => ({ id: v.credential.id })) ?? [] });
    Object.assign(result, { extensions: { prf: {} } });
    session.name = body.name; session.draft = undefined;
    session.challenge = { value: result.challenge, purpose: 'register', expires: Date.now() + 120_000 };
    return result;
  }));
  app.post('/api/storage/enroll/verify', (request) => serial(async () => {
    await authorizeEnrollment(request);
    const body = z.object({ credential: z.unknown(), setupToken: z.string().optional() }).strict().parse(request.body);
    const credential = body.credential as RegistrationResponseJSON;
    if (credential?.clientExtensionResults !== undefined && Object.keys(credential.clientExtensionResults).length !== 0) throw new Error('Extension outputs must stay in the browser');
    const session = sessionFor(request)!;
    const challenge = session.challenge; session.challenge = undefined;
    if (challenge?.purpose !== 'register' || challenge.expires <= Date.now()) throw new Error('Challenge expired');
    const result = await verifyRegistrationResponse({ response: credential, expectedChallenge: challenge.value, expectedOrigin: config.expectedOrigin, expectedRPID: config.rpId, requireUserVerification: true });
    if (!result.verified) throw new Error('Registration failed');
    session.draft = { id: randomUUID(), vaultId: vault.manifest?.id ?? randomUUID(), name: session.name!, salt: randomBytes(32).toString('base64url'),
      credential: { id: result.registrationInfo.credential.id, publicKey: Buffer.from(result.registrationInfo.credential.publicKey).toString('base64url'), counter: result.registrationInfo.credential.counter } };
    return { id: session.draft.vaultId, slotId: session.draft.id, options: await authenticationOptions(session, 'enroll'),
      key: vault.key?.toString('base64url'), needsRecovery: vault.manifest?.recoveryWrap === undefined };
  }));
  app.post('/api/storage/enroll/complete', (request) => serial(async () => {
    await authorizeEnrollment(request);
    const body = z.object({ authentication: authSchema, key: keySchema, passkeyWrap: wrappingEnvelopeSchema, recoveryWrap: wrappingEnvelopeSchema.optional(), setupToken: z.string().optional() }).strict().parse(request.body);
    const session = sessionFor(request)!;
    const { counter } = await verify(session, 'enroll', body.authentication);
    const draft = session.draft!;
    const key = Buffer.from(body.key, 'base64url');
    const slot = { id: draft.id, name: draft.name, salt: draft.salt, credential: { ...draft.credential, counter }, wrap: body.passkeyWrap, createdAt: new Date().toISOString() };
    try {
      if (vault.manifest === undefined) {
        if (await vault.hasLegacyData() || body.recoveryWrap === undefined) throw new Error('Existing data requires original environment key');
        await vault.initialize(key, slot, body.recoveryWrap, draft.vaultId);
      } else await vault.addSlot(slot, vault.manifest.recoveryWrap === undefined ? body.recoveryWrap : undefined, key);
      session.draft = undefined;
      await activate(key);
      return { unlocked: true };
    } finally { key.fill(0); }
  }));
  app.post('/api/storage/unlock/options', (request) => serial(async () => {
    const { slotId } = z.object({ slotId: z.uuid() }).strict().parse(request.body);
    return authenticationOptions(sessionFor(request)!, 'unlock', slotId);
  }));
  app.post('/api/storage/unlock', (request) => serial(async () => {
    const body = z.object({ authentication: authSchema, key: keySchema }).strict().parse(request.body);
    const { slot, counter } = await verify(sessionFor(request)!, 'unlock', body.authentication);
    const key = Buffer.from(body.key, 'base64url');
    try { vault.verifyKey(key); await vault.updateCounter(slot.id, counter, key); await activate(key); return { unlocked: true }; }
    finally { key.fill(0); }
  }));
  app.post('/api/storage/recover', (request) => serial(async () => {
    if (vault.manifest?.recoveryWrap === undefined) throw new Error('Recovery not configured');
    const body = z.object({ key: keySchema }).strict().parse(request.body);
    const key = Buffer.from(body.key, 'base64url');
    try { await activate(key); return { unlocked: true }; } finally { key.fill(0); }
  }));
  app.delete('/api/storage/passkeys/:id', (request) => serial(async () => {
    if (!await isAdmin(request)) throw new Error('Administrator required');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    await vault.removeSlot(id); return { removed: true };
  }));
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    if (runtime === undefined) return reply.code(503).send({ ready: false, locked: true });
    const result = await runtime.app.inject({ method: 'GET', url: '/health/ready' });
    return reply.code(result.statusCode).send(result.json());
  });
  await app.register(fastifyStatic, { root: join(process.cwd(), 'apps/web/dist'), wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(423).send({ error: { code: 'storage.locked' } });
    if (request.url.startsWith('/mcp') || request.url.startsWith('/.well-known/') || request.method !== 'GET') return reply.code(503).header('retry-after', '30').send({ error: 'storage_locked', unlock_url: config.expectedOrigin + '/unlock' });
    return reply.sendFile('index.html');
  });
  // Close runtime transports before the outer listener waits for their long-lived HTTP connections.
  app.addHook('preClose', async () => { await queue; await runtime?.app.close(); runtime = undefined; vault.destroy(); });
  // Start sending only after listening, so clicking the notification can reach the server.
  app.addHook('onListen', async () => {
    if (runtime === undefined && config.unlockNotifications && vault.manifest?.slots.length) {
      void (options.notifyLocked ?? sendUnlockPush)(config.dataDir).then((result) => console.info(JSON.stringify({ event: 'storage.unlock_notification', ...result })), () => console.warn('Storage unlock notification failed'));
    }
  });
  return app;
}
