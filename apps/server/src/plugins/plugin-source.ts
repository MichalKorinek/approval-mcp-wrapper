import { z } from 'zod';

export const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const pluginIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
  .refine((id) => id !== 'constructor' && id !== 'prototype');
export const manifestSchema = z.object({
  apiVersion: z.literal(1),
  id: pluginIdSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(1000),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
  normalizationVersion: z.number().int().positive(),
  entry: z.literal('plugin.mjs'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const installationSchema = manifestSchema.extend({
  revision: revisionSchema,
  installedAt: z.iso.datetime(),
});

/** Accept public GitHub repository URLs, never credentials or arbitrary hosts. */
export function parsePluginRepository(value: unknown): string {
  if (typeof value !== 'string' || value.length > 250) throw new Error('Invalid repository');
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || url.search || url.hash) {
    throw new Error('Use a clean HTTPS GitHub repository URL');
  }
  const match = /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})\/?$/.exec(url.pathname);
  if (match === null || value.includes('%') || /\/\.{1,2}(?:\/|$)/.test(value)) throw new Error('Invalid repository path');
  const repository = match[2]!.replace(/\.git$/i, '');
  if (repository === '' || repository === '.' || repository === '..') throw new Error('Invalid repository name');
  return `${match[1]}/${repository}`.toLowerCase();
}

export const pluginRecordSchema = z.object({
  schemaVersion: z.literal(2),
  id: pluginIdSchema,
  name: z.string().min(1).max(120),
  repository: z.string().refine((value) => {
    try { return parsePluginRepository(`https://github.com/${value}`) === value; }
    catch { return false; }
  }),
  revision: revisionSchema,
  enabled: z.boolean(),
  // Compatibility only: older images expect this field for known plugin IDs.
  // No installation decision in this version uses this retired flag.
  autoInstall: z.literal(false).default(false),
  installations: z.array(installationSchema).max(50),
});

export type PluginRecord = z.infer<typeof pluginRecordSchema>;
export type Installation = z.infer<typeof installationSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export interface PluginSource { id: string; name: string; repository: string; revision: string }
