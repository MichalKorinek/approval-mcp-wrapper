import type { EncryptedCredentialEnvelope, Upstream, UpstreamId } from '@approval-mcp/contracts';
import type { UpstreamCredentials } from '@approval-mcp/upstream';
import { describe, expect, it } from 'vitest';

import { parseSetupDeclaration } from './setup-declaration.js';
import { SetupError } from './setup-error.js';
import { computeSetupPlan, type SetupPlanContext } from './setup-plan.js';

const envelope: EncryptedCredentialEnvelope = {
  algorithm: 'aes-256-gcm', ciphertext: 'c', nonce: 'n', tag: 't', version: 1,
};

function upstream(overrides: Partial<Upstream> = {}): Upstream {
  return {
    id: 'u-1' as UpstreamId,
    alias: 'jira',
    url: 'https://jira.example.com/mcp',
    allowPrivateNetwork: false,
    schemaVersion: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    version: 3,
    ...overrides,
  };
}

function context(upstreams: Upstream[], stored?: UpstreamCredentials): SetupPlanContext {
  return { upstreams, readCredentials: () => stored };
}

function plan(item: Record<string, unknown>, ctx: SetupPlanContext) {
  return computeSetupPlan(parseSetupDeclaration({ source: 'ws', upstreams: [item] }), ctx);
}

describe('computeSetupPlan', () => {
  it('plans a create with provided credentials', () => {
    const result = plan({ alias: 'jira', url: 'https://jira.example.com/mcp', credentials: { authorization: 'Bearer a' } }, context([]));
    expect(result.items).toEqual([{
      alias: 'jira',
      action: 'create',
      changes: ['url', 'allowPrivateNetwork', 'credentials'],
      desired: { url: 'https://jira.example.com/mcp', allowPrivateNetwork: false },
      credentials: 'provided',
    }]);
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain('Bearer a');
  });

  it('plans a create that needs credentials from the operator', () => {
    const result = plan({ alias: 'jira', url: 'https://jira.example.com/mcp', credentialsRequired: true }, context([]));
    expect(result.items[0]).toMatchObject({ action: 'create', credentials: 'required' });
  });

  it('is unchanged when the declaration matches, keeping stored credentials', () => {
    const result = plan(
      { alias: 'jira', url: 'https://jira.example.com/mcp', credentials: { authorization: 'Bearer a' } },
      context([upstream({ credentials: envelope })], { authorization: 'Bearer a' }),
    );
    expect(result.items[0]).toMatchObject({ action: 'unchanged', changes: [], credentials: 'keep', upstreamId: 'u-1', baseVersion: 3 });
  });

  it('keeps optional fields that the declaration leaves out', () => {
    const result = plan(
      { alias: 'jira', url: 'https://jira.example.com/mcp' },
      context([upstream({ displayName: 'Jira', metadata: { a: 'b' }, allowPrivateNetwork: true })]),
    );
    expect(result.items[0]).toMatchObject({
      action: 'unchanged',
      desired: { displayName: 'Jira', metadata: { a: 'b' }, allowPrivateNetwork: true },
    });
  });

  it('detects field changes', () => {
    const result = plan(
      { alias: 'jira', url: 'https://jira.example.com/mcp', displayName: 'New', metadata: { a: 'c' } },
      context([upstream({ displayName: 'Old', metadata: { a: 'b' } })]),
    );
    expect(result.items[0]).toMatchObject({ action: 'update', changes: ['displayName', 'metadata'], credentials: 'none' });
  });

  it('never carries stored credentials to a changed URL', () => {
    const existing = [upstream({ credentials: envelope })];
    const stored = { authorization: 'Bearer a' };
    expect(plan({ alias: 'jira', url: 'https://evil.example.com/mcp' }, context(existing, stored)).items[0])
      .toMatchObject({ action: 'update', changes: ['url', 'credentials'], credentials: 'remove' });
    expect(plan({ alias: 'jira', url: 'https://evil.example.com/mcp', credentialsRequired: true }, context(existing, stored)).items[0])
      .toMatchObject({ credentials: 'required' });
    expect(plan({ alias: 'jira', url: 'https://evil.example.com/mcp', credentials: stored }, context(existing, stored)).items[0])
      .toMatchObject({ credentials: 'provided' });
  });

  it('replaces different credentials', () => {
    const result = plan(
      { alias: 'jira', url: 'https://jira.example.com/mcp', credentials: { authorization: 'Bearer new' } },
      context([upstream({ credentials: envelope })], { authorization: 'Bearer old' }),
    );
    expect(result.items[0]).toMatchObject({ action: 'update', changes: ['credentials'], credentials: 'provided' });
  });

  it('ignores the plugin, which is assigned in the admin UI', () => {
    const result = plan(
      { alias: 'jira', url: 'https://jira.example.com/mcp' },
      context([upstream({ pluginId: 'jira', pluginVersion: '1.0.0' })]),
    );
    expect(result.items[0]).toMatchObject({ action: 'unchanged', changes: [] });
  });

  it('rejects ambiguous aliases', () => {
    let failure: unknown;
    try {
      plan(
        { alias: 'jira', url: 'https://jira.example.com/mcp' },
        context([upstream(), upstream({ id: 'u-2' as UpstreamId })]),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SetupError);
    expect(failure).toMatchObject({ code: 'setup.alias_ambiguous', status: 409 });
  });

  it('changes the digest when the stored version changes', () => {
    const item = { alias: 'jira', url: 'https://jira.example.com/mcp', displayName: 'New' };
    expect(plan(item, context([upstream({ version: 3 })])).digest)
      .not.toBe(plan(item, context([upstream({ version: 4 })])).digest);
  });
});
