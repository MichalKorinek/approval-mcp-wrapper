import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import {
  InMemorySessionRepository,
  SessionService,
} from './session-store.js';
import {
  InMemoryRecoveryRepository,
  RecoveryService,
} from './recovery-service.js';
import { buildServerApp } from './app.js';

describe('server configuration', () => {
  const masterKey = Buffer.alloc(32, 7).toString('base64');

  it('allows locked startup without an environment key, including an empty Compose value', () => {
    const base = { APPROVAL_MCP_PUBLIC_URL: 'http://localhost:43127', APPROVAL_MCP_DATA_DIR: '/tmp/data' };
    expect(loadConfig(base).masterKey).toBeUndefined();
    expect(loadConfig({ ...base, APPROVAL_MCP_MASTER_KEY: '' }).masterKey).toBeUndefined();
    expect(loadConfig({ ...base, APPROVAL_MCP_UNLOCK_NOTIFICATIONS: 'false' }).unlockNotifications).toBe(false);
    expect(() => loadConfig({ ...base, APPROVAL_MCP_MASTER_KEY: 'invalid-key' })).toThrow('canonical');
  });

  it('requires HTTPS outside exact loopback development hosts', () => {
    expect(() =>
      loadConfig({
        APPROVAL_MCP_PUBLIC_URL: 'http://example.test',
        APPROVAL_MCP_DATA_DIR: '/tmp/data',
        APPROVAL_MCP_MASTER_KEY: masterKey,
      }),
    ).toThrow('HTTPS');
    expect(
      loadConfig({
        APPROVAL_MCP_PUBLIC_URL: 'http://localhost:3000',
        APPROVAL_MCP_DATA_DIR: '/tmp/data',
        APPROVAL_MCP_MASTER_KEY: masterKey,
      }).rpId,
    ).toBe('localhost');
    expect(
      loadConfig({
        APPROVAL_MCP_PUBLIC_URL: 'http://localhost:3000',
        APPROVAL_MCP_DATA_DIR: '/tmp/data',
        APPROVAL_MCP_MASTER_KEY: masterKey,
      }).vapidSubject,
    ).toBe('mailto:approval-mcp@example.com');
  });

  it('accepts an explicit Web Push VAPID subject', () => {
    expect(
      loadConfig({
        APPROVAL_MCP_PUBLIC_URL: 'https://approval.example.com',
        APPROVAL_MCP_DATA_DIR: '/tmp/data',
        APPROVAL_MCP_MASTER_KEY: masterKey,
        APPROVAL_MCP_VAPID_SUBJECT: 'mailto:security@example.com',
      }).vapidSubject,
    ).toBe('mailto:security@example.com');
    expect(() =>
      loadConfig({
        APPROVAL_MCP_PUBLIC_URL: 'https://approval.example.com',
        APPROVAL_MCP_DATA_DIR: '/tmp/data',
        APPROVAL_MCP_MASTER_KEY: masterKey,
        APPROVAL_MCP_VAPID_SUBJECT: 'not-a-contact',
      }),
    ).toThrow('VAPID_SUBJECT');
  });

  it('requires explicit opt-in for private HTTP OAuth aliases and rejects ambiguous hosts', () => {
    const base = {
      APPROVAL_MCP_PUBLIC_URL: 'http://localhost:43127',
      APPROVAL_MCP_DATA_DIR: '/tmp/data',
      APPROVAL_MCP_MASTER_KEY: masterKey,
      APPROVAL_MCP_OAUTH_ORIGINS: 'http://192.168.64.1:43127,https://approval.example.test',
    };
    expect(() => loadConfig(base)).toThrow('OAuth origins');
    expect(loadConfig({ ...base, APPROVAL_MCP_ALLOW_INSECURE_OAUTH_PRIVATE_HTTP: 'true' }).oauthOrigins)
      .toEqual(['http://localhost:43127', 'http://192.168.64.1:43127', 'https://approval.example.test']);
    expect(() => loadConfig({ ...base, APPROVAL_MCP_OAUTH_ORIGINS: 'http://evil.example:43127', APPROVAL_MCP_ALLOW_INSECURE_OAUTH_PRIVATE_HTTP: 'true' })).toThrow('OAuth origins');
    expect(() => loadConfig({ ...base, APPROVAL_MCP_OAUTH_ORIGINS: 'https://localhost:43127' })).toThrow('distinct host');
  });
});

describe('SessionService', () => {
  it('stores only a hash and requires the matching CSRF token', async () => {
    const repository = new InMemorySessionRepository();
    const service = new SessionService(repository);
    const created = await service.create('admin-1');
    const stored = await repository.find(created.id);

    expect(JSON.stringify(stored)).not.toContain(created.plaintext);
    expect(JSON.stringify(stored)).not.toContain(created.csrfToken);
    await expect(
      service.authenticate(created.plaintext, created.csrfToken),
    ).resolves.toMatchObject({ adminId: 'admin-1' });
    await expect(
      service.authenticate(created.plaintext, 'wrong'),
    ).resolves.toBeUndefined();
  });
});

describe('RecoveryService', () => {
  it('returns ten codes once and consumes each code at most once', async () => {
    const repository = new InMemoryRecoveryRepository();
    const service = new RecoveryService(repository);
    const codes = await service.generate();

    expect(codes).toHaveLength(10);
    expect(JSON.stringify(await repository.list())).not.toContain(codes[0]);
    await expect(service.consume(codes[0]!)).resolves.toBe(true);
    await expect(service.consume(codes[0]!)).resolves.toBe(false);
  });
});

describe('authentication routes', () => {
  function cookieHeaders(value: string | string[] | undefined): string[] {
    return Array.isArray(value) ? value : value === undefined ? [] : [value];
  }

  async function authApp(sessions: SessionService) {
    return buildServerApp({
      auth: {
        passkeys: {
          bootstrapOptions: async () => ({ challenge: 'challenge' }),
          verifyBootstrap: async () => ({ adminId: 'admin' }),
          loginOptions: async () => ({ challenge: 'challenge' }),
          verifyLogin: async () => ({ adminId: 'admin' }),
        },
        sessions,
        recovery: new RecoveryService(new InMemoryRecoveryRepository()),
        secureCookies: true,
      },
    });
  }

  async function authenticatedApp() {
    const sessions = new SessionService(new InMemorySessionRepository());
    const app = await authApp(sessions);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login/verify',
      payload: {},
    });
    const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
    return { app, login, csrfToken };
  }

  it('sets hardened session and readable CSRF cookies after login', async () => {
    const { app, login, csrfToken } = await authenticatedApp();
    const cookies = cookieHeaders(login.headers['set-cookie']);
    const sessionCookie = cookies.find((cookie) => cookie.startsWith('amcp_admin='));
    const csrfCookie = cookies.find((cookie) => cookie.startsWith('amcp_csrf='));

    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Strict');
    expect(sessionCookie).toContain('Secure');
    expect(csrfCookie).toContain(`amcp_csrf=${csrfToken}`);
    expect(csrfCookie).toContain('SameSite=Strict');
    expect(csrfCookie).toContain('Secure');
    expect(csrfCookie).not.toContain('HttpOnly');
    await app.close();
  });

  it('enforces CSRF and expires both authentication cookies on logout', async () => {
    const { app, login, csrfToken } = await authenticatedApp();
    const cookies = cookieHeaders(login.headers['set-cookie']);
    const cookie = cookies.map((value) => value.split(';')[0]).join('; ');
    expect(
      await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie },
      }),
    ).toHaveProperty('statusCode', 403);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    expect(logout.statusCode).toBe(200);
    const cleared = cookieHeaders(logout.headers['set-cookie']);
    expect(cleared).toContainEqual(expect.stringMatching(/^amcp_admin=.*Max-Age=0/));
    expect(cleared).toContainEqual(expect.stringMatching(/^amcp_csrf=.*Max-Age=0/));
    await app.close();
  });

  it('validates an active browser session without caching the response', async () => {
    const { app, login } = await authenticatedApp();
    const cookie = cookieHeaders(login.headers['set-cookie'])
      .map((value) => value.split(';')[0])
      .join('; ');

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ authenticated: true });
    expect(response.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('rejects a missing browser session', async () => {
    const sessions = new SessionService(new InMemorySessionRepository());
    const app = await authApp(sessions);

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'auth.unauthorized' },
    });
    await app.close();
  });

  it('rejects expired and revoked browser sessions', async () => {
    let now = new Date('2026-08-01T00:00:00.000Z');
    const sessions = new SessionService(
      new InMemorySessionRepository(),
      () => now,
      1_000,
    );
    const app = await authApp(sessions);
    const expired = await sessions.create('admin');
    now = new Date('2026-08-01T00:00:01.001Z');

    expect(
      await app.inject({
        method: 'GET',
        url: '/api/auth/session',
        headers: { cookie: `amcp_admin=${expired.plaintext}` },
      }),
    ).toHaveProperty('statusCode', 401);

    const revoked = await sessions.create('admin');
    await sessions.revoke(revoked.id);
    expect(
      await app.inject({
        method: 'GET',
        url: '/api/auth/session',
        headers: { cookie: `amcp_admin=${revoked.plaintext}` },
      }),
    ).toHaveProperty('statusCode', 401);
    await app.close();
  });
});
