const ALIAS_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

/**
 * The one alias rule for every path that stores or exposes an upstream: lowercase
 * letters, digits, hyphens and underscores, at most 64 characters, starting and
 * ending with a letter or digit, and no `__`, which separates alias and tool name.
 */
export function isValidUpstreamAlias(alias: string): boolean {
  return ALIAS_PATTERN.test(alias) && !alias.includes('__');
}

export function assertValidUpstreamAlias(alias: string): void {
  if (!isValidUpstreamAlias(alias)) {
    throw new Error(
      'Upstream alias must be lowercase, unambiguous, and contain only letters, digits, hyphens, or underscores',
    );
  }
}

function isValidToolName(toolName: string): boolean {
  return toolName.length > 0 && !toolName.includes('\0');
}

export function publicToolName(alias: string, toolName: string): string {
  assertValidUpstreamAlias(alias);
  if (!isValidToolName(toolName)) {
    throw new Error('Upstream tool name is invalid');
  }
  return `${alias}__${toolName}`;
}

/** The public name, or `undefined` when the alias or tool name cannot form one. */
export function safePublicToolName(alias: string, toolName: string): string | undefined {
  return isValidUpstreamAlias(alias) && isValidToolName(toolName)
    ? `${alias}__${toolName}`
    : undefined;
}
