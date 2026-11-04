import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { I18nProvider } from '../i18n/i18n.js';
import { ApprovalDetail } from './approval-detail.js';

describe('ApprovalDetail', () => {
  it('defaults destructive calls to one-time approval and offers explicit tool-wide selection', () => {
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(ApprovalDetail, {
          approval: {
            id: 'approval-1',
            requestHash: 'hash',
            toolName: 'leave_group',
            arguments: { groupId: 'family-id' },
            createdAt: '2026-08-05T12:00:00.000Z',
            expiresAt: '2026-08-05T12:01:00.000Z',
            presentation: {
              source: 'plugin',
              title: {
                key: 'minutes.leave',
                fallback: { en: 'Leave group: Family' },
              },
              sections: [],
              proposedScopes: [],
            },
          },
          csrfToken: 'csrf',
          connected: true,
          onClosed: () => undefined,
        }),
      ),
    );

    expect(html).toContain('Deny');
    expect(html).toContain('Reason for denial (optional)');
    expect(html).toContain('<textarea');
    expect(html).toContain('Allow once');
    expect(html).toContain('Whole tool (any arguments)');
    expect(html).not.toContain('Allow for 1 hour');
    expect(html).not.toContain('Always allow');
  });
});
