import type {
  ApprovalPlugin,
  PluginCallDescription,
  PluginCallInput,
} from './contracts.js';
import { createGenericDescription } from './generic-plugin.js';
import { validatePluginDescription } from './validate-output.js';

export interface PluginPin {
  id: string;
  version: string;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, ApprovalPlugin>();

  public constructor(plugins: readonly ApprovalPlugin[]) {
    this.replace(plugins);
  }

  /** Swap a validated set atomically; in-flight descriptions keep their instance. */
  public replace(plugins: readonly ApprovalPlugin[]): void {
    const next = new Map<string, ApprovalPlugin>();
    for (const plugin of plugins) {
      const key = this.key({ id: plugin.id, version: plugin.version });
      if (next.has(key)) {
        throw new Error(`Duplicate plugin registration: ${key}`);
      }
      next.set(key, plugin);
    }
    this.plugins.clear();
    for (const [key, plugin] of next) this.plugins.set(key, plugin);
  }

  public async describe(
    pin: PluginPin,
    input: PluginCallInput,
  ): Promise<PluginCallDescription> {
    const plugin = this.plugins.get(this.key(pin));
    if (plugin === undefined) {
      return createGenericDescription(input, 'plugin.not_found');
    }
    try {
      const description = validatePluginDescription(await plugin.describe(input));
      return {
        ...description,
        source: 'plugin',
      };
    } catch {
      return createGenericDescription(input, 'plugin.failed');
    }
  }

  public normalizationVersion(pin: PluginPin): number {
    return this.plugins.get(this.key(pin))?.normalizationVersion ?? 1;
  }

  public list(): readonly Readonly<{
    id: string;
    version: string;
    normalizationVersion: number;
  }>[] {
    return [...this.plugins.values()]
      .map((plugin) => ({
        id: plugin.id,
        version: plugin.version,
        normalizationVersion: plugin.normalizationVersion,
      }))
      .sort((left, right) =>
        `${left.id}@${left.version}`.localeCompare(
          `${right.id}@${right.version}`,
        ),
      );
  }

  private key(pin: PluginPin): string {
    return `${pin.id}@${pin.version}`;
  }
}
