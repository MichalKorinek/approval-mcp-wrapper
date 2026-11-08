import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixtureFetch } from './plugin-fixtures.mjs';

test('fixture API authentication stays on GitHub API and redirects are rejected', async () => {
  const calls = [];
  const fixtureFetch = createFixtureFetch({ token: 'synthetic-test-token', fetcher: async (input, init) => {
    calls.push({ input, init });
    return Response.json({});
  } });
  for (const url of ['https://api.github.com/repos/test/plugin', 'https://raw.githubusercontent.com/test/plugin/main/plugin.mjs', 'https://api.github.com.example.invalid/repos/test/plugin', 'http://api.github.com/repos/test/plugin']) {
    await fixtureFetch(url, { headers: { accept: 'application/json' }, redirect: 'follow' });
  }
  assert.equal(calls[0].init.headers.get('authorization'), 'Bearer synthetic-test-token');
  for (const { init } of calls.slice(1)) assert.equal(init.headers.has('authorization'), false);
  for (const { init } of calls) {
    assert.equal(init.headers.get('accept'), 'application/json');
    assert.equal(init.redirect, 'error');
  }
});

test('fixture downloads work without a token and failures expose status, not token or response body', async () => {
  const fixtureFetch = createFixtureFetch({ token: '', fetcher: async (_input, init) => {
    assert.equal(init.headers.has('authorization'), false);
    return new Response('sensitive response body', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
  } });
  await assert.rejects(fixtureFetch('https://api.github.com/repos/test/plugin'), {
    message: 'Plugin fixture download failed: HTTP 403 from https://api.github.com; GitHub quota remaining: 0',
  });
});
