import { isValidUpstreamAlias } from '@approval-mcp/gateway';
import type { UpstreamCredentials } from '@approval-mcp/upstream';

import {
  invalidInput,
  MAX_DESCRIPTION_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  optionalText,
  upstreamMetadata,
} from '../admin/upstream-validation.js';
import { SELF_UPSTREAM_ALIAS } from '../self-mcp-tools.js';
import { SetupError } from './setup-error.js';

export const MAX_SETUP_UPSTREAMS = 20;
const MAX_SOURCE_LENGTH = 120;
const MAX_URL_LENGTH = 2_048;
const MAX_CREDENTIAL_VALUE_LENGTH = 8_192;
const MAX_CREDENTIAL_HEADERS = 20;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const FORBIDDEN_HEADER_NAMES = new Set([
  'authorization', 'connection', 'content-length', 'content-type', 'host',
  'mcp-protocol-version', 'mcp-session-id', 'transfer-encoding',
]);
const UPSTREAM_KEYS = new Set([
  'alias', 'url', 'allowPrivateNetwork', 'displayName', 'description', 'metadata',
  'credentialsRequired', 'credentials',
]);

export interface SetupUpstreamDeclaration {
  alias: string;
  url: string;
  allowPrivateNetwork?: boolean;
  displayName?: string;
  description?: string;
  metadata?: Record<string, string>;
  credentialsRequired: boolean;
  credentials?: UpstreamCredentials;
}

export interface SetupDeclaration {
  source: string;
  upstreams: SetupUpstreamDeclaration[];
}

function invalid(): never {
  throw new SetupError('input.invalid');
}

function plainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function credentialValue(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_CREDENTIAL_VALUE_LENGTH ||
    /[\r\n\0]/.test(value)
  ) {
    invalid();
  }
  return value;
}

export function parseCredentials(value: unknown): UpstreamCredentials {
  const { authorization, headers, ...rest } = plainObject(value);
  if (Object.keys(rest).length > 0) invalid();
  const result: UpstreamCredentials = {};
  if (authorization !== undefined) result.authorization = credentialValue(authorization);
  if (headers !== undefined) {
    const entries = Object.entries(plainObject(headers));
    if (entries.length === 0 || entries.length > MAX_CREDENTIAL_HEADERS) invalid();
    const parsed: Record<string, string> = {};
    for (const [name, headerValue] of entries) {
      if (
        !HEADER_NAME_PATTERN.test(name) ||
        FORBIDDEN_HEADER_NAMES.has(name.toLowerCase()) ||
        Object.keys(parsed).some((key) => key.toLowerCase() === name.toLowerCase())
      ) {
        invalid();
      }
      parsed[name] = credentialValue(headerValue);
    }
    result.headers = parsed;
  }
  if (result.authorization === undefined && result.headers === undefined) invalid();
  return result;
}

function upstreamUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid();
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    invalid();
  }
  return url.href;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') invalid();
  return value;
}

function parseUpstream(value: unknown): SetupUpstreamDeclaration {
  const input = plainObject(value);
  if (Object.keys(input).some((key) => !UPSTREAM_KEYS.has(key))) invalid();
  const alias = input['alias'];
  if (typeof alias !== 'string' || !isValidUpstreamAlias(alias) || alias === SELF_UPSTREAM_ALIAS) {
    invalid();
  }
  const displayName = optionalText(input['displayName'], MAX_DISPLAY_NAME_LENGTH);
  const description = optionalText(input['description'], MAX_DESCRIPTION_LENGTH);
  const metadata = upstreamMetadata(input['metadata']);
  if (displayName === invalidInput || description === invalidInput || metadata === invalidInput) {
    invalid();
  }
  const allowPrivateNetwork = optionalBoolean(input['allowPrivateNetwork']);
  const credentialsRequired = optionalBoolean(input['credentialsRequired']) ?? false;
  const credentials = input['credentials'] === undefined
    ? undefined
    : parseCredentials(input['credentials']);
  return {
    alias,
    url: upstreamUrl(input['url']),
    ...(allowPrivateNetwork === undefined ? {} : { allowPrivateNetwork }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(description === undefined ? {} : { description }),
    ...(metadata === undefined ? {} : { metadata }),
    credentialsRequired: credentialsRequired || credentials !== undefined,
    ...(credentials === undefined ? {} : { credentials }),
  };
}

export function parseSetupDeclaration(value: unknown): SetupDeclaration {
  const { source, upstreams, ...rest } = plainObject(value);
  if (Object.keys(rest).length > 0) invalid();
  if (typeof source !== 'string') invalid();
  const normalizedSource = source.trim();
  if (normalizedSource === '' || normalizedSource.length > MAX_SOURCE_LENGTH) invalid();
  if (!Array.isArray(upstreams) || upstreams.length === 0 || upstreams.length > MAX_SETUP_UPSTREAMS) {
    invalid();
  }
  const parsed = upstreams.map(parseUpstream);
  if (new Set(parsed.map((item) => item.alias)).size !== parsed.length) invalid();
  return { source: normalizedSource, upstreams: parsed };
}

export function withoutCredentials(declaration: SetupDeclaration): SetupDeclaration {
  return {
    source: declaration.source,
    upstreams: declaration.upstreams.map(({ credentials: _credentials, ...item }) => item),
  };
}
