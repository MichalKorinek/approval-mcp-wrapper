import { describe, expect, it } from 'vitest';
import { parsePluginRepository, pluginIdSchema } from './plugin-source.js';

describe('user-provided plugin repository', () => {
  it('normalizes only public HTTPS GitHub repository roots', () => {
    expect(parsePluginRepository('https://github.com/Some-Owner/Plugin.git/')).toBe('some-owner/plugin');
    expect(parsePluginRepository(' https://github.com/owner/plugin ')).toBe('owner/plugin');
  });
  it.each([
    'http://github.com/owner/repo', 'https://github.com.evil.test/owner/repo',
    'https://localhost/owner/repo', 'https://127.0.0.1/owner/repo',
    'https://secret@github.com/owner/repo', 'https://github.com:8443/owner/repo',
    'https://github.com/owner/repo?token=secret', 'https://github.com/owner/repo#main',
    'https://github.com/owner/repo/tree/main', 'https://github.com/owner/%2e%2e/repo',
    'https://github.com/owner/../other/repo', 'file:///tmp/plugin.mjs',
    'https://github.com/owner/.git', 'https://github.com/owner/..',
  ])('rejects arbitrary hosts, paths and embedded secrets: %s', (value) => {
    expect(() => parsePluginRepository(value)).toThrow();
  });
  it.each(['../escape', '__proto__', 'constructor', 'prototype', 'UPPERCASE'])('rejects unsafe plugin IDs: %s', (id) => {
    expect(pluginIdSchema.safeParse(id).success).toBe(false);
  });
});
