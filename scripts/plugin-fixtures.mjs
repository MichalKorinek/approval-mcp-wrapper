// Explicit synthetic demo/CI inputs, NOT a production catalog or startup hook.
export const SAMPLE_PLUGIN_REPOSITORIES = [
  'your-mail-mcp', 'geo', 'imcp', 'krkonoskewellness', 'minutes', 'whatsapp-mcp',
].map((name) => `https://github.com/jiridudekusy/approval-mcp-plugin-${name}`);

// CI runners can share GitHub's small anonymous API quota. Authenticate only
// fixture metadata requests, never requests for downloaded plugin code.
export function createFixtureFetch({ token = process.env.GITHUB_TOKEN, fetcher = globalThis.fetch } = {}) {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    if (token && url.origin === 'https://api.github.com') headers.set('authorization', `Bearer ${token}`);
    const response = await fetcher(input, { ...init, headers, redirect: 'error' });
    if (!response.ok) {
      throw new Error(`Plugin fixture download failed: HTTP ${response.status} from ${url.origin}; GitHub quota remaining: ${response.headers.get('x-ratelimit-remaining') ?? 'unknown'}`);
    }
    return response;
  };
}

export async function addSamplePlugins(manager) {
  for (const repository of SAMPLE_PLUGIN_REPOSITORIES) {
    if (manager.list().some((item) => item.repository === repository)) continue;
    const preview = await manager.preview(repository, 'isolated-fixture');
    await manager.add(preview.previewId, 'isolated-fixture');
  }
}
