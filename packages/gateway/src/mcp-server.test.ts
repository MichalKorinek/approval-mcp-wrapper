import type {
  AdminId,
  ClientTokenId,
  Grant,
  GrantId,
  Policy,
  PolicyId,
  UpstreamId,
} from '@approval-mcp/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import {
  buildTokenCatalog,
  GatewayError,
  isValidUpstreamAlias,
  PolicyDeniedError,
  TokenScopedGateway,
  validateOrigin,
  createMcpHttpHandler,
  evaluateToolInspection,
  TOOL_INSPECTION_TOOL_NAME,
  withPolicyDescription,
} from './index.js';

const tokenA = 'token-a' as ClientTokenId;
const tokenB = 'token-b' as ClientTokenId;
const upstreamId = 'upstream-1' as UpstreamId;
const tools = [
  {
    upstreamId,
    upstreamAlias: 'signal',
    tool: { name: 'send_message', inputSchema: { type: 'object' } },
  },
  {
    upstreamId,
    upstreamAlias: 'signal',
    tool: { name: 'list_groups', inputSchema: { type: 'object' } },
  },
];

describe('token-scoped catalog', () => {
  it('returns deterministic and isolated tool lists for two tokens', () => {
    const visible = new Map([
      [tokenA, new Set(['signal__send_message'])],
      [tokenB, new Set(['signal__list_groups'])],
    ]);

    expect(buildTokenCatalog(tokenA, tools, visible).map((item) => item.name)).toEqual([
      'signal__send_message',
    ]);
    expect(buildTokenCatalog(tokenB, tools, visible).map((item) => item.name)).toEqual([
      'signal__list_groups',
    ]);
  });

  it('accepts only lowercase, unambiguous aliases of at most 64 characters', () => {
    for (const alias of ['a', '0', 'jira', 'jira-cloud', 'jira_cloud', 'a-b_c-9', `a${'b'.repeat(62)}c`]) {
      expect(isValidUpstreamAlias(alias), alias).toBe(true);
    }
    for (const alias of [
      'Jira', 'jira__shadow', 'jira-', 'jira_', '-jira', '_jira', '', 'ji ra', 'jira.cloud',
      `a${'b'.repeat(63)}c`,
    ]) {
      expect(isValidUpstreamAlias(alias), alias).toBe(false);
    }
  });

  it('leaves out invalid aliases and ambiguous names without hiding other tools', () => {
    const otherId = 'upstream-2' as UpstreamId;
    const sources = [
      ...tools,
      { upstreamId: otherId, upstreamAlias: 'bad__alias', tool: { name: 'send_message', inputSchema: {} } },
      { upstreamId: otherId, upstreamAlias: 'Jira', tool: { name: 'search', inputSchema: {} } },
      { upstreamId: otherId, upstreamAlias: 'jira-', tool: { name: 'search', inputSchema: {} } },
      // Two upstreams stored with the same alias: neither may claim the name.
      { upstreamId, upstreamAlias: 'dup', tool: { name: 'read', inputSchema: {} } },
      { upstreamId: otherId, upstreamAlias: 'dup', tool: { name: 'read', inputSchema: {} } },
    ];
    const visible = new Map([[tokenA, new Set([
      'signal__send_message', 'signal__list_groups', 'bad__alias__send_message',
      'Jira__search', 'jira-__search', 'jira__search', 'dup__read',
    ])]]);
    expect(buildTokenCatalog(tokenA, sources, visible).map((item) => item.name)).toEqual([
      'signal__list_groups',
      'signal__send_message',
    ]);
  });

  it('adds policy and timeout guidance without replacing the upstream description', () => {
    const described = withPolicyDescription(
      {
        name: 'send_message',
        description: 'Send a message.',
        inputSchema: { type: 'object' },
      },
      {
        approvalMayBeRequired: true,
        approvalTimeoutSeconds: 300,
        toolCallTimeoutSeconds: 1_800,
      },
    );

    expect(described.description).toContain('Send a message.');
    expect(described.description).toContain('human approval may be required');
    expect(described.description).toContain('300 seconds');
    expect(described.description).toContain('1800 seconds');
    expect(described.description).toContain(TOOL_INSPECTION_TOOL_NAME);
  });
});

describe('tool inspection policy evaluation', () => {
  const now = '2026-08-06T00:00:00.000Z';
  const policy: Policy = {
    id: 'policy-approval' as PolicyId,
    clientTokenId: tokenA,
    upstreamId,
    toolName: 'send_message',
    outcome: 'require_approval',
    predicates: [],
    enabled: true,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  const base = {
    publicToolName: 'signal__send_message',
    clientTokenId: tokenA,
    upstreamId,
    upstreamToolName: 'send_message',
    argumentsValue: { message: 'hello' },
    policies: [policy],
    approvalTimeoutSeconds: 300,
    toolCallTimeoutSeconds: 1_800,
    now,
  };

  it('reports approval and accounts for an active grant bypass', () => {
    expect(evaluateToolInspection({ ...base, grants: [] })).toMatchObject({
      outcome: 'require_approval',
      approvalRequired: true,
      reasonCode: 'approval.required',
      approvalTimeoutSeconds: 300,
      toolCallTimeoutSeconds: 1_800,
    });

    const grant: Grant = {
      id: 'grant-1' as GrantId,
      clientTokenId: tokenA,
      upstreamId,
      toolName: 'send_message',
      predicates: [],
      normalizationVersion: 1,
      approvedBy: 'admin-1' as AdminId,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    expect(evaluateToolInspection({ ...base, grants: [grant] })).toMatchObject({
      outcome: 'allow',
      approvalRequired: false,
      reasonCode: 'grant.matched',
    });
  });
});

describe('TokenScopedGateway', () => {
  it('returns the same public error for hidden and unknown tool guesses', async () => {
    const coordinator = { call: vi.fn() };
    const gateway = new TokenScopedGateway({
      coordinator,
      catalogFor: () => buildTokenCatalog(tokenA, tools, new Map([
        [tokenA, new Set(['signal__list_groups'])],
      ])),
    });

    const hidden = gateway.call(tokenA, 'signal__send_message', {}, new AbortController().signal);
    const unknown = gateway.call(tokenA, 'signal__does_not_exist', {}, new AbortController().signal);

    await expect(hidden).rejects.toMatchObject({ code: 'tool_not_found' });
    await expect(unknown).rejects.toMatchObject({ code: 'tool_not_found' });
    expect(coordinator.call).not.toHaveBeenCalled();
  });

  it('exposes the built-in inspection tool without sending it upstream', async () => {
    const coordinator = { call: vi.fn() };
    const inspectTool = vi.fn().mockReturnValue({
      toolName: 'signal__list_groups',
      outcome: 'require_approval',
      approvalRequired: true,
      reasonCode: 'approval.required',
      approvalTimeoutSeconds: 300,
      toolCallTimeoutSeconds: 1_800,
    });
    const gateway = new TokenScopedGateway({
      coordinator,
      catalogFor: () => buildTokenCatalog(tokenA, tools, new Map([
        [tokenA, new Set(['signal__list_groups'])],
      ])),
      inspectTool,
    });

    await expect(gateway.listTools(tokenA)).resolves.toEqual([
      expect.objectContaining({
        name: TOOL_INSPECTION_TOOL_NAME,
        annotations: expect.objectContaining({ readOnlyHint: true }),
      }),
      expect.objectContaining({ name: 'signal__list_groups' }),
    ]);
    await expect(
      gateway.call(
        tokenA,
        TOOL_INSPECTION_TOOL_NAME,
        {
          toolName: 'signal__list_groups',
          arguments: { group: 'family' },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      structuredContent: {
        toolName: 'signal__list_groups',
        approvalRequired: true,
        approvalTimeoutSeconds: 300,
        toolCallTimeoutSeconds: 1_800,
      },
    });
    expect(inspectTool).toHaveBeenCalledWith(
      tokenA,
      'signal__list_groups',
      { group: 'family' },
    );
    expect(coordinator.call).not.toHaveBeenCalled();

    await expect(
      gateway.call(
        tokenA,
        TOOL_INSPECTION_TOOL_NAME,
        {},
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true });
  });
});

describe('validateOrigin', () => {
  it('allows absent origins from non-browser clients and rejects foreign origins', () => {
    expect(() =>
      validateOrigin('https://admin.example.test', [
        'https://admin.example.test',
      ]),
    ).not.toThrow();
    expect(() => validateOrigin(undefined, ['https://admin.example.test'])).not.toThrow();
    expect(() =>
      validateOrigin('https://evil.example.test', [
        'https://admin.example.test',
      ]),
    ).toThrow('Origin');
  });
});

describe('Streamable HTTP MCP integration', () => {
  it('advertises OAuth metadata to an unauthenticated non-browser client', async () => {
    const gateway = new TokenScopedGateway({
      coordinator: { call: vi.fn() },
      catalogFor: () => [],
    });
    const handler = createMcpHttpHandler({
      allowedOrigins: ['https://approval.example.test'],
      resourceMetadataUrl: 'https://approval.example.test/.well-known/oauth-protected-resource/mcp',
      authenticate: async () => undefined,
      gateway,
    });
    const server = createServer((request, response) => { void handler(request, response); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('resource_metadata="https://approval.example.test/.well-known/oauth-protected-resource/mcp"');
    } finally {
      await handler.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it('advertises metadata for the requested allowed host and rejects unknown hosts', async () => {
    const gateway = new TokenScopedGateway({ coordinator: { call: vi.fn() }, catalogFor: () => [] });
    const handler = createMcpHttpHandler({
      allowedOrigins: ['https://approval.example.test', 'https://approval-alt.example.test'],
      originForHost: (host) => host === 'approval-alt.example.test'
        ? 'https://approval-alt.example.test' : host === 'approval.example.test'
          ? 'https://approval.example.test' : undefined,
      resourceMetadataUrl: (origin) => origin === undefined
        ? undefined : `${origin}/.well-known/oauth-protected-resource/mcp`,
      authenticate: async () => undefined,
      gateway,
    });
    const server = createServer((request, response) => { void handler(request, response); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
    try {
      const probe = (host: string) => new Promise<{ status: number | undefined; challenge: string | undefined }>((resolve, reject) => {
        httpRequest({ hostname: '127.0.0.1', port: address.port, path: '/mcp', headers: { host } }, (response) => {
          response.resume();
          response.on('end', () => resolve({
            status: response.statusCode,
            challenge: response.headers['www-authenticate'],
          }));
        }).on('error', reject).end();
      });
      const alias = await probe('approval-alt.example.test');
      expect(alias.status).toBe(401);
      expect(alias.challenge).toContain(
        'resource_metadata="https://approval-alt.example.test/.well-known/oauth-protected-resource/mcp"',
      );
      const unknown = await probe('untrusted.example.test');
      expect(unknown.status).toBe(421);
      expect(unknown.challenge).toBeUndefined();
    } finally {
      await handler.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it('notifies a subscribed modern client when the tool catalog changes', async () => {
    let currentTools = tools.slice(0, 1);
    const gateway = new TokenScopedGateway({
      coordinator: { call: vi.fn() },
      catalogFor: () => buildTokenCatalog(tokenA, currentTools, new Map([
        [tokenA, new Set(['signal__send_message', 'signal__list_groups'])],
      ])),
    });
    const handler = createMcpHttpHandler({
      allowedOrigins: ['https://admin.example.test'],
      authenticate: async (token) => token === 'valid' ? tokenA : undefined,
      gateway,
    });
    const server = createServer((request, response) => { void handler(request, response); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
    const client = new Client(
      { name: 'catalog-change-test', version: '1.0.0' },
      { capabilities: {}, versionNegotiation: { mode: 'auto' } },
    );
    let subscription: Awaited<ReturnType<Client['listen']>> | undefined;
    try {
      await client.connect(new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${address.port}/mcp`),
        { requestInit: { headers: { authorization: 'Bearer valid', origin: 'https://admin.example.test' } } },
      ));
      expect(client.getProtocolEra()).toBe('modern');
      const changed = new Promise<void>((resolve) => {
        client.setNotificationHandler('notifications/tools/list_changed', () => resolve());
      });
      subscription = await client.listen({ toolsListChanged: true });
      currentTools = tools;
      handler.notifyToolsChanged();
      await Promise.race([
        changed,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('No tools/list_changed notification')), 3_000)),
      ]);
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [{ name: 'signal__list_groups' }, { name: 'signal__send_message' }],
      });
    } finally {
      await subscription?.close();
      await client.close();
      await handler.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error === undefined ? resolve() : reject(error)),
      );
    }
  });

  it('serves the same authenticated gateway over legacy and modern MCP', async () => {
    const coordinator = {
      call: vi.fn(async (input: { arguments: Record<string, unknown> }) => {
        if (input.arguments['denied'] === true) {
          throw new PolicyDeniedError(
            'approval.denied',
            'The selected conversation is private.',
          );
        }
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      }),
    };
    const gateway = new TokenScopedGateway({
      coordinator,
      catalogFor: () =>
        buildTokenCatalog(
          tokenA,
          tools,
          new Map([[tokenA, new Set(['signal__list_groups'])]]),
        ),
      inspectTool: (_tokenId, toolName) => ({
        toolName,
        outcome: 'require_approval',
        approvalRequired: true,
        reasonCode: 'approval.required',
        approvalTimeoutSeconds: 300,
        toolCallTimeoutSeconds: 1_800,
      }),
    });
    const handler = createMcpHttpHandler({
      allowedOrigins: ['https://admin.example.test'],
      authenticate: async (token) => (token === 'valid' ? tokenA : undefined),
      gateway,
    });
    const server = createServer((request, response) => {
      void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP server address');
    }
    try {
      for (const era of ['legacy', 'modern'] as const) {
        const transport = new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${address.port}/mcp`),
          {
            requestInit: {
              headers: {
                authorization: 'Bearer valid',
                origin: 'https://admin.example.test',
              },
            },
          },
        );
        const client = new Client(
          { name: `gateway-${era}-test`, version: '1.0.0' },
          era === 'modern'
            ? {
                capabilities: {},
                versionNegotiation: { mode: 'auto' },
              }
            : { capabilities: {} },
        );
        try {
          await client.connect(transport);
          expect(client.getProtocolEra()).toBe(era);
          await expect(client.listTools()).resolves.toMatchObject({
            tools: [
              {
                name: TOOL_INSPECTION_TOOL_NAME,
                annotations: { readOnlyHint: true },
              },
              { name: 'signal__list_groups' },
            ],
          });
          await expect(
            client.callTool({
              name: TOOL_INSPECTION_TOOL_NAME,
              arguments: { toolName: 'signal__list_groups', arguments: {} },
            }),
          ).resolves.toMatchObject({
            structuredContent: {
              toolName: 'signal__list_groups',
              approvalRequired: true,
              approvalTimeoutSeconds: 300,
              toolCallTimeoutSeconds: 1_800,
            },
          });
          await expect(
            client.callTool({ name: 'signal__list_groups', arguments: {} }),
          ).resolves.toMatchObject({
            content: [{ type: 'text', text: 'ok' }],
          });
          await expect(
            client.callTool({
              name: 'signal__list_groups',
              arguments: { denied: true },
            }),
          ).resolves.toMatchObject({
            isError: true,
            content: [
              {
                type: 'text',
                text: 'Tool call denied: The selected conversation is private.',
              },
            ],
          });
        } finally {
          await client.close();
        }
      }
      expect(coordinator.call).toHaveBeenCalledTimes(4);
    } finally {
      await handler.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });
});
