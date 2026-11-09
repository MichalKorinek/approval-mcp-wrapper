import { describe, expect, it } from 'vitest';

import {
  approvalCredentials,
  enteredValue,
  requiredCredentialAliases,
  valueRows,
  warnsAboutPrivateNetwork,
  type SetupPlanItem,
} from './setup-approval-model.js';

function item(overrides: Partial<SetupPlanItem>): SetupPlanItem {
  return {
    alias: 'jira',
    action: 'create',
    changes: ['url', 'allowPrivateNetwork'],
    desired: { url: 'https://jira.example.com/mcp', allowPrivateNetwork: false },
    credentials: 'none',
    ...overrides,
  };
}

describe('setup approval model', () => {
  it('lists aliases that need operator credentials', () => {
    expect(requiredCredentialAliases([
      item({ alias: 'a', credentials: 'required' }),
      item({ alias: 'b', credentials: 'provided' }),
    ])).toEqual(['a']);
  });

  it('builds the approval credentials only when every required value is entered', () => {
    const items = [item({ alias: 'a', credentials: 'required' }), item({ alias: 'b' })];
    expect(approvalCredentials(items, {})).toBeUndefined();
    expect(approvalCredentials(items, { a: '  ' })).toBeUndefined();
    expect(approvalCredentials(items, { a: ' Bearer x ' })).toEqual({ a: { authorization: 'Bearer x' } });
    expect(approvalCredentials([item({})], {})).toEqual({});
  });

  it('does not read Object.prototype members for aliases like constructor', () => {
    const items = [item({ alias: 'constructor', credentials: 'required' })];
    expect(enteredValue({}, 'constructor')).toBe('');
    expect(approvalCredentials(items, {})).toBeUndefined();
    expect(JSON.stringify(approvalCredentials(items, { constructor: 'Bearer x' })))
      .toBe('{"constructor":{"authorization":"Bearer x"}}');
  });

  it('warns when a change grants private network access', () => {
    expect(warnsAboutPrivateNetwork(item({ desired: { url: 'http://k8s:8080/mcp', allowPrivateNetwork: true } }))).toBe(true);
    expect(warnsAboutPrivateNetwork(item({ desired: { url: 'http://k8s:8080/mcp', allowPrivateNetwork: true }, changes: ['url'] }))).toBe(false);
    expect(warnsAboutPrivateNetwork(item({ action: 'unchanged', changes: [] }))).toBe(false);
  });

  it('shows every value of a new upstream', () => {
    expect(valueRows(item({
      changes: ['url', 'allowPrivateNetwork', 'metadata'],
      desired: {
        url: 'https://jira.example.com/mcp',
        allowPrivateNetwork: false,
        metadata: { account: 'work', team: 'a' },
      },
    }))).toEqual([
      { field: 'url', value: 'https://jira.example.com/mcp', changed: true },
      { field: 'allowPrivateNetwork', value: false, changed: true },
      { field: 'metadata', value: 'account=work, team=a', changed: true },
    ]);
  });

  it('marks changed values and shows the replaced address', () => {
    const rows = valueRows(item({
      action: 'update',
      changes: ['url', 'displayName'],
      desired: { url: 'https://new.example.com/mcp', allowPrivateNetwork: false, displayName: 'New' },
      previousUrl: 'https://old.example.com/mcp',
    }));
    expect(rows).toEqual([
      { field: 'url', value: 'https://new.example.com/mcp', changed: true, before: 'https://old.example.com/mcp' },
      { field: 'allowPrivateNetwork', value: false, changed: false },
      { field: 'displayName', value: 'New', changed: true },
    ]);
  });
});
