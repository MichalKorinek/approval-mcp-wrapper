import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { I18nProvider } from '../i18n/i18n.js';
import { ActiveGrants, type GrantView } from './active-grants.js';

describe('active grants UI', () => {
  it('shows who can use which tool, the expiry, condition, and revoke action', () => {
    const grant: GrantView = {
      id: 'grant-1',
      clientTokenId: 'token-1',
      tokenLabel: 'Claude Code',
      upstreamId: 'upstream-1',
      upstreamAlias: 'signal',
      toolName: 'get_conversations',
      predicates: [{ path: '/groupId', operator: 'exists' }],
      scope: 'until',
      createdAt: '2026-07-30T08:28:22.098Z',
      expiresAt: '2026-07-30T09:28:22.098Z',
      version: 1,
    };

    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(ActiveGrants, {
          grants: [grant],
          revokingId: undefined,
          onRevoke: () => undefined,
        }),
      ),
    );

    expect(html).toContain('Claude Code');
    expect(html).toContain('signal');
    expect(html).toContain('get_conversations');
    expect(html).toContain('/groupId');
    expect(html).toContain('Revoke');
    expect(html).toContain('2026');
  });

  it('does not expose internal IDs when referenced records are missing', () => {
    const grant: GrantView = {
      id: 'grant-1',
      clientTokenId: 'private-token-id',
      upstreamId: 'private-upstream-id',
      toolName: 'send_message',
      predicates: [],
      scope: 'forever',
      createdAt: '2026-07-30T08:28:22.098Z',
      version: 1,
    };

    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(ActiveGrants, {
          grants: [grant],
          revokingId: undefined,
          onRevoke: () => undefined,
        }),
      ),
    );

    expect(html).toContain('Unknown or removed agent');
    expect(html).toContain('Unknown or removed upstream');
    expect(html).not.toContain('private-token-id');
    expect(html).not.toContain('private-upstream-id');
    expect(html).toContain('Whole tool (any arguments)');
  });

  it('shows the plugin title and human-readable scope before predicates', () => {
    const grant: GrantView = {
      id: 'grant-minutes',
      clientTokenId: 'token-1',
      tokenLabel: 'Claude Code',
      upstreamId: 'upstream-1',
      upstreamAlias: 'minutes',
      toolName: 'send_message',
      predicates: [
        { path: '/conversationId', operator: 'equals', value: 'family-id' },
      ],
      presentation: {
        source: 'plugin',
        pluginId: 'minutes',
        pluginVersion: '1.0.0',
        title: {
          key: 'minutes.send',
          fallback: { en: 'Send a Signal message' },
        },
        scope: {
          key: 'minutes.scope',
          fallback: { en: 'Conversation: Family' },
        },
      },
      scope: 'forever',
      createdAt: '2026-07-30T08:28:22.098Z',
      version: 1,
    };

    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(ActiveGrants, {
          grants: [grant],
          revokingId: undefined,
          onRevoke: () => undefined,
        }),
      ),
    );

    expect(html).toContain('Minutes · Send a Signal message');
    expect(html).toContain('Conversation: Family');
    expect(html.indexOf('Conversation: Family')).toBeLessThan(
      html.indexOf('/conversationId'),
    );
  });
});
