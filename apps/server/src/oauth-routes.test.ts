import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonValue, Profile, ProfileId } from '@approval-mcp/contracts';
import { createConfigStateStore } from '@approval-mcp/state-store';
import { describe, expect, it } from 'vitest';

import { buildServerApp } from './app.js';
import { OAuthService } from './oauth-service.js';
import { InMemoryRecoveryRepository, RecoveryService } from './recovery-service.js';
import { InMemorySessionRepository, SessionService } from './session-store.js';

it.each([
  'https://approval.example.test',
  'http://192.168.64.1:43127',
])('discovers OAuth and completes passkey consent for %s', async (clientOrigin) => {
  const origin = 'https://approval.example.test';
  const resource = `${clientOrigin}/mcp`;
  const state = await createConfigStateStore(await mkdtemp(join(tmpdir(), 'approval-oauth-routes-')));
  const oauth = new OAuthService(state, origin, () => new Date(), [origin, 'http://192.168.64.1:43127']);
  const clientHost = new URL(clientOrigin).host;
  const now = new Date().toISOString();
  const profile: Profile = {
    id: 'test-profile' as ProfileId, name: 'Sandbox', isDefault: true,
    approvalTimeoutSeconds: 60, toolCallTimeoutSeconds: 60,
    schemaVersion: 1, createdAt: now, updatedAt: now, version: 1,
  };
  await state.mutate({ type: 'record.upserted', collection: 'profiles', id: profile.id, value: profile as unknown as JsonValue });
  const app = await buildServerApp({
    oauth,
    auth: {
      passkeys: {
        bootstrapOptions: async () => ({ challenge: 'challenge' }),
        verifyBootstrap: async () => ({ adminId: 'admin' }),
        loginOptions: async () => ({ challenge: 'challenge' }),
        verifyLogin: async () => ({ adminId: 'admin' }),
      },
      sessions: new SessionService(new InMemorySessionRepository()),
      recovery: new RecoveryService(new InMemoryRecoveryRepository()),
      secureCookies: true,
    },
  });
  const metadata = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp', headers: { host: clientHost } });
  expect(metadata.json()).toMatchObject({ resource, authorization_servers: [clientOrigin] });
  const authorizationMetadata = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server', headers: { host: clientHost } });
  expect(authorizationMetadata.json()).toMatchObject({
    issuer: clientOrigin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${clientOrigin}/oauth/token`,
  });
  const registration = await app.inject({ method: 'POST', url: '/oauth/register', payload: {
    client_name: 'Test sandbox', redirect_uris: ['http://127.0.0.1:43210/callback'], token_endpoint_auth_method: 'none',
  }, headers: { host: clientHost } });
  expect(registration.statusCode).toBe(201);
  const clientId = registration.json<{ client_id: string }>().client_id;
  const verifier = 'v'.repeat(43);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorization = await app.inject({ method: 'GET', url: `/oauth/authorize?${new URLSearchParams({
    client_id: clientId, redirect_uri: 'http://127.0.0.1:43210/callback', resource,
    response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: '123',
  })}`, headers: { host: new URL(origin).host } });
  expect(authorization.statusCode).toBe(302);
  const consentPath = authorization.headers.location as string;
  expect(consentPath).toMatch(/^\/oauth\/consent\//);
  const requestId = consentPath.split('/').at(-1)!;
  const login = await app.inject({ method: 'POST', url: '/api/auth/login/verify', payload: {} });
  const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
  const cookieHeader = [login.headers['set-cookie']].flat().map((value) => value?.split(';')[0]).join('; ');
  const consent = await app.inject({ method: 'GET', url: `/api/oauth/requests/${requestId}`, headers: { cookie: cookieHeader } });
  expect(consent.json()).toMatchObject({ clientName: 'Test sandbox', profiles: [{ id: profile.id }] });
  const approve = await app.inject({ method: 'POST', url: `/api/oauth/requests/${requestId}/approve`,
    headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    payload: { profileId: profile.id, lifetimeSeconds: 3600, label: 'My work sandbox', passkey: {} },
  });
  expect(approve.statusCode).toBe(200);
  expect(Object.values(state.read((snapshot) => snapshot.clientTokens))[0]).toMatchObject({ label: 'My work sandbox' });
  const callback = new URL(approve.json<{ redirectTo: string }>().redirectTo);
  expect(callback.searchParams.get('state')).toBe('123');
  expect(callback.searchParams.get('iss')).toBe(clientOrigin);
  const exchangeBody = new URLSearchParams({ grant_type: 'authorization_code', code: callback.searchParams.get('code')!,
    client_id: clientId, redirect_uri: 'http://127.0.0.1:43210/callback', code_verifier: verifier, resource }).toString();
  if (clientOrigin !== origin) {
    const wrongIssuer = await app.inject({ method: 'POST', url: '/oauth/token',
      headers: { host: new URL(origin).host, 'content-type': 'application/x-www-form-urlencoded' }, payload: exchangeBody,
    });
    expect(wrongIssuer.statusCode).toBe(400);
  }
  const token = await app.inject({ method: 'POST', url: '/oauth/token',
    headers: { host: clientHost, 'content-type': 'application/x-www-form-urlencoded' },
    payload: exchangeBody,
  });
  expect(token.statusCode).toBe(200);
  const accessToken = token.json<{ access_token: string }>().access_token;
  expect(oauth.authenticate(accessToken, clientOrigin)).toBeDefined();
  expect(oauth.authenticate(accessToken, clientOrigin === origin ? 'http://192.168.64.1:43127' : origin)).toBeUndefined();
  const refreshBody = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.json<{ refresh_token: string }>().refresh_token,
    client_id: clientId, resource }).toString();
  const concurrent = await Promise.all(Array.from({ length: 3 }, () => app.inject({
    method: 'POST', url: '/oauth/token', headers: { host: clientHost, 'content-type': 'application/x-www-form-urlencoded' }, payload: refreshBody,
  })));
  expect(concurrent.map((response) => response.statusCode)).toEqual([200, 200, 200]);
  expect(new Set(concurrent.map((response) => response.json<{ refresh_token: string }>().refresh_token)).size).toBe(1);
  const renewedAccess = concurrent[0]!.json<{ access_token: string }>().access_token;
  expect(oauth.authenticate(renewedAccess, clientOrigin)).toBeDefined();
  expect(concurrent[0]!.headers['cache-control']).toBe('no-store');
  expect(concurrent[0]!.headers.pragma).toBe('no-cache');
  const foreignMetadata = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server', headers: { host: 'evil.example.test' } });
  expect(foreignMetadata.statusCode).toBe(421);
  await app.close();
  await state.close();
});
