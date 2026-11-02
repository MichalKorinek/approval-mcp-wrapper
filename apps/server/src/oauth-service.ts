import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { ClientTokenId, ClientTokenRecord, JsonValue, Profile, ProfileId, TokenProfileAssignment } from '@approval-mcp/contracts';
import type { ConfigStateStore, StateOperation } from '@approval-mcp/state-store';

const REQUEST_LIFETIME_MS = 10 * 60_000;
const CODE_LIFETIME_MS = 5 * 60_000;
const ACCESS_LIFETIME_MS = 15 * 60_000;
const MAX_GRANT_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

interface OAuthClient {
  id: string;
  name: string;
  issuer?: string;
  redirectUris: string[];
  createdAt: string;
}

interface OAuthRequest {
  id: string;
  clientId: string;
  issuer?: string;
  redirectUri: string;
  resource: string;
  codeChallenge: string;
  state?: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'denied';
  decidedByAdminId?: string;
  decidedAt?: string;
}

interface OAuthCode {
  grantId: string;
  issuer?: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  codeChallenge: string;
  expiresAt: string;
}

interface OAuthGrant {
  id: string;
  clientTokenId: ClientTokenId;
  clientId: string;
  issuer?: string;
  resource?: string;
  profileId: ProfileId;
  profileVersion: number;
  createdAt: string;
  approvedByAdminId: string;
  expiresAt: string;
  revokedAt?: string;
}

interface OAuthToken {
  grantId: string;
  kind: 'access' | 'refresh';
  expiresAt: string;
  usedAt?: string;
}

export class OAuthError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

export interface OAuthRefreshDiagnostic {
  event: 'oauth.refresh';
  timestamp: string;
  outcome: 'issued' | 'rejected';
  reason?: 'grant_expired' | 'grant_inactive' | 'binding_mismatch' | 'token_expired' | 'replay_detected';
  grantId?: string;
  agentId?: string;
  grantExpiresAt?: string;
}

function hash(value: string): string {
  return createHash('sha256').update(`approval-mcp:oauth:${value}`).digest('hex');
}

function redirectUriAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username !== '' || url.password !== '' || url.hash !== '' ||
      ['code', 'state', 'iss', 'error'].some((key) => url.searchParams.has(key))) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function record<T>(value: JsonValue | undefined): T | undefined {
  return value === undefined ? undefined : value as T;
}

function upsert(collection: StateOperation['collection'], id: string, value: unknown): StateOperation {
  return { type: 'record.upserted', collection, id, value: value as JsonValue };
}

function redirectWith(uri: string, values: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

export class OAuthService {
  readonly issuer: string;
  readonly resource: string;
  readonly #state: ConfigStateStore;
  readonly #now: () => Date;
  readonly #originByHost: ReadonlyMap<string, string>;
  readonly #onRefreshDiagnostic: ((event: OAuthRefreshDiagnostic) => void) | undefined;
  #queue: Promise<void> = Promise.resolve();

  constructor(
    state: ConfigStateStore,
    publicOrigin: string,
    now: () => Date = () => new Date(),
    origins: readonly string[] = [publicOrigin],
    onRefreshDiagnostic?: (event: OAuthRefreshDiagnostic) => void,
  ) {
    this.#state = state;
    this.issuer = publicOrigin;
    this.resource = `${publicOrigin}/mcp`;
    this.#now = now;
    this.#onRefreshDiagnostic = onRefreshDiagnostic;
    this.#originByHost = new Map(origins.map((origin) => [new URL(origin).host.toLowerCase(), origin]));
    if (!this.#originByHost.has(new URL(publicOrigin).host.toLowerCase())) {
      throw new Error('The passkey origin must be an allowed OAuth origin');
    }
  }

  originForHost(host: string | undefined): string | undefined {
    return host === undefined ? undefined : this.#originByHost.get(host.toLowerCase());
  }

  resourceFor(origin: string): string {
    if (this.originForHost(new URL(origin).host) !== origin) throw new OAuthError('invalid_resource');
    return `${origin}/mcp`;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  #reportRefresh(event: Omit<OAuthRefreshDiagnostic, 'event' | 'timestamp'>): void {
    try {
      this.#onRefreshDiagnostic?.({ event: 'oauth.refresh', timestamp: this.#now().toISOString(), ...event });
    } catch {
      // Diagnostics must never change the result of a token refresh.
    }
  }

  async registerClient(name: string, redirectUris: readonly string[], issuer = this.issuer): Promise<OAuthClient> {
    if (this.originForHost(new URL(issuer).host) !== issuer) throw new OAuthError('invalid_client_metadata');
    if (name.trim().length === 0 || name.length > 120 || redirectUris.length < 1 || redirectUris.length > 8 ||
      redirectUris.some((uri) => uri.length > 2048 || !redirectUriAllowed(uri))) {
      throw new OAuthError('invalid_client_metadata');
    }
    const client: OAuthClient = {
      id: randomUUID(), name: name.trim(), issuer, redirectUris: [...new Set(redirectUris)],
      createdAt: this.#now().toISOString(),
    };
    await this.#state.mutate(upsert('oauthClients', client.id, client));
    return client;
  }

  async request(input: {
    clientId: string;
    redirectUri: string;
    resource: string;
    responseType: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scope?: string;
    state?: string;
  }): Promise<string> {
    const client = this.#state.read((state) => record<OAuthClient>(state.oauthClients[input.clientId]));
    if (client === undefined || !client.redirectUris.includes(input.redirectUri)) throw new OAuthError('invalid_client');
    const issuer = client.issuer ?? this.issuer;
    if (input.responseType !== 'code' || input.resource !== this.resourceFor(issuer) ||
      input.codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge) ||
      (input.scope !== undefined && input.scope !== 'mcp:access') ||
      (input.state !== undefined && input.state.length > 1024)) {
      throw new OAuthError('invalid_request');
    }
    const request: OAuthRequest = {
      id: randomUUID(), clientId: client.id, issuer, redirectUri: input.redirectUri,
      resource: input.resource, codeChallenge: input.codeChallenge,
      ...(input.state === undefined ? {} : { state: input.state }),
      expiresAt: new Date(this.#now().getTime() + REQUEST_LIFETIME_MS).toISOString(),
      status: 'pending',
    };
    await this.#state.mutate(upsert('oauthRequests', request.id, request));
    return request.id;
  }

  pending(id: string): { clientName: string; clientId: string; redirectUri: string; resource: string; profiles: { id: string; name: string; version: number; ruleCount: number }[] } {
    return this.#state.read((state) => {
      const request = record<OAuthRequest>(state.oauthRequests[id]);
      if (request === undefined || request.status !== 'pending' || request.expiresAt <= this.#now().toISOString()) {
        throw new OAuthError('invalid_request', 404);
      }
      const client = record<OAuthClient>(state.oauthClients[request.clientId]);
      if (client === undefined) throw new OAuthError('invalid_client', 404);
      return {
        clientName: client.name, clientId: client.id, redirectUri: request.redirectUri,
        resource: request.resource,
        profiles: Object.values(state.profiles).map((value) => value as unknown as Profile)
          .map((profile) => ({
            id: profile.id, name: profile.name, version: profile.version,
            ruleCount: Object.values(state.profileRules).filter((value) =>
              (value as { profileId?: unknown; enabled?: unknown }).profileId === profile.id &&
              (value as { enabled?: unknown }).enabled === true).length,
          })),
      };
    });
  }

  async approve(id: string, profileId: string, lifetimeSeconds: number, adminId: string, label?: string): Promise<string> {
    return this.#serialize(async () => {
      if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 300 || lifetimeSeconds > MAX_GRANT_LIFETIME_SECONDS) {
        throw new OAuthError('invalid_grant_lifetime');
      }
      if (label !== undefined && (label.trim().length === 0 || label.trim().length > 120)) {
        throw new OAuthError('invalid_agent_label');
      }
      const now = this.#now();
      const snapshot = this.#state.read((state) => ({
        request: record<OAuthRequest>(state.oauthRequests[id]),
        profile: record<Profile>(state.profiles[profileId]),
      }));
      const { request, profile } = snapshot;
      if (request === undefined || request.status !== 'pending' || request.expiresAt <= now.toISOString()) {
        throw new OAuthError('invalid_request', 404);
      }
      if (profile === undefined) throw new OAuthError('invalid_profile');
      const clientTokenId = randomUUID() as ClientTokenId;
      const grantId = randomUUID();
      const code = randomBytes(32).toString('base64url');
      const codeRecord: OAuthCode = {
        grantId, clientId: request.clientId, issuer: request.issuer ?? this.issuer, redirectUri: request.redirectUri,
        resource: request.resource, codeChallenge: request.codeChallenge,
        expiresAt: new Date(now.getTime() + CODE_LIFETIME_MS).toISOString(),
      };
      const grant: OAuthGrant = {
        id: grantId, clientTokenId, clientId: request.clientId,
        issuer: request.issuer ?? this.issuer, resource: request.resource,
        profileId: profile.id, profileVersion: profile.version,
        createdAt: now.toISOString(),
        approvedByAdminId: adminId,
        expiresAt: new Date(now.getTime() + lifetimeSeconds * 1000).toISOString(),
      };
      const client = this.#state.read((state) => record<OAuthClient>(state.oauthClients[request.clientId]));
      const agent: ClientTokenRecord = {
        id: clientTokenId, label: label?.trim() ?? client?.name ?? 'OAuth sandbox', authKind: 'oauth',
        hash: '', salt: '', expiresAt: grant.expiresAt,
        schemaVersion: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(), version: 1,
      };
      const assignment: TokenProfileAssignment = {
        id: randomUUID() as TokenProfileAssignment['id'], clientTokenId, profileId: profile.id,
        schemaVersion: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(), version: 1,
      };
      await this.#state.mutate({ type: 'records.batch', operations: [
        upsert('clientTokens', clientTokenId, agent),
        upsert('tokenProfileAssignments', assignment.id, assignment),
        upsert('oauthGrants', grantId, grant),
        upsert('oauthCodes', hash(code), codeRecord),
        upsert('oauthRequests', id, { ...request, status: 'approved', decidedByAdminId: adminId, decidedAt: now.toISOString() }),
      ] });
      return redirectWith(request.redirectUri, { code, state: request.state, iss: request.issuer ?? this.issuer });
    });
  }

  async deny(id: string, adminId: string): Promise<string> {
    return this.#serialize(async () => {
      const request = this.#state.read((state) => record<OAuthRequest>(state.oauthRequests[id]));
      if (request === undefined || request.status !== 'pending' || request.expiresAt <= this.#now().toISOString()) {
        throw new OAuthError('invalid_request', 404);
      }
      await this.#state.mutate(upsert('oauthRequests', id, {
        ...request, status: 'denied', decidedByAdminId: adminId, decidedAt: this.#now().toISOString(),
      }));
      return redirectWith(request.redirectUri, { error: 'access_denied', state: request.state, iss: request.issuer ?? this.issuer });
    });
  }

  #activeGrant(id: string): OAuthGrant | undefined {
    return this.#state.read((state) => {
      const grant = record<OAuthGrant>(state.oauthGrants[id]);
      if (grant === undefined || grant.revokedAt !== undefined || grant.expiresAt <= this.#now().toISOString()) return undefined;
      const agent = record<ClientTokenRecord>(state.clientTokens[grant.clientTokenId]);
      const profile = record<Profile>(state.profiles[grant.profileId]);
      const assignments = Object.values(state.tokenProfileAssignments)
        .map((value) => value as unknown as TokenProfileAssignment)
        .filter((item) => item.clientTokenId === grant.clientTokenId);
      return agent?.authKind === 'oauth' && agent.deletedAt === undefined && agent.revokedAt === undefined &&
        profile?.version === grant.profileVersion && assignments.length === 1 &&
        assignments[0]?.profileId === grant.profileId ? grant : undefined;
    });
  }

  async #issue(grant: OAuthGrant, extraOperations: StateOperation[]): Promise<{
    access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token?: string; scope: string;
  }> {
    const remainingMs = new Date(grant.expiresAt).getTime() - this.#now().getTime();
    if (remainingMs <= 0) throw new OAuthError('invalid_grant');
    const accessToken = `amcpoa_${randomBytes(32).toString('base64url')}`;
    const accessLifetimeMs = Math.min(ACCESS_LIFETIME_MS, remainingMs);
    const access: OAuthToken = {
      grantId: grant.id, kind: 'access',
      expiresAt: new Date(this.#now().getTime() + accessLifetimeMs).toISOString(),
    };
    const operations = [...extraOperations, upsert('oauthTokens', hash(accessToken), access)];
    let refreshToken: string | undefined;
    if (remainingMs > ACCESS_LIFETIME_MS) {
      refreshToken = `amcpor_${randomBytes(32).toString('base64url')}`;
      operations.push(upsert('oauthTokens', hash(refreshToken), {
        grantId: grant.id, kind: 'refresh', expiresAt: grant.expiresAt,
      } satisfies OAuthToken));
    }
    await this.#state.mutate({ type: 'records.batch', operations });
    return {
      access_token: accessToken, token_type: 'Bearer',
      expires_in: Math.max(1, Math.floor(accessLifetimeMs / 1000)),
      ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
      scope: 'mcp:access',
    };
  }

  async exchangeCode(input: { code: string; clientId: string; redirectUri: string; resource: string; codeVerifier: string; issuer?: string }) {
    return this.#serialize(async () => {
      const key = hash(input.code);
      const code = this.#state.read((state) => record<OAuthCode>(state.oauthCodes[key]));
      if (code === undefined || code.expiresAt <= this.#now().toISOString() || code.clientId !== input.clientId ||
        code.redirectUri !== input.redirectUri || code.resource !== input.resource ||
        (code.issuer ?? this.issuer) !== (input.issuer ?? this.issuer) ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) throw new OAuthError('invalid_grant');
      const challenge = createHash('sha256').update(input.codeVerifier).digest('base64url');
      if (!timingSafeEqual(Buffer.from(challenge), Buffer.from(code.codeChallenge))) throw new OAuthError('invalid_grant');
      const grant = this.#activeGrant(code.grantId);
      if (grant === undefined) throw new OAuthError('invalid_grant');
      return this.#issue(grant, [{ type: 'record.deleted', collection: 'oauthCodes', id: key }]);
    });
  }

  async refresh(input: { refreshToken: string; clientId: string; resource: string; issuer?: string }) {
    return this.#serialize(async () => {
      const key = hash(input.refreshToken);
      const token = this.#state.read((state) => record<OAuthToken>(state.oauthTokens[key]));
      if (token === undefined || token.kind !== 'refresh') {
        // Unknown tokens are unauthenticated input; do not allow them to flood diagnostics.
        throw new OAuthError('invalid_grant');
      }
      const grant = this.#activeGrant(token.grantId);
      if (grant === undefined) {
        const stored = this.#state.read((state) => record<OAuthGrant>(state.oauthGrants[token.grantId]));
        this.#reportRefresh({
          outcome: 'rejected',
          reason: stored !== undefined && stored.expiresAt <= this.#now().toISOString()
            ? 'grant_expired' : 'grant_inactive',
          grantId: token.grantId,
          ...(stored === undefined ? {} : { agentId: stored.clientTokenId }),
        });
        throw new OAuthError('invalid_grant');
      }
      const identity = { grantId: grant.id, agentId: grant.clientTokenId };
      if (grant.clientId !== input.clientId ||
        (grant.issuer ?? this.issuer) !== (input.issuer ?? this.issuer) ||
        input.resource !== (grant.resource ?? this.resource)) {
        this.#reportRefresh({ outcome: 'rejected', reason: 'binding_mismatch', ...identity });
        throw new OAuthError('invalid_grant');
      }
      if (token.expiresAt <= this.#now().toISOString()) {
        this.#reportRefresh({ outcome: 'rejected', reason: 'token_expired', ...identity });
        throw new OAuthError('invalid_grant');
      }
      if (token.usedAt !== undefined) {
        await this.#state.mutate(upsert('oauthGrants', grant.id, { ...grant, revokedAt: this.#now().toISOString() }));
        this.#reportRefresh({ outcome: 'rejected', reason: 'replay_detected', ...identity });
        throw new OAuthError('invalid_grant');
      }
      const issued = await this.#issue(grant, [upsert('oauthTokens', key, { ...token, usedAt: this.#now().toISOString() })]);
      this.#reportRefresh({ outcome: 'issued', ...identity, grantExpiresAt: grant.expiresAt });
      return issued;
    });
  }

  authenticate(accessToken: string, resourceOrigin = this.issuer): ClientTokenId | undefined {
    if (!/^amcpoa_[A-Za-z0-9_-]{43}$/.test(accessToken)) return undefined;
    const token = this.#state.read((state) => record<OAuthToken>(state.oauthTokens[hash(accessToken)]));
    if (token?.kind !== 'access' || token.expiresAt <= this.#now().toISOString()) return undefined;
    const grant = this.#activeGrant(token.grantId);
    return grant !== undefined && (grant.resource ?? this.resource) === `${resourceOrigin}/mcp`
      ? grant.clientTokenId : undefined;
  }
}
