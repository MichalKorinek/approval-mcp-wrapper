import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { buildRequest, readDeclarationText, runSetup } from './approval-mcp-setup.mjs';

const SECRET = 'secret-token-123';
const declaration = JSON.stringify({
  source: 'ws',
  server: 'http://localhost:3999',
  upstreams: [
    { alias: 'jira', url: 'https://jira.example.com/mcp', credentials: { authorization: { env: 'JIRA_TOKEN', prefix: 'Bearer ' } } },
    { alias: 'k8s', url: 'http://k8s-mcp:8080/mcp', allowPrivateNetwork: true },
  ],
});

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function harness(responses, env = { JIRA_TOKEN: SECRET }) {
  const calls = [];
  const lines = [];
  let clock = 0;
  const options = {
    file: '.approval-mcp.json',
    env,
    readText: async () => declaration,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return responses.shift(); },
    log: (line) => lines.push(line),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  return { options, calls, lines };
}

describe('buildRequest', () => {
  it('resolves credentials from the environment', () => {
    const { body, server, awaitingCredentials } = buildRequest(declaration, { JIRA_TOKEN: SECRET });
    assert.equal(server, 'http://localhost:3999');
    assert.deepEqual(body.upstreams[0].credentials, { authorization: `Bearer ${SECRET}` });
    assert.equal(body.upstreams[1].credentials, undefined);
    assert.deepEqual(awaitingCredentials, []);
    assert.equal('server' in body, false);
  });

  it('asks for credentials in the approval page when the variable is missing', () => {
    const { body, awaitingCredentials } = buildRequest(declaration, {});
    assert.equal(body.upstreams[0].credentials, undefined);
    assert.equal(body.upstreams[0].credentialsRequired, true);
    assert.deepEqual(awaitingCredentials, ['jira']);
  });

  it('refuses to submit when a custom header variable is missing', () => {
    const headers = JSON.stringify({ source: 'ws', upstreams: [{
      alias: 'api', url: 'https://api.example/mcp',
      credentials: { authorization: { env: 'API_TOKEN' }, headers: { 'X-Api-Key': { env: 'API_KEY' } } },
    }] });
    assert.throws(() => buildRequest(headers, { API_TOKEN: 'a' }), /API_KEY/);
    assert.throws(() => buildRequest(headers, { API_KEY: 'b' }), /API_TOKEN/);
    assert.deepEqual(buildRequest(headers, { API_TOKEN: 'a', API_KEY: 'b' }).body.upstreams[0].credentials, {
      authorization: 'a', headers: { 'X-Api-Key': 'b' },
    });
  });

  it('rejects literal secrets in the file', () => {
    const literal = JSON.stringify({ source: 'ws', upstreams: [{ alias: 'a', url: 'https://a.example/mcp', credentials: { authorization: 'Bearer x' } }] });
    assert.throws(() => buildRequest(literal, {}), /environment variables/);
  });
});

describe('runSetup', () => {
  it('exits 0 without waiting when everything is unchanged', async () => {
    const h = harness([response(200, { status: 'unchanged', items: [{ alias: 'jira', action: 'unchanged', desired: { url: 'u' } }] })]);
    assert.equal(await runSetup(h.options), 0);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].url, 'http://localhost:3999/api/setup/requests');
  });

  it('submits, prints the approval link, and waits for approval', async () => {
    const h = harness([
      response(202, { status: 'pending', requestId: 'r1', approvalUrl: 'http://localhost:3999/setup/requests/r1', items: [{ alias: 'jira', action: 'create', desired: { url: 'u' } }] }),
      response(200, { status: 'pending' }),
      response(200, { status: 'applied' }),
    ]);
    assert.equal(await runSetup(h.options), 0);
    assert.equal(h.calls[1].url, 'http://localhost:3999/api/setup/requests/r1/status');
    assert.ok(h.lines.some((line) => line.includes('http://localhost:3999/setup/requests/r1')));
    assert.ok(JSON.parse(h.calls[0].init.body).upstreams[0].credentials.authorization.endsWith(SECRET));
    assert.ok(h.lines.every((line) => !line.includes(SECRET)));
  });

  it('tells which credentials the approval page will ask for', async () => {
    const h = harness([
      response(202, { status: 'pending', requestId: 'r1', approvalUrl: 'http://x/setup/requests/r1', items: [
        { alias: 'jira', action: 'create', credentials: 'provided', desired: { url: 'u' } },
        { alias: 'docs', action: 'create', credentials: 'required', desired: { url: 'u' } },
      ] }),
      response(200, { status: 'applied' }),
    ]);
    assert.equal(await runSetup(h.options), 0);
    assert.deepEqual(h.lines.filter((line) => line.includes('approval page')), [
      'approval-mcp-setup: enter the Authorization value for "docs" on the approval page',
    ]);
  });

  it('fails when the request is denied, gone, or rejected', async () => {
    const pending = response(202, { status: 'pending', requestId: 'r1', approvalUrl: 'http://x/setup/requests/r1', items: [] });
    assert.equal(await runSetup(harness([pending, response(200, { status: 'denied' })]).options), 1);
    assert.equal(await runSetup(harness([{ ...pending }, response(404, {})]).options), 1);
    assert.equal(await runSetup(harness([response(400, { error: { code: 'input.invalid' } })]).options), 1);
  });

  it('bounds a server that never answers by the same deadline', async () => {
    const hanging = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
    const lines = [];
    const submitHangs = await runSetup({
      file: 'x', env: { JIRA_TOKEN: SECRET }, readText: async () => declaration,
      fetchImpl: hanging, log: (line) => lines.push(line), timeoutMs: 50,
    });
    assert.equal(submitHangs, 1);

    let calls = 0;
    const pollHangs = await runSetup({
      file: 'x', env: { JIRA_TOKEN: SECRET }, readText: async () => declaration, log: () => {},
      sleep: async () => {}, timeoutMs: 50,
      fetchImpl: (url, init) => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(response(202, { status: 'pending', requestId: 'r1', approvalUrl: 'http://x/setup/requests/r1', items: [] }))
          : hanging(url, init);
      },
    });
    assert.equal(pollHangs, 1);
  });

  it('times out', async () => {
    const pending = response(202, { status: 'pending', requestId: 'r1', approvalUrl: 'http://x/setup/requests/r1', items: [] });
    const h = harness([pending, ...Array.from({ length: 10 }, () => response(200, { status: 'pending' }))]);
    assert.equal(await runSetup({ ...h.options, timeoutMs: 6_000 }), 1);
  });
});

describe('readDeclarationText', () => {
  it('reads standard input for "-" so the file can be piped into a container', async () => {
    assert.equal(await readDeclarationText('-', { stdin: Readable.from([Buffer.from(declaration)]) }), declaration);
  });

  it('explains how to pipe the file when standard input is a terminal or empty', async () => {
    const terminal = Object.assign(Readable.from([]), { isTTY: true });
    await assert.rejects(readDeclarationText('-', { stdin: terminal }), /approval-mcp-setup < \.approval-mcp\.json/);
    await assert.rejects(readDeclarationText('-', { stdin: Readable.from([]) }), /standard input is empty/);
  });

  it('reads a regular file path', async () => {
    assert.equal(await readDeclarationText('x.json', { readText: async (path) => `file:${path}` }), 'file:x.json');
  });
});
