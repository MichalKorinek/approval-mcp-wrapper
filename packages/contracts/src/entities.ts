import type {
  AdminId,
  ApprovalId,
  CallId,
  ClientTokenId,
  GrantId,
  PolicyId,
  ProfileId,
  ProfileRuleId,
  TokenProfileAssignmentId,
  UpstreamId,
} from './ids.js';
import type { GrantPresentation } from './presentation.js';

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface VersionedRecord {
  id: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface EncryptedCredentialEnvelope {
  algorithm: 'aes-256-gcm';
  ciphertext: string;
  nonce: string;
  tag: string;
  version: 1;
}

export interface Upstream extends VersionedRecord {
  id: UpstreamId;
  alias: string;
  displayName?: string;
  description?: string;
  metadata?: Record<string, string>;
  url: string;
  credentials?: EncryptedCredentialEnvelope;
  pluginId?: string;
  pluginVersion?: string;
  allowPrivateNetwork: boolean;
  /** Source name of the declarative setup request that last created or changed this upstream. */
  managedBy?: string;
}

export interface ClientTokenRecord extends VersionedRecord {
  id: ClientTokenId;
  label: string;
  authKind?: 'oauth';
  expiresAt?: string;
  canManageApprovalMcp?: boolean;
  hash: string;
  salt: string;
  revokedAt?: string;
  deletedAt?: string;
  lastUsedAt?: string;
}

export type PolicyOutcome = 'allow' | 'deny' | 'require_approval';
export type PredicateOperator = 'equals' | 'exists' | 'in' | 'startsWith';

export interface Predicate {
  path: string;
  operator: PredicateOperator;
  value?: JsonValue;
}

export interface Policy extends VersionedRecord {
  id: PolicyId;
  clientTokenId: ClientTokenId;
  upstreamId: UpstreamId;
  toolName: string;
  outcome: PolicyOutcome;
  predicates: Predicate[];
  enabled: boolean;
}

export const DEFAULT_TOOL_CALL_TIMEOUT_SECONDS = 60;
export const MIN_TOOL_CALL_TIMEOUT_SECONDS = 1;
export const MAX_TOOL_CALL_TIMEOUT_SECONDS = 24 * 60 * 60;
export const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 60;
export const MIN_APPROVAL_TIMEOUT_SECONDS = 1;
export const MAX_APPROVAL_TIMEOUT_SECONDS = 24 * 60 * 60;

export interface Profile extends VersionedRecord {
  id: ProfileId;
  name: string;
  isDefault: boolean;
  approvalTimeoutSeconds: number;
  toolCallTimeoutSeconds: number;
}

export interface ProfileRule extends VersionedRecord {
  id: ProfileRuleId;
  profileId: ProfileId;
  upstreamId: UpstreamId;
  toolName?: string;
  outcome: PolicyOutcome;
  predicates: Predicate[];
  enabled: boolean;
}

export interface TokenProfileAssignment extends VersionedRecord {
  id: TokenProfileAssignmentId;
  clientTokenId: ClientTokenId;
  profileId: ProfileId;
}

export interface Grant extends VersionedRecord {
  id: GrantId;
  clientTokenId: ClientTokenId;
  upstreamId: UpstreamId;
  toolName: string;
  predicates: Predicate[];
  requestHash?: string;
  callId?: CallId;
  expiresAt?: string;
  revokedAt?: string;
  normalizationVersion: number;
  approvedBy: AdminId;
  presentation?: GrantPresentation;
}

export type ApprovalStatus =
  | 'abandoned'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'interrupted'
  | 'pending';

export interface Approval extends VersionedRecord {
  id: ApprovalId;
  callId: CallId;
  requestHash: string;
  status: ApprovalStatus;
  reasonCode: string;
  denialReason?: string;
  decidedAt?: string;
  decidedBy?: AdminId;
}
