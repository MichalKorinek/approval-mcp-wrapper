import { createHash } from 'node:crypto';

import type { Upstream } from '@approval-mcp/contracts';
import type { UpstreamCredentials } from '@approval-mcp/upstream';

import type { SetupDeclaration, SetupUpstreamDeclaration } from './setup-declaration.js';
import { SetupError } from './setup-error.js';

export type SetupAction = 'create' | 'update' | 'unchanged';
export type SetupField =
  | 'url' | 'allowPrivateNetwork' | 'displayName' | 'description'
  | 'metadata' | 'credentials';
export type CredentialPlan = 'none' | 'provided' | 'keep' | 'required' | 'remove';

export interface DesiredUpstream {
  url: string;
  allowPrivateNetwork: boolean;
  displayName?: string;
  description?: string;
  metadata?: Record<string, string>;
}

export interface SetupPlanItem {
  alias: string;
  action: SetupAction;
  upstreamId?: string;
  baseVersion?: number;
  changes: SetupField[];
  desired: DesiredUpstream;
  credentials: CredentialPlan;
}

export interface SetupPlan {
  items: SetupPlanItem[];
  digest: string;
}

export interface SetupPlanContext {
  upstreams: readonly Upstream[];
  readCredentials(upstream: Upstream): UpstreamCredentials | undefined;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function desiredFor(
  item: SetupUpstreamDeclaration,
  existing: Upstream | undefined,
): DesiredUpstream {
  const displayName = item.displayName ?? existing?.displayName;
  const description = item.description ?? existing?.description;
  const metadata = item.metadata ?? existing?.metadata;
  return {
    url: item.url,
    allowPrivateNetwork: item.allowPrivateNetwork ?? existing?.allowPrivateNetwork ?? false,
    ...(displayName === undefined ? {} : { displayName }),
    ...(description === undefined ? {} : { description }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function credentialPlan(
  item: SetupUpstreamDeclaration,
  stored: UpstreamCredentials | undefined,
  urlChanged: boolean,
): CredentialPlan {
  if (item.credentials !== undefined) {
    return !urlChanged && stored !== undefined &&
      canonicalJson(stored) === canonicalJson(item.credentials)
      ? 'keep'
      : 'provided';
  }
  if (stored !== undefined) {
    if (!urlChanged) return 'keep';
    return item.credentialsRequired ? 'required' : 'remove';
  }
  return item.credentialsRequired ? 'required' : 'none';
}

function planItem(item: SetupUpstreamDeclaration, context: SetupPlanContext): SetupPlanItem {
  const matches = context.upstreams.filter((upstream) => upstream.alias === item.alias);
  if (matches.length > 1) throw new SetupError('setup.alias_ambiguous', 409);
  const existing = matches[0];
  const desired = desiredFor(item, existing);

  if (existing === undefined) {
    const credentials = credentialPlan(item, undefined, false);
    const changes: SetupField[] = ['url', 'allowPrivateNetwork'];
    if (desired.displayName !== undefined) changes.push('displayName');
    if (desired.description !== undefined) changes.push('description');
    if (desired.metadata !== undefined) changes.push('metadata');
    if (credentials !== 'none') changes.push('credentials');
    return { alias: item.alias, action: 'create', changes, desired, credentials };
  }

  const changes: SetupField[] = [];
  const urlChanged = existing.url !== desired.url;
  if (urlChanged) changes.push('url');
  if (existing.allowPrivateNetwork !== desired.allowPrivateNetwork) changes.push('allowPrivateNetwork');
  if (existing.displayName !== desired.displayName) changes.push('displayName');
  if (existing.description !== desired.description) changes.push('description');
  if (canonicalJson(existing.metadata ?? null) !== canonicalJson(desired.metadata ?? null)) {
    changes.push('metadata');
  }
  const stored = existing.credentials === undefined ? undefined : context.readCredentials(existing);
  const credentials = credentialPlan(item, stored, urlChanged);
  if (credentials === 'provided' || credentials === 'required' || credentials === 'remove') {
    changes.push('credentials');
  }
  return {
    alias: item.alias,
    action: changes.length === 0 ? 'unchanged' : 'update',
    upstreamId: existing.id,
    baseVersion: existing.version,
    changes,
    desired,
    credentials,
  };
}

export function computeSetupPlan(
  declaration: SetupDeclaration,
  context: SetupPlanContext,
): SetupPlan {
  const items = declaration.upstreams.map((item) => planItem(item, context));
  const digest = createHash('sha256')
    .update(canonicalJson({ source: declaration.source, items }))
    .digest('hex');
  return { items, digest };
}
