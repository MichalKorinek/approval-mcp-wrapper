import type { ClientTokenId, UpstreamId } from '@approval-mcp/contracts';
import type { McpTool } from '@approval-mcp/upstream';

import { safePublicToolName } from './tool-name.js';

export interface CatalogSourceTool {
  upstreamId: UpstreamId;
  upstreamAlias: string;
  tool: McpTool;
}

export interface PublicTool extends McpTool {
  name: string;
  upstreamId: UpstreamId;
  upstreamToolName: string;
}

export type TokenVisibility = ReadonlyMap<
  ClientTokenId,
  ReadonlySet<string>
>;

export function withPolicyDescription(
  tool: McpTool,
  policy: {
    approvalMayBeRequired: boolean;
    approvalTimeoutSeconds: number;
    toolCallTimeoutSeconds: number;
  },
): McpTool {
  const approval = policy.approvalMayBeRequired
    ? `human approval may be required (approval wait limit ${policy.approvalTimeoutSeconds} seconds)`
    : `human approval is not normally required (configured approval wait limit ${policy.approvalTimeoutSeconds} seconds)`;
  const notice = `Approval MCP: ${approval}; tool execution limit ${policy.toolCallTimeoutSeconds} seconds. Call approval_mcp__inspect_tool with the intended arguments for the exact current decision.`;
  return {
    ...tool,
    description: tool.description?.trim()
      ? `${tool.description.trim()}\n\n${notice}`
      : notice,
  };
}

export function buildTokenCatalog(
  tokenId: ClientTokenId,
  sourceTools: readonly CatalogSourceTool[],
  visibility: TokenVisibility,
): readonly PublicTool[] {
  const visible = visibility.get(tokenId) ?? new Set<string>();
  // A stored upstream with an invalid alias, or tools that would share a public
  // name, must not take the catalog of the other upstreams down. They are left
  // out, never exposed under a substitute name, and so cannot be called either.
  const counts = new Map<string, number>();
  for (const source of sourceTools) {
    const name = safePublicToolName(source.upstreamAlias, source.tool.name);
    if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const catalog: PublicTool[] = [];
  for (const source of sourceTools) {
    const name = safePublicToolName(source.upstreamAlias, source.tool.name);
    if (name === undefined || counts.get(name) !== 1) continue;
    if (!visible.has(name)) continue;
    catalog.push({
      ...source.tool,
      name,
      upstreamId: source.upstreamId,
      upstreamToolName: source.tool.name,
    });
  }
  return catalog.sort((left, right) => left.name.localeCompare(right.name));
}
