import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { I18nProvider } from '../i18n/i18n.js';
import {
  UpstreamDeleteConfirmation,
  UpstreamEditForm,
} from './upstream-management.js';

describe('upstream management UI', () => {
  it('renders editable non-secret fields without credential material', () => {
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(UpstreamEditForm, {
          upstream: {
            id: 'upstream-1',
            alias: 'signal',
            displayName: 'Work messages',
            description: 'Primary work account',
            metadata: { account: 'work' },
            url: 'https://signal.example/mcp',
            allowPrivateNetwork: true,
            credentialsConfigured: true,
            version: 3,
            pluginId: 'minutes',
            pluginVersion: '1.0.0',
          },
          plugins: [],
          csrfToken: 'csrf',
          onSaved: () => undefined,
          onCancel: () => undefined,
        }),
      ),
    );

    expect(html).toContain('value="signal"');
    expect(html).toContain('value="Work messages"');
    expect(html).toContain('Primary work account');
    expect(html).toContain('value="account"');
    expect(html).toContain('value="work"');
    expect(html).toContain('value="https://signal.example/mcp"');
    expect(html).not.toContain('Bearer');
    expect(html).toContain('type="password"');
    expect(html).toContain('value="minutes@1.0.0"');
    expect(html).toContain('minutes · 1.0.0 (Disabled)');
  });

  it('shows cascade impact before removal', () => {
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(UpstreamDeleteConfirmation, {
          alias: 'signal',
          impact: { policies: 2, profileRules: 4, grants: 3 },
          busy: false,
          error: false,
          onConfirm: () => undefined,
          onCancel: () => undefined,
        }),
      ),
    );

    expect(html).toContain('signal');
    expect(html).toContain('2');
    expect(html).toContain('3');
    expect(html).toContain('4');
  });
});
