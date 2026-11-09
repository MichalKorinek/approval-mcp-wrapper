/** Validation shared by the admin upstream routes and declarative setup. */
export const MAX_DISPLAY_NAME_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_METADATA_ENTRIES = 20;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_VALUE_LENGTH = 500;
const METADATA_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const FORBIDDEN_METADATA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const invalidInput = Symbol('invalidInput');

export function optionalText(value: unknown, maxLength: number) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return invalidInput;
  const normalized = value.trim();
  if (normalized.length > maxLength) return invalidInput;
  return normalized === '' ? undefined : normalized;
}

export function upstreamMetadata(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return invalidInput;
  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_ENTRIES) return invalidInput;
  const metadata: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim();
    if (
      typeof rawValue !== 'string' ||
      key.length === 0 ||
      key.length > MAX_METADATA_KEY_LENGTH ||
      !METADATA_KEY_PATTERN.test(key) ||
      FORBIDDEN_METADATA_KEYS.has(key) ||
      rawValue.length > MAX_METADATA_VALUE_LENGTH ||
      Object.hasOwn(metadata, key)
    ) {
      return invalidInput;
    }
    metadata[key] = rawValue.trim();
  }
  return entries.length === 0 ? undefined : metadata;
}
