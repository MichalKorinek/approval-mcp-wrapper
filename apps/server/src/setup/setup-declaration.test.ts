import { describe, expect, it } from 'vitest';

import {
  parseCredentials,
  parseSetupDeclaration,
  withoutCredentials,
} from './setup-declaration.js';
import { SetupError } from './setup-error.js';

const valid = {
  source: ' workspace-a ',
  upstreams: [
    {
      alias: 'jira',
      url: 'https://jira.example.com/mcp',
      displayName: ' Jira ',
      metadata: { account: 'work' },
      credentials: { authorization: 'Bearer secret-token' },
    },
    { alias: 'local', url: 'http://k8s-mcp:8080/mcp', allowPrivateNetwork: true },
  ],
};

function rejects(value: unknown) {
  expect(() => parseSetupDeclaration(value)).toThrow(SetupError);
}

describe('parseSetupDeclaration', () => {
  it('normalizes a valid declaration and implies credentialsRequired', () => {
    const parsed = parseSetupDeclaration(valid);
    expect(parsed.source).toBe('workspace-a');
    expect(parsed.upstreams[0]).toEqual({
      alias: 'jira',
      url: 'https://jira.example.com/mcp',
      displayName: 'Jira',
      metadata: { account: 'work' },
      credentialsRequired: true,
      credentials: { authorization: 'Bearer secret-token' },
    });
    expect(parsed.upstreams[1]).toEqual({
      alias: 'local',
      url: 'http://k8s-mcp:8080/mcp',
      allowPrivateNetwork: true,
      credentialsRequired: false,
    });
  });

  it('rejects malformed declarations', () => {
    rejects(null);
    rejects({ upstreams: valid.upstreams });
    rejects({ source: 'a', upstreams: [] });
    rejects({ source: 'a', upstreams: [{ alias: 'x', url: 'ftp://example.com' }] });
    rejects({ source: 'a', upstreams: [{ alias: 'x', url: 'https://user:pw@example.com/mcp' }] });
    rejects({ source: 'a', upstreams: [{ alias: 'approval_mcp', url: 'https://example.com/mcp' }] });
    rejects({ source: 'a', upstreams: [{ alias: 'bad alias', url: 'https://example.com/mcp' }] });
    rejects({ source: 'a', upstreams: [{ alias: 'x', url: 'https://example.com/mcp', unknown: 1 }] });
    rejects({ source: 'a', upstreams: [{ alias: 'x', url: 'https://example.com/mcp', pluginVersion: '1.0.0' }] });
    rejects({ source: 'a', upstreams: [
      { alias: 'x', url: 'https://example.com/mcp' },
      { alias: 'x', url: 'https://example.org/mcp' },
    ] });
    rejects({ source: 'a', upstreams: Array.from({ length: 21 }, (_, index) => ({ alias: `u${index}`, url: 'https://example.com/mcp' })) });
  });

  it('accepts only aliases the gateway can expose', () => {
    const declare = (alias: string) =>
      parseSetupDeclaration({ source: 'a', upstreams: [{ alias, url: 'https://example.com/mcp' }] });
    for (const alias of ['Jira', 'jira__shadow', 'jira-', 'jira_', '-jira', `a${'b'.repeat(63)}c`]) {
      expect(() => declare(alias), alias).toThrow(SetupError);
    }
    for (const alias of ['a', '9', 'jira-cloud', 'jira_cloud', `a${'b'.repeat(62)}c`]) {
      expect(declare(alias).upstreams[0]?.alias).toBe(alias);
    }
  });
});

describe('parseCredentials', () => {
  it('accepts an authorization header and custom headers', () => {
    expect(parseCredentials({ authorization: 'Bearer a', headers: { 'X-Api-Key': 'b' } }))
      .toEqual({ authorization: 'Bearer a', headers: { 'X-Api-Key': 'b' } });
  });

  it('rejects empty, injected, or reserved headers', () => {
    for (const value of [
      {},
      { authorization: '' },
      { authorization: 'Bearer a\r\nX-Evil: 1' },
      { headers: {} },
      { headers: { Host: 'evil' } },
      { headers: { Authorization: 'Bearer a' } },
      { headers: { 'bad header': 'a' } },
      { authorization: 'a', extra: 'b' },
    ]) {
      expect(() => parseCredentials(value)).toThrow(SetupError);
    }
  });
});

describe('withoutCredentials', () => {
  it('drops credentials but keeps credentialsRequired', () => {
    const stripped = withoutCredentials(parseSetupDeclaration(valid));
    expect(stripped.upstreams[0]).not.toHaveProperty('credentials');
    expect(stripped.upstreams[0]?.credentialsRequired).toBe(true);
    expect(JSON.stringify(stripped)).not.toContain('secret-token');
  });
});
