import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { decryptSample, fromBase64, toBase64 } from './crypto.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const base64 = z.string().regex(/^[A-Za-z0-9_-]+$/).max(20_000);
const envelope = z.object({ nonce: base64.refine((value) => fromBase64(value).length === 12), ciphertext: base64 }).strict();
const vaultSchema = z.object({
  schemaVersion: z.literal(1), id: z.uuid(), rpId: z.string(), origin: z.url(), salt: base64,
  credential: z.object({ id: base64, publicKey: base64, counter: z.number().int().nonnegative(), transports: z.array(z.string()).optional() }).strict(),
  passkeyWrap: envelope, recoveryWrap: envelope, payload: envelope,
}).strict();
const authenticationSchema = z.object({ id: base64, rawId: base64, type: z.literal('public-key'),
  response: z.object({ clientDataJSON: base64, authenticatorData: base64, signature: base64, userHandle: base64.optional() }).strict(),
  clientExtensionResults: z.object({}).strict(), authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
}).strict();
const sampleSchema = z.object({ message: z.literal('Synthetic data — no Approval MCP secrets.'), createdAt: z.iso.datetime() }).strict();

/** Standalone experimental app. Never imported by the production server. */
export async function startPoc({ dataDir, port = 43129, host = '127.0.0.1', publicUrl } = {}) {
  const directory = resolve(dataDir ?? join(process.cwd(), '.local-data/passkey-vault-poc'));
  if (dataDir !== undefined && !isAbsolute(dataDir)) throw new Error('POC_DATA_DIR must be absolute');
  const file = join(directory, 'poc-vault.json');
  let vault;
  try { vault = vaultSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid PoC vault; it has not been overwritten', { cause: error }); }
  let activeKey;
  let origin;
  const sessions = new Map();
  const csrf = randomBytes(32).toString('base64url');
  const attempts = new Map();

  async function save(next) {
    const validated = vaultSchema.parse(next);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(validated)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
    vault = validated;
  }
  const clearKey = () => { activeKey?.fill(0); activeKey = undefined; };
  async function unlock(key) {
    const bytes = fromBase64(key);
    try {
      const sample = sampleSchema.parse(await decryptSample(bytes, vault.id, vault.payload));
      clearKey();
      activeKey = Uint8Array.from(bytes);
      return sample;
    } finally { bytes.fill(0); }
  }
  function reply(response, status, body) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  }
  async function body(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 64_000) throw new Error('Body too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async function options(session, purpose) {
    const credential = purpose === 'enroll' ? session.draft.credential : vault.credential;
    const salt = purpose === 'enroll' ? session.draft.salt : vault.salt;
    const result = await generateAuthenticationOptions({ rpID: new URL(origin).hostname,
      userVerification: 'required', allowCredentials: [{ id: credential.id, transports: credential.transports }],
    });
    result.extensions = { prf: { eval: { first: salt } } };
    session.challenge = { purpose, value: result.challenge, expires: Date.now() + 120_000 };
    return result;
  }
  async function verify(session, purpose, raw) {
    const input = authenticationSchema.parse(raw); // PRF output must never reach this endpoint.
    const challenge = session.challenge;
    session.challenge = undefined;
    if (challenge?.purpose !== purpose || challenge.expires <= Date.now()) throw new Error('Challenge expired');
    const credential = purpose === 'enroll' ? session.draft.credential : vault.credential;
    const result = await verifyAuthenticationResponse({ response: input, expectedChallenge: challenge.value,
      expectedOrigin: origin, expectedRPID: new URL(origin).hostname, requireUserVerification: true,
      credential: { ...credential, publicKey: fromBase64(credential.publicKey) },
    });
    if (!result.verified) throw new Error('Authentication failed');
    return result.authenticationInfo.newCounter;
  }
  const server = createServer(async (request, response) => {
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    try {
      if (request.headers.host !== new URL(origin).host) return reply(response, 400, { error: 'Unexpected host' });
      const path = new URL(request.url, origin).pathname;
      const asset = { '/': ['index.html', 'text/html'], '/app.mjs': ['app.mjs', 'text/javascript'],
        '/crypto.mjs': ['crypto.mjs', 'text/javascript'], '/style.css': ['style.css', 'text/css'] }[path];
      if (request.method === 'GET' && asset) {
        response.writeHead(200, { 'content-type': `${asset[1]}; charset=utf-8`, 'cache-control': 'no-store' });
        return response.end(await readFile(join(root, asset[0])));
      }
      let token = /(?:^|;\s*)poc_session=([A-Za-z0-9_-]+)/.exec(request.headers.cookie ?? '')?.[1];
      let session = token === undefined ? undefined : sessions.get(token);
      for (const [id, item] of sessions) if (item.expires < Date.now()) sessions.delete(id);
      if (!session || session.expires < Date.now()) {
        if (sessions.size >= 100) return reply(response, 429, { error: 'Too many sessions' });
        token = randomBytes(32).toString('base64url');
        session = { authenticated: false, expires: Date.now() + 30 * 60_000 };
        sessions.set(token, session);
        response.setHeader('set-cookie', `poc_session=${token}; Path=/; HttpOnly; SameSite=Strict${origin.startsWith('https:') ? '; Secure' : ''}`);
      }
      if (request.method === 'GET' && path === '/api/status') {
        return reply(response, 200, { initialized: vault !== undefined, locked: activeKey === undefined,
          authenticated: session.authenticated, csrf, experimental: true });
      }
      if (request.method === 'GET' && path === '/api/vault') {
        if (vault === undefined) return reply(response, 404, { error: 'Not initialized' });
        return reply(response, 200, vault);
      }
      if (request.method === 'GET' && path === '/api/sample') {
        if (activeKey === undefined || !session.authenticated) return reply(response, 423, { error: 'Locked' });
        return reply(response, 200, await decryptSample(activeKey, vault.id, vault.payload));
      }
      if (request.method !== 'POST' || !['/api/enroll/options', '/api/enroll/verify', '/api/enroll/complete', '/api/unlock/options', '/api/unlock', '/api/recover', '/api/lock'].includes(path)) return reply(response, 404, { error: 'Not found' });
      if (request.headers.origin !== origin || request.headers['x-poc-csrf'] !== csrf ||
        !request.headers['content-type']?.startsWith('application/json')) return reply(response, 403, { error: 'Origin or CSRF rejected' });
      const ip = request.socket.remoteAddress;
      const bucket = attempts.get(ip);
      if (!bucket || bucket.expires < Date.now()) attempts.set(ip, { count: 1, expires: Date.now() + 60_000 });
      else if (++bucket.count > 60) return reply(response, 429, { error: 'Too many attempts' });
      const input = await body(request);
      if (path.startsWith('/api/enroll/') && vault !== undefined) return reply(response, 409, { error: 'Already initialized' });
      if (path === '/api/enroll/options') {
        const result = await generateRegistrationOptions({ rpName: 'Approval MCP Vault PoC', rpID: new URL(origin).hostname,
          userName: 'vault-poc', attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        });
        result.extensions = { prf: {} };
        session.challenge = { purpose: 'register', value: result.challenge, expires: Date.now() + 120_000 };
        return reply(response, 200, result);
      }
      if (path === '/api/enroll/verify') {
        const challenge = session.challenge;
        session.challenge = undefined;
        if (challenge?.purpose !== 'register' || challenge.expires <= Date.now()) throw new Error('Challenge expired');
        // Do not accept PRF values in registration extension outputs either.
        if (input?.clientExtensionResults?.prf?.results !== undefined) throw new Error('Unexpected PRF output');
        const result = await verifyRegistrationResponse({ response: input, expectedChallenge: challenge.value,
          expectedOrigin: origin, expectedRPID: new URL(origin).hostname, requireUserVerification: true });
        if (!result.verified) throw new Error('Registration failed');
        const { publicKey, ...credential } = result.registrationInfo.credential;
        session.draft = { id: randomUUID(), salt: randomBytes(32).toString('base64url'), credential: { ...credential, publicKey: toBase64(publicKey) } };
        return reply(response, 200, { id: session.draft.id, salt: session.draft.salt, options: await options(session, 'enroll') });
      }
      if (path === '/api/enroll/complete') {
        const enrollment = z.object({ authentication: authenticationSchema, passkeyWrap: envelope, recoveryWrap: envelope, payload: envelope, key: base64 }).strict().parse(input);
        const counter = await verify(session, 'enroll', enrollment.authentication);
        const draft = session.draft;
        const next = vaultSchema.parse({ schemaVersion: 1, id: draft.id, rpId: new URL(origin).hostname, origin, salt: draft.salt,
          credential: { ...draft.credential, counter }, passkeyWrap: enrollment.passkeyWrap, recoveryWrap: enrollment.recoveryWrap, payload: enrollment.payload });
        const key = fromBase64(enrollment.key);
        try { sampleSchema.parse(await decryptSample(key, next.id, next.payload)); } finally { key.fill(0); }
        // Recheck after async validation: only one concurrent enrollment may win.
        if (vault !== undefined) return reply(response, 409, { error: 'Already initialized' });
        // Reserve enrollment until the atomic write completes; failure restores it.
        vault = next;
        try { await save(next); } catch (error) { vault = undefined; throw error; }
        await unlock(enrollment.key);
        session.authenticated = true;
        session.draft = undefined;
        return reply(response, 200, { unlocked: true });
      }
      if (vault === undefined) return reply(response, 409, { error: 'Not initialized' });
      if (path === '/api/unlock/options') return reply(response, 200, await options(session, 'unlock'));
      if (path === '/api/unlock') {
        const unlockInput = z.object({ authentication: authenticationSchema, key: base64 }).strict().parse(input);
        const counter = await verify(session, 'unlock', unlockInput.authentication);
        await save({ ...vault, credential: { ...vault.credential, counter } });
        await unlock(unlockInput.key);
        session.authenticated = true;
        return reply(response, 200, { unlocked: true });
      }
      if (path === '/api/recover') {
        const recovery = z.object({ key: base64 }).strict().parse(input);
        await unlock(recovery.key); // Knowledge of the actual data key is required.
        session.authenticated = true;
        return reply(response, 200, { unlocked: true, recovered: true });
      }
      if (path === '/api/lock') {
        if (!session.authenticated) return reply(response, 403, { error: 'Not authenticated' });
        clearKey();
        for (const item of sessions.values()) item.authenticated = false;
        return reply(response, 200, { locked: true });
      }
    } catch {
      // Never log request bodies, PRF output, recovery codes, or key material.
      return reply(response, 400, { error: 'Operation failed. Check passkey support, origin, challenge or recovery code.' });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const address = server.address();
  origin = publicUrl ?? `http://localhost:${address.port}`;
  const parsed = new URL(origin);
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) ||
    parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('POC_PUBLIC_URL must be HTTPS or exact HTTP loopback, without a path');
  }
  origin = parsed.origin;
  if (vault !== undefined && (vault.origin !== origin || vault.rpId !== parsed.hostname)) {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('Use the original PoC origin; existing vault was not modified');
  }
  return { server, origin, file, close: async () => { clearKey(); server.closeAllConnections(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await startPoc({ dataDir: process.env.POC_DATA_DIR, port: Number(process.env.POC_PORT ?? 43129),
    host: process.env.POC_HOST ?? '127.0.0.1', publicUrl: process.env.POC_PUBLIC_URL });
  console.log(`Experimental passkey vault PoC: ${app.origin} — synthetic data only`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
