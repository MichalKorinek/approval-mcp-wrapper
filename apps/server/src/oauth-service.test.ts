import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonValue, Profile, ProfileId, StorageCodec } from '@approval-mcp/contracts';
import { createConfigStateStore, StorageCipher } from '@approval-mcp/state-store';
import { describe, expect, it } from 'vitest';

import { OAuthService, REFRESH_REUSE_GRACE_MS, type OAuthRefreshDiagnostic } from './oauth-service.js';

const origin = 'https://approval.example.test';
const redirectUri = 'http://127.0.0.1:45678/callback';
const verifier = 'a'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');

async function fixture(onRefreshDiagnostic?: (event: OAuthRefreshDiagnostic) => void, codec?: StorageCodec) {
  const dataDir = await mkdtemp(join(tmpdir(), 'approval-oauth-'));
  const state = await createConfigStateStore(dataDir);
  let clock = new Date('2026-10-21T12:00:00.000Z');
  const oauth = new OAuthService(state, origin, () => clock, [origin], onRefreshDiagnostic, codec);
  const profile: Profile = {
    id: 'test-profile' as ProfileId, name: 'Private sandbox', isDefault: false,
    approvalTimeoutSeconds: 60, toolCallTimeoutSeconds: 60,
    schemaVersion: 1, createdAt: clock.toISOString(), updatedAt: clock.toISOString(), version: 1,
  };
  await state.mutate({ type: 'record.upserted', collection: 'profiles', id: profile.id, value: profile as unknown as JsonValue });
  const client = await oauth.registerClient('My sandbox', [redirectUri]);
  const requestId = await oauth.request({
    clientId: client.id, redirectUri, resource: `${origin}/mcp`, responseType: 'code',
    codeChallenge: challenge, codeChallengeMethod: 'S256', state: 'opaque-state',
  });
  return { state, dataDir, oauth, profile, client, requestId, now: () => clock, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

async function authorize(f: Awaited<ReturnType<typeof fixture>>, lifetime = 7200) {
  const code = new URL(await f.oauth.approve(f.requestId, f.profile.id, lifetime, 'admin')).searchParams.get('code')!;
  return f.oauth.exchangeCode({ code, clientId: f.client.id, redirectUri, resource: `${origin}/mcp`, codeVerifier: verifier });
}

describe('OAuth authorization code and PKCE', () => {
  it('issues a profile-bound, time-limited client only after consent', async () => {
    const { state, oauth, profile, client, requestId, advance } = await fixture();
    expect(Object.keys(state.read((snapshot) => snapshot.clientTokens))).toHaveLength(0);
    const redirect = new URL(await oauth.approve(requestId, profile.id, 3600, 'admin'));
    expect(redirect.origin).toBe('http://127.0.0.1:45678');
    expect(redirect.searchParams.get('state')).toBe('opaque-state');
    expect(redirect.searchParams.get('iss')).toBe(origin);
    const code = redirect.searchParams.get('code')!;
    await expect(oauth.exchangeCode({ code, clientId: client.id, redirectUri, resource: `${origin}/mcp`, codeVerifier: 'b'.repeat(43) }))
      .rejects.toMatchObject({ code: 'invalid_grant' });
    const token = await oauth.exchangeCode({ code, clientId: client.id, redirectUri, resource: `${origin}/mcp`, codeVerifier: verifier });
    expect(token.expires_in).toBe(900);
    expect(token.refresh_token).toBeDefined();
    expect(oauth.authenticate(token.access_token)).toBeDefined();
    await expect(oauth.exchangeCode({ code, clientId: client.id, redirectUri, resource: `${origin}/mcp`, codeVerifier: verifier }))
      .rejects.toMatchObject({ code: 'invalid_grant' });
    const snapshot = state.read((current) => current);
    expect(JSON.stringify(snapshot)).not.toContain(token.access_token);
    expect(JSON.stringify(snapshot)).not.toContain(token.refresh_token!);
    const agent = Object.values(snapshot.clientTokens)[0] as { id: string; authKind: string; expiresAt: string };
    expect(agent.authKind).toBe('oauth');
    expect(Object.values(snapshot.tokenProfileAssignments)).toContainEqual(expect.objectContaining({ clientTokenId: agent.id, profileId: profile.id }));
    advance(15 * 60_000 + 1);
    expect(oauth.authenticate(token.access_token)).toBeUndefined();
    await state.close();
  });

  it('rotates refresh tokens and revokes the grant on replay after thirty minutes', async () => {
    const diagnostics: OAuthRefreshDiagnostic[] = [];
    const { state, oauth, profile, client, requestId, advance } = await fixture((event) => diagnostics.push(event));
    const code = new URL(await oauth.approve(requestId, profile.id, 3600, 'admin')).searchParams.get('code')!;
    const initial = await oauth.exchangeCode({ code, clientId: client.id, redirectUri, resource: `${origin}/mcp`, codeVerifier: verifier });
    await expect(oauth.refresh({ refreshToken: initial.refresh_token!, clientId: client.id,
      resource: `${origin}/mcp`, issuer: 'https://other.example.test' }))
      .rejects.toMatchObject({ code: 'invalid_grant' });
    expect(diagnostics.at(-1)).toMatchObject({ event: 'oauth.refresh', outcome: 'rejected', reason: 'binding_mismatch' });
    expect(oauth.authenticate(initial.access_token, 'https://other.example.test')).toBeUndefined();
    const renewed = await oauth.refresh({ refreshToken: initial.refresh_token!, clientId: client.id, resource: `${origin}/mcp` });
    expect(renewed.refresh_token).not.toBe(initial.refresh_token);
    expect(diagnostics.at(-1)).toMatchObject({ event: 'oauth.refresh', outcome: 'issued', grantExpiresAt: '2026-10-21T13:00:00.000Z' });
    expect(oauth.authenticate(renewed.access_token)).toBeDefined();
    advance(REFRESH_REUSE_GRACE_MS);
    await expect(oauth.refresh({ refreshToken: initial.refresh_token!, clientId: client.id, resource: `${origin}/mcp` }))
      .rejects.toMatchObject({ code: 'invalid_grant' });
    expect(diagnostics.at(-1)).toMatchObject({ event: 'oauth.refresh', outcome: 'rejected', reason: 'replay_detected' });
    expect(diagnostics.at(-1)?.grantId).toBe(diagnostics.at(-2)?.grantId);
    expect(JSON.stringify(diagnostics)).not.toContain(initial.refresh_token!);
    expect(JSON.stringify(diagnostics)).not.toContain(renewed.refresh_token!);
    expect(JSON.stringify(diagnostics)).not.toContain(initial.access_token);
    expect(oauth.authenticate(renewed.access_token)).toBeUndefined();
    expect(Object.values(state.read((value) => value.oauthGrants))[0]).toHaveProperty('revokedAt');
    await state.close();
  });

  it('converges concurrent refreshes on one issued pair without a plaintext response cache', async () => {
    const diagnostics: OAuthRefreshDiagnostic[] = [];
    const f = await fixture((event) => diagnostics.push(event));
    const initial = await authorize(f);
    const input = { refreshToken: initial.refresh_token!, clientId: f.client.id, resource: `${origin}/mcp` };
    const responses = await Promise.all(Array.from({ length: 8 }, () => f.oauth.refresh(input)));
    expect(new Set(responses.map((v) => v.refresh_token)).size).toBe(1);
    expect(new Set(responses.map((v) => v.access_token)).size).toBe(1);
    expect(diagnostics.filter((v) => v.outcome === 'issued')).toHaveLength(1);
    expect(diagnostics.filter((v) => v.outcome === 'reused')).toHaveLength(7);
    expect(diagnostics.at(-1)).toMatchObject({ reason: 'reuse_within_grace', usedAgoMs: 0, tokenGeneration: 1, currentGeneration: 2, isLatestParent: true });
    const snapshot = JSON.stringify(f.state.read((value) => value));
    for (const response of [initial, ...responses]) {
      expect(snapshot).not.toContain(response.access_token);
      expect(snapshot).not.toContain(response.refresh_token!);
      expect(JSON.stringify(diagnostics)).not.toContain(response.access_token);
      expect(JSON.stringify(diagnostics)).not.toContain(response.refresh_token!);
    }
    expect(f.oauth.authenticate(responses[0]!.access_token)).toBeDefined();
    await f.state.close();
    const disk = await readFile(join(f.dataDir, 'state.snapshot.json'), 'utf8');
    expect(disk).not.toContain(responses[0]!.refresh_token!);
  });

  it('returns the latest generation for a recent ancestor instead of forking the token family', async () => {
    const f = await fixture(); const first = await authorize(f);
    const refresh = (token: string) => f.oauth.refresh({ refreshToken: token, clientId: f.client.id, resource: `${origin}/mcp` });
    const second = await refresh(first.refresh_token!);
    f.advance(2000);
    const third = await refresh(second.refresh_token!);
    f.advance(5000);
    const ancestorRetry = await refresh(first.refresh_token!);
    expect(ancestorRetry.refresh_token).toBe(third.refresh_token);
    expect(ancestorRetry.access_token).toBe(third.access_token);
    expect(ancestorRetry.expires_in).toBe(895);
    const currentRetry = await refresh(second.refresh_token!);
    expect(currentRetry.refresh_token).toBe(third.refresh_token);
    expect(Object.values(f.state.read((value) => value.oauthTokens)).filter((value) => {
      const token = value as { kind: string; usedAt?: string }; return token.kind === 'refresh' && token.usedAt === undefined;
    })).toHaveLength(1);
    await f.state.close();
  });

  it('renews an expired cached access token within the window but never extends the original reuse deadline', async () => {
    const f = await fixture(); const initial = await authorize(f);
    const refresh = (token: string) => f.oauth.refresh({ refreshToken: token, clientId: f.client.id, resource: `${origin}/mcp` });
    const second = await refresh(initial.refresh_token!);
    f.advance(15 * 60_000);
    const fresh = await refresh(initial.refresh_token!);
    expect(fresh.access_token).not.toBe(second.access_token);
    expect(fresh.refresh_token).not.toBe(second.refresh_token);
    expect(fresh.expires_in).toBe(900);
    expect((await refresh(second.refresh_token!)).refresh_token).toBe(fresh.refresh_token);
    f.advance(15 * 60_000 - 1);
    const nearBoundary = await refresh(initial.refresh_token!);
    expect(f.oauth.authenticate(nearBoundary.access_token)).toBeDefined();
    f.advance(1);
    // R1 is now exactly thirty minutes past its FIRST use, despite many retries.
    await expect(refresh(initial.refresh_token!)).rejects.toMatchObject({ code: 'invalid_grant' });
    expect(Object.values(f.state.read((value) => value.oauthGrants))[0]).toHaveProperty('revokedAt');
    expect(f.oauth.authenticate(nearBoundary.access_token)).toBeUndefined();
    await f.state.close();
  });

  it('keeps binding, grant expiry and revocation checks active during grace', async () => {
    const f = await fixture(); const initial = await authorize(f, 1800);
    const input = { refreshToken: initial.refresh_token!, clientId: f.client.id, resource: `${origin}/mcp` };
    const renewed = await f.oauth.refresh(input);
    for (const changes of [{ clientId: 'wrong-client' }, { issuer: 'https://wrong.example.test' }, { resource: 'https://wrong.example.test/mcp' }]) {
      await expect(f.oauth.refresh({ ...input, ...changes })).rejects.toMatchObject({ code: 'invalid_grant' });
      expect(f.oauth.authenticate(renewed.access_token)).toBeDefined();
    }
    f.advance(16 * 60_000);
    const nearExpiry = await f.oauth.refresh(input);
    expect(nearExpiry.expires_in).toBe(14 * 60);
    expect(nearExpiry.refresh_token).toBeUndefined();
    const repeated = await f.oauth.refresh(input);
    expect(repeated.access_token).toBe(nearExpiry.access_token);
    expect(repeated.refresh_token).toBeUndefined();
    f.advance(14 * 60_000);
    await expect(f.oauth.refresh(input)).rejects.toMatchObject({ code: 'invalid_grant' });
    await f.state.close();

    const revoked = await fixture(); const token = await authorize(revoked);
    await revoked.oauth.refresh({ refreshToken: token.refresh_token!, clientId: revoked.client.id, resource: `${origin}/mcp` });
    await revoked.state.mutate({ type: 'record.upserted', collection: 'profiles', id: revoked.profile.id, value: { ...revoked.profile, version: 2 } as unknown as JsonValue });
    await expect(revoked.oauth.refresh({ refreshToken: token.refresh_token!, clientId: revoked.client.id, resource: `${origin}/mcp` })).rejects.toMatchObject({ code: 'invalid_grant' });
    await revoked.state.close();
  });

  it('recovers a lost refresh response after restart using the persistent encryption codec', async () => {
    const key = randomBytes(32);
    const f = await fixture(undefined, new StorageCipher(key, 'test-cache'));
    const initial = await authorize(f);
    const input = { refreshToken: initial.refresh_token!, clientId: f.client.id, resource: `${origin}/mcp` };
    const issued = await f.oauth.refresh(input);
    await f.state.close(); f.advance(6000);
    const reloaded = await createConfigStateStore(f.dataDir);
    const restarted = new OAuthService(reloaded, origin, f.now, [origin], undefined, new StorageCipher(key, 'test-cache'));
    const retry = await restarted.refresh(input);
    expect(retry.refresh_token).toBe(issued.refresh_token);
    expect(retry.access_token).toBe(issued.access_token);
    expect(retry.expires_in).toBe(894);
    await reloaded.close();
  });

  it('supports already-used legacy tokens without response metadata and retires their old successor', async () => {
    const f = await fixture(); const initial = await authorize(f);
    const input = { refreshToken: initial.refresh_token!, clientId: f.client.id, resource: `${origin}/mcp` };
    const second = await f.oauth.refresh(input);
    const [id, value] = Object.entries(f.state.read((v) => v.oauthGrants))[0]!;
    const { refreshResponse: _response, refreshGeneration: _generation, ...legacy } = value as Record<string, JsonValue>;
    await f.state.mutate({ type: 'record.upserted', collection: 'oauthGrants', id, value: legacy });
    f.advance(6000);
    const recovered = await f.oauth.refresh(input);
    expect(recovered.refresh_token).not.toBe(second.refresh_token);
    const successorRetry = await f.oauth.refresh({ ...input, refreshToken: second.refresh_token! });
    expect(successorRetry.refresh_token).toBe(recovered.refresh_token);
    expect(Object.values(f.state.read((v) => v.oauthTokens)).filter((v) => {
      const token = v as { kind: string; usedAt?: string }; return token.kind === 'refresh' && token.usedAt === undefined;
    })).toHaveLength(1);
    await f.state.close();
  });

  it('ignores unknown tokens and identifies expired grants without logging tokens', async () => {
    const diagnostics: OAuthRefreshDiagnostic[] = [];
    const { state, oauth, profile, client, requestId, advance } = await fixture((event) => diagnostics.push(event));
    await expect(oauth.refresh({ refreshToken: 'not-a-token', clientId: client.id, resource: `${origin}/mcp` }))
      .rejects.toMatchObject({ code: 'invalid_grant' });
    expect(diagnostics).toHaveLength(0);
    const code = new URL(await oauth.approve(requestId, profile.id, 3600, 'admin')).searchParams.get('code')!;
    const initial = await oauth.exchangeCode({ code, clientId: client.id, redirectUri, resource: `${origin}/mcp`, codeVerifier: verifier });
    advance(3600_001);
    await expect(oauth.refresh({ refreshToken: initial.refresh_token!, clientId: client.id, resource: `${origin}/mcp` }))
      .rejects.toMatchObject({ code: 'invalid_grant' });
    expect(diagnostics.at(-1)).toMatchObject({ outcome: 'rejected', reason: 'grant_expired' });
    expect(JSON.stringify(diagnostics)).not.toContain(initial.refresh_token!);
    await state.close();
  });

  it('does not let a failing diagnostic sink interrupt refresh', async () => {
    const { state, oauth, profile, client, requestId } = await fixture(() => { throw new Error('logging failed'); });
    const code = new URL(await oauth.approve(requestId, profile.id, 3600, 'admin')).searchParams.get('code')!;
    const initial = await oauth.exchangeCode({ code, clientId: client.id, redirectUri, resource: `${origin}/mcp`, codeVerifier: verifier });
    const renewed = await oauth.refresh({ refreshToken: initial.refresh_token!, clientId: client.id, resource: `${origin}/mcp` });
    expect(oauth.authenticate(renewed.access_token)).toBeDefined();
    await state.close();
  });

  it('invalidates access if profile rights change or the client is deleted', async () => {
    const { state, oauth, profile, client, requestId } = await fixture();
    const code = new URL(await oauth.approve(requestId, profile.id, 3600, 'admin')).searchParams.get('code')!;
    const token = await oauth.exchangeCode({ code, clientId: client.id, redirectUri, resource: `${origin}/mcp`, codeVerifier: verifier });
    const agentId = oauth.authenticate(token.access_token)!;
    await state.mutate({ type: 'record.upserted', collection: 'profiles', id: profile.id, value: { ...profile, version: 2 } as unknown as JsonValue });
    expect(oauth.authenticate(token.access_token)).toBeUndefined();
    await state.mutate({ type: 'record.upserted', collection: 'profiles', id: profile.id, value: profile as unknown as JsonValue });
    const agent = state.read((snapshot) => snapshot.clientTokens[agentId])!;
    await state.mutate({ type: 'record.upserted', collection: 'clientTokens', id: agentId, value: { ...agent, deletedAt: '2026-10-21T12:05:00.000Z' } });
    expect(oauth.authenticate(token.access_token)).toBeUndefined();
    await state.close();
  });

  it('rejects unsafe redirect URIs and expires pending requests', async () => {
    const { state, oauth, requestId, advance } = await fixture();
    await expect(oauth.registerClient('Bad', ['http://example.com/callback']))
      .rejects.toMatchObject({ code: 'invalid_client_metadata' });
    advance(10 * 60_000 + 1);
    expect(() => oauth.pending(requestId)).toThrow();
    await state.close();
  });

  it('stores an administrator-chosen label and limits the grant to thirty days', async () => {
    const { state, oauth, profile, requestId } = await fixture();
    await expect(oauth.approve(requestId, profile.id, 30 * 86400 + 1, 'admin', 'Work sandbox'))
      .rejects.toMatchObject({ code: 'invalid_grant_lifetime' });
    await expect(oauth.approve(requestId, profile.id, 3600, 'admin', '  '))
      .rejects.toMatchObject({ code: 'invalid_agent_label' });
    await oauth.approve(requestId, profile.id, 30 * 86400, 'admin', '  Work sandbox  ');
    const agent = Object.values(state.read((snapshot) => snapshot.clientTokens))[0] as { label: string; expiresAt: string };
    expect(agent.label).toBe('Work sandbox');
    expect(agent.expiresAt).toBe('2026-11-20T12:00:00.000Z');
    await state.close();
  });
});
