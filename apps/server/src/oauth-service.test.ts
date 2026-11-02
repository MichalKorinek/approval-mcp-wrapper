import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonValue, Profile, ProfileId } from '@approval-mcp/contracts';
import { createConfigStateStore } from '@approval-mcp/state-store';
import { describe, expect, it } from 'vitest';

import { OAuthService, type OAuthRefreshDiagnostic } from './oauth-service.js';

const origin = 'https://approval.example.test';
const redirectUri = 'http://127.0.0.1:45678/callback';
const verifier = 'a'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');

async function fixture(onRefreshDiagnostic?: (event: OAuthRefreshDiagnostic) => void) {
  const state = await createConfigStateStore(await mkdtemp(join(tmpdir(), 'approval-oauth-')));
  let clock = new Date('2026-10-21T12:00:00.000Z');
  const oauth = new OAuthService(state, origin, () => clock, [origin], onRefreshDiagnostic);
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
  return { state, oauth, profile, client, requestId, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
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

  it('rotates refresh tokens and revokes the grant on replay', async () => {
    const diagnostics: OAuthRefreshDiagnostic[] = [];
    const { state, oauth, profile, client, requestId } = await fixture((event) => diagnostics.push(event));
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
    await expect(oauth.refresh({ refreshToken: initial.refresh_token!, clientId: client.id, resource: `${origin}/mcp` }))
      .rejects.toMatchObject({ code: 'invalid_grant' });
    expect(diagnostics.at(-1)).toMatchObject({ event: 'oauth.refresh', outcome: 'rejected', reason: 'replay_detected' });
    expect(diagnostics.at(-1)?.grantId).toBe(diagnostics.at(-2)?.grantId);
    expect(JSON.stringify(diagnostics)).not.toContain(initial.refresh_token!);
    expect(JSON.stringify(diagnostics)).not.toContain(renewed.refresh_token!);
    expect(JSON.stringify(diagnostics)).not.toContain(initial.access_token);
    expect(oauth.authenticate(renewed.access_token)).toBeUndefined();
    await state.close();
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
