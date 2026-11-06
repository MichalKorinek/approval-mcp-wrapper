import type { PluginSource } from './plugin-source.js';

// Migration only. These are NOT a catalog and are NEVER automatically installed.
// Old records did not store their source repository, so upgrades need this map.
export const LEGACY_PLUGIN_SOURCES: readonly PluginSource[] = [
  ['email', 'your-mail-mcp', '7fee27f847e3e77afbce8e5c9b5d463f17990de2', 'your-mail-mcp'],
  ['geo', 'Geo / Dawarich', '2f9ca6e3d347314eb894f41af11acca7cb351a11'],
  ['imcp', 'iMCP', 'ca186e9bdef0e4b9e9e1292029c2bdfcc85465f9'],
  ['krkonoskewellness', 'Krkonoše Wellness', 'eb8aed8af7737c7137b3725f060887e7e98c5f87'],
  ['minutes', 'Minutes', '226a784a9111edce892ab550b6cdd9bd1531c3e5'],
  ['whatsapp', 'whatsapp-mcp', 'ad8f3e2d5e296a64b735699d0a4fba5588a31d8e', 'whatsapp-mcp'],
].map(([id, name, revision, repositoryName]) => ({
  id: id!, name: name!, revision: revision!,
  repository: `jiridudekusy/approval-mcp-plugin-${repositoryName ?? id}`,
}));
