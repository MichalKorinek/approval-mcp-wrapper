#!/usr/bin/env node
// Submits a declarative upstream setup request to Approval MCP and waits for the
// operator's passkey approval. The request is authenticated with an MCP client
// token from APPROVAL_MCP_TOKEN. Credentials are read from environment variables,
// and neither they nor the token are ever printed.
//
// The wrapper image ships this script as `approval-mcp-setup`, so a project can run
//   docker exec -i <container> approval-mcp-setup < .approval-mcp.json
// without installing anything. `--file -` (the default there) reads standard input.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const DEFAULT_SERVER = 'http://localhost:3000';
const POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const PREFIX = 'approval-mcp-setup:';

function credentialRef(value, label) {
  if (typeof value === 'string') {
    throw new Error(`${label}: credentials must reference environment variables, not literal values`);
  }
  if (typeof value !== 'object' || value === null || typeof value.env !== 'string' || value.env === '') {
    throw new Error(`${label}: expected { "env": "VARIABLE_NAME" }`);
  }
  if (value.prefix !== undefined && typeof value.prefix !== 'string') {
    throw new Error(`${label}: prefix must be a string`);
  }
  return value;
}

/** fetch() with `redirect: 'error'` rejects with this cause when a server redirects. */
function isRedirectError(error) {
  return /redirect/i.test(String(error?.cause?.message ?? ''));
}

function resolveRef(ref, env) {
  const value = env[ref.env];
  return value === undefined || value === '' ? undefined : `${ref.prefix ?? ''}${value}`;
}

export function buildRequest(text, env) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error('the declaration file is not valid JSON');
  }
  if (typeof file !== 'object' || file === null || !Array.isArray(file.upstreams)) {
    throw new Error('the declaration file needs an "upstreams" array');
  }
  if (Object.hasOwn(file, 'server')) {
    // A committed file must not decide where credentials from your environment go.
    throw new Error('the declaration file cannot choose the server; use --server or APPROVAL_MCP_URL');
  }
  if (typeof file.source !== 'string' || file.source.trim() === '') {
    throw new Error('the declaration file needs a "source" name');
  }
  const awaitingCredentials = [];
  const upstreams = file.upstreams.map((item, index) => {
    if (typeof item !== 'object' || item === null) throw new Error(`upstreams[${index}] must be an object`);
    const { credentials, ...rest } = item;
    if (credentials === undefined) return rest;
    if (typeof credentials !== 'object' || credentials === null) {
      throw new Error(`upstreams[${index}].credentials must be an object`);
    }
    const resolved = {};
    let missing = false;
    if (credentials.authorization !== undefined) {
      const value = resolveRef(credentialRef(credentials.authorization, `upstreams[${index}].credentials.authorization`), env);
      if (value === undefined) missing = true;
      else resolved.authorization = value;
    }
    if (credentials.headers !== undefined) {
      if (typeof credentials.headers !== 'object' || credentials.headers === null) {
        throw new Error(`upstreams[${index}].credentials.headers must be an object`);
      }
      const headers = {};
      for (const [name, raw] of Object.entries(credentials.headers)) {
        const ref = credentialRef(raw, `upstreams[${index}].credentials.headers.${name}`);
        const value = resolveRef(ref, env);
        // The approval page only collects the Authorization header, so custom headers
        // must be complete before submission.
        if (value === undefined) {
          throw new Error(`upstreams[${index}].credentials.headers.${name}: set the environment variable ${ref.env}; custom headers cannot be entered on the approval page`);
        }
        headers[name] = value;
      }
      if (Object.keys(headers).length > 0) resolved.headers = headers;
      if (missing) {
        throw new Error(`upstreams[${index}].credentials.authorization: set the environment variable ${credentials.authorization.env}; an upstream with custom headers needs all of its credentials before submission`);
      }
    }
    if (missing || Object.keys(resolved).length === 0) {
      awaitingCredentials.push(String(rest.alias));
      return { ...rest, credentialsRequired: true };
    }
    return { ...rest, credentials: resolved };
  });
  return {
    body: { source: file.source.trim(), upstreams },
    awaitingCredentials,
  };
}

/** Reads the declaration from a file, or from standard input when `path` is `-`. */
export async function readDeclarationText(path, { stdin = process.stdin, readText = (file) => readFile(file, 'utf8') } = {}) {
  if (path !== '-') return readText(path);
  if (stdin.isTTY) {
    throw new Error('pipe the declaration on standard input, for example: approval-mcp-setup < .approval-mcp.json');
  }
  const chunks = [];
  for await (const chunk of stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') throw new Error('standard input is empty; pipe the declaration file into the command');
  return text;
}

export async function runSetup({
  file,
  server,
  env = process.env,
  readText = (path) => readDeclarationText(path),
  fetchImpl = fetch,
  log = (line) => console.log(line),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  let request;
  try {
    request = buildRequest(await readText(file), env);
  } catch (error) {
    log(`${PREFIX} ${error instanceof Error ? error.message : 'cannot read the declaration file'}`);
    return 1;
  }
  const token = env.APPROVAL_MCP_TOKEN;
  if (token === undefined || token === '') {
    log(`${PREFIX} set APPROVAL_MCP_TOKEN to an MCP client token (Access → Tokens)`);
    return 1;
  }
  const authorization = { authorization: `Bearer ${token}` };
  const declaredUrl = new Map(request.body.upstreams.map((item) => [item.alias, item.url]));
  const base = (server ?? env.APPROVAL_MCP_URL ?? DEFAULT_SERVER).replace(/\/+$/, '');
  // One deadline bounds everything, including a server that accepts the
  // connection but never answers.
  const deadline = now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - now());
  // Redirects are never followed: a 307/308 would resend the body, including
  // upstream credentials, to whatever origin the response names.
  const timed = (url, init = {}) => fetchImpl(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(Math.max(1, remaining())),
  });
  const refusedRedirect = () =>
    log(`${PREFIX} ${base} answered with a redirect, which is refused so nothing is sent elsewhere; point --server or APPROVAL_MCP_URL at the final address`);
  let response;
  let result;
  try {
    response = await timed(`${base}/api/setup/requests`, {
      method: 'POST',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
    });
    result = await response.json().catch(() => ({}));
  } catch (error) {
    if (isRedirectError(error)) refusedRedirect();
    else log(`${PREFIX} cannot reach ${base}`);
    return 1;
  }
  if (!response.ok) {
    log(`${PREFIX} request rejected (${result?.error?.code ?? `HTTP ${response.status}`})`);
    return 1;
  }
  for (const item of result.items ?? []) {
    log(`  ${String(item.action).padEnd(9)} ${item.alias}  ${declaredUrl.get(item.alias) ?? ''}`);
  }
  if (result.status === 'unchanged') {
    log(`${PREFIX} upstreams are up to date`);
    return 0;
  }
  for (const alias of request.awaitingCredentials) {
    log(`${PREFIX} the approval page asks for the Authorization value of "${alias}" when it needs one`);
  }
  log(`${PREFIX} approve the changes at ${result.approvalUrl}`);
  while (remaining() > 0) {
    await sleep(Math.min(POLL_INTERVAL_MS, remaining()));
    if (remaining() === 0) break;
    let status;
    try {
      const poll = await timed(`${base}/api/setup/requests/${encodeURIComponent(result.requestId)}/status`, {
        headers: authorization,
      });
      if (poll.status === 404) {
        log(`${PREFIX} the request expired or no longer exists; run the setup again`);
        return 1;
      }
      if (!poll.ok) continue;
      status = (await poll.json()).status;
    } catch (error) {
      if (isRedirectError(error)) {
        refusedRedirect();
        return 1;
      }
      continue;
    }
    if (status === 'applied') {
      log(`${PREFIX} changes applied`);
      return 0;
    }
    if (status === 'denied') {
      log(`${PREFIX} the request was denied`);
      return 1;
    }
  }
  log(`${PREFIX} timed out waiting for approval`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      file: { type: 'string', default: process.env.APPROVAL_MCP_SETUP_FILE || '.approval-mcp.json' },
      server: { type: 'string' },
      timeout: { type: 'string' },
    },
  });
  const timeoutSeconds = values.timeout === undefined ? undefined : Number(values.timeout);
  process.exitCode = await runSetup({
    file: values.file,
    ...(values.server === undefined ? {} : { server: values.server }),
    ...(timeoutSeconds === undefined || !Number.isFinite(timeoutSeconds) ? {} : { timeoutMs: timeoutSeconds * 1000 }),
  });
}
