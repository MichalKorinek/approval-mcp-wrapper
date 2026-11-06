// Explicit synthetic demo/CI inputs, NOT a production catalog or startup hook.
export const SAMPLE_PLUGIN_REPOSITORIES = [
  'your-mail-mcp', 'geo', 'imcp', 'krkonoskewellness', 'minutes', 'whatsapp-mcp',
].map((name) => `https://github.com/jiridudekusy/approval-mcp-plugin-${name}`);

export async function addSamplePlugins(manager) {
  for (const repository of SAMPLE_PLUGIN_REPOSITORIES) {
    if (manager.list().some((item) => item.repository === repository)) continue;
    const preview = await manager.preview(repository, 'isolated-fixture');
    await manager.add(preview.previewId, 'isolated-fixture');
  }
}
