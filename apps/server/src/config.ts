import { isAbsolute, join } from 'node:path';

import { z } from 'zod';

const environmentSchema = z.object({
  APPROVAL_MCP_PUBLIC_URL: z.url(),
  APPROVAL_MCP_OAUTH_ORIGINS: z.string().optional(),
  APPROVAL_MCP_ALLOW_INSECURE_OAUTH_PRIVATE_HTTP: z.enum(['true', 'false']).optional(),
  APPROVAL_MCP_DATA_DIR: z.string().min(1),
  APPROVAL_MCP_PLUGINS_DIR: z.string().min(1).optional(),
  APPROVAL_MCP_MASTER_KEY: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional()),
  APPROVAL_MCP_UNLOCK_NOTIFICATIONS: z.enum(['true', 'false']).optional(),
  APPROVAL_MCP_VAPID_SUBJECT: z.string().min(1).optional(),
});

export interface ServerConfig {
  publicUrl: URL;
  dataDir: string;
  pluginsDir: string;
  masterKey: Buffer | undefined;
  rpId: string;
  expectedOrigin: string;
  oauthOrigins: readonly string[];
  secureCookies: boolean;
  vapidSubject: string;
  unlockNotifications: boolean;
}

function assertVapidSubject(value: string): void {
  if (/^mailto:[^\s@]+@[^\s@]+$/.test(value)) return;
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
    ) return;
  } catch {
    // The shared error below keeps configuration failures actionable.
  }
  throw new Error(
    'APPROVAL_MCP_VAPID_SUBJECT must be a mailto address or HTTPS URL',
  );
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function oauthOrigin(value: string, allowPrivateHttp: boolean): string {
  const url = new URL(value);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' &&
      (loopback || (allowPrivateHttp && isPrivateIpv4(url.hostname)))))) {
    throw new Error('OAuth origins must be clean HTTPS origins or explicitly allowed local HTTP origins');
  }
  return url.origin;
}

export function loadConfig(
  environment: Record<string, string | undefined> = process.env,
): ServerConfig {
  const value = environmentSchema.parse(environment);
  const publicUrl = new URL(value.APPROVAL_MCP_PUBLIC_URL);
  const loopback =
    publicUrl.hostname === 'localhost' || publicUrl.hostname === '127.0.0.1';
  if (publicUrl.protocol !== 'https:' && !(loopback && publicUrl.protocol === 'http:')) {
    throw new Error(
      'APPROVAL_MCP_PUBLIC_URL must use HTTPS except on exact loopback hosts',
    );
  }
  if (
    publicUrl.username !== '' ||
    publicUrl.password !== '' ||
    publicUrl.pathname !== '/' ||
    publicUrl.search !== '' ||
    publicUrl.hash !== ''
  ) {
    throw new Error('APPROVAL_MCP_PUBLIC_URL must be a clean public origin');
  }
  if (!isAbsolute(value.APPROVAL_MCP_DATA_DIR)) {
    throw new Error('APPROVAL_MCP_DATA_DIR must be an absolute path');
  }
  const masterKey = value.APPROVAL_MCP_MASTER_KEY === undefined ? undefined : Buffer.from(value.APPROVAL_MCP_MASTER_KEY, 'base64');
  const pluginsDir = value.APPROVAL_MCP_PLUGINS_DIR ?? join(value.APPROVAL_MCP_DATA_DIR, 'plugins');
  if (!isAbsolute(pluginsDir)) throw new Error('APPROVAL_MCP_PLUGINS_DIR must be an absolute path');
  if (
    masterKey !== undefined && (masterKey.byteLength !== 32 ||
    masterKey.toString('base64') !== value.APPROVAL_MCP_MASTER_KEY)
  ) {
    throw new Error(
      'APPROVAL_MCP_MASTER_KEY must be a canonical base64-encoded 32-byte key',
    );
  }
  const vapidSubject =
    value.APPROVAL_MCP_VAPID_SUBJECT ??
    (publicUrl.protocol === 'https:'
      ? publicUrl.origin
      : 'mailto:approval-mcp@example.com');
  assertVapidSubject(vapidSubject);
  const oauthOrigins = [...new Set([
    publicUrl.origin,
    ...(value.APPROVAL_MCP_OAUTH_ORIGINS?.split(',').map((origin) => origin.trim()) ?? []),
  ].map((origin) => oauthOrigin(origin, value.APPROVAL_MCP_ALLOW_INSECURE_OAUTH_PRIVATE_HTTP === 'true')))];
  if (oauthOrigins.length > 16) throw new Error('APPROVAL_MCP_OAUTH_ORIGINS supports at most 16 origins');
  const hosts = oauthOrigins.map((origin) => new URL(origin).host);
  if (new Set(hosts).size !== hosts.length) {
    throw new Error('OAuth origins must use distinct host and port combinations');
  }
  return {
    publicUrl,
    dataDir: value.APPROVAL_MCP_DATA_DIR,
    pluginsDir,
    masterKey,
    rpId: publicUrl.hostname,
    expectedOrigin: publicUrl.origin,
    oauthOrigins,
    secureCookies: publicUrl.protocol === 'https:',
    vapidSubject,
    unlockNotifications: value.APPROVAL_MCP_UNLOCK_NOTIFICATIONS !== 'false',
  };
}
