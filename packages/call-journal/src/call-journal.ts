import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

import type {
  CallEvent,
  CallDisplayNameResolver,
  CallFilter,
  CallPage,
  CallSummary,
  CallTimeline,
  JournalRecovery,
  RetentionResult,
} from './call-event.js';
import { appendDurable } from './segment-writer.js';
import { indexRecord } from './segment-index.js';
import type { StorageCodec } from '@approval-mcp/contracts';

export interface CallJournal {
  readonly recovery: JournalRecovery;
  append(event: CallEvent): Promise<void>;
  compressClosedSegments(now: Date): Promise<string[]>;
  query(filter: CallFilter, cursor?: string): Promise<CallPage>;
  get(callId: string): Promise<CallTimeline | undefined>;
  export(
    filter: CallFilter,
    format: 'jsonl' | 'csv',
    displayNames?: CallDisplayNameResolver,
  ): AsyncIterable<Uint8Array>;
  enforceRetention(now: Date, retentionDays: number): Promise<RetentionResult>;
}

export type CallEventAppendedListener = (event: CallEvent) => void;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

interface CursorPayload {
  version: 2;
  firstSeenAt: string;
  callId: string;
  scope: string;
}

function segmentName(timestamp: string): string {
  const date = timestamp.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Call timestamp is not an ISO UTC timestamp: ${timestamp}`);
  }
  return `calls-${date}.jsonl`;
}

function cursorChecksum(value: string): string {
  return createHash('sha256').update(`approval-mcp-cursor:${value}`).digest('hex').slice(0, 16);
}

function encodeCursor(payload: CursorPayload): string {
  const value = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${value}.${cursorChecksum(value)}`;
}

function cursorScope(filter: CallFilter): string {
  const values = [
    filter.from, filter.to, filter.clientTokenId, filter.upstreamId,
    filter.toolName, filter.policyOutcome, filter.approvalStatus, filter.finalStatus,
  ];
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 16);
}

function decodeCursor(cursor: string | undefined, scope: string): CursorPayload | undefined {
  if (cursor === undefined) return undefined;
  if (cursor.length > 2048) throw new Error('Invalid history cursor');
  const [value, checksum] = cursor.split('.');
  if (value === undefined || checksum !== cursorChecksum(value)) {
    throw new Error('Invalid history cursor');
  }
  let parsed: Partial<CursorPayload>;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<CursorPayload>;
  } catch {
    throw new Error('Invalid history cursor');
  }
  if (parsed === null || typeof parsed !== 'object' ||
    parsed.version !== 2 || parsed.scope !== scope ||
    typeof parsed.firstSeenAt !== 'string' || !Number.isFinite(Date.parse(parsed.firstSeenAt)) ||
    typeof parsed.callId !== 'string' || parsed.callId.length === 0 || parsed.callId.length > 256) {
    throw new Error('Invalid history cursor');
  }
  return parsed as CursorPayload;
}

function matches(event: CallEvent, filter: CallFilter): boolean {
  return (
    (filter.from === undefined || event.timestamp >= filter.from) &&
    (filter.to === undefined || event.timestamp <= filter.to) &&
    (filter.clientTokenId === undefined || event.clientTokenId === filter.clientTokenId) &&
    (filter.upstreamId === undefined || event.upstreamId === filter.upstreamId) &&
    (filter.toolName === undefined || event.toolName === filter.toolName) &&
    (filter.policyOutcome === undefined || event.policyOutcome === filter.policyOutcome) &&
    (filter.approvalStatus === undefined || event.approvalStatus === filter.approvalStatus) &&
    (filter.finalStatus === undefined || event.finalStatus === filter.finalStatus)
  );
}

function summarize(events: CallEvent[]): CallSummary {
  const first = events[0];
  const last = events.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error('Cannot summarize an empty call');
  }
  const summary: CallSummary = {
    callId: first.callId,
    firstSeenAt: first.timestamp,
    lastSeenAt: last.timestamp,
    clientTokenId: first.clientTokenId,
    upstreamId: first.upstreamId,
    toolName: first.toolName,
    ...(first.presentation === undefined
      ? {}
      : {
          presentation: {
            source: first.presentation.source,
            ...(first.presentation.pluginId === undefined
              ? {}
              : { pluginId: first.presentation.pluginId }),
            ...(first.presentation.pluginVersion === undefined
              ? {}
              : { pluginVersion: first.presentation.pluginVersion }),
            title: structuredClone(first.presentation.title),
          },
        }),
  };
  for (const event of events) {
    if (event.policyOutcome !== undefined) {
      summary.policyOutcome = event.policyOutcome;
    }
    if (event.approvalStatus !== undefined) {
      summary.approvalStatus = event.approvalStatus;
    }
    if (event.finalStatus !== undefined) {
      summary.finalStatus = event.finalStatus;
    }
    if (event.denialReason !== undefined) {
      summary.denialReason = event.denialReason;
    }
  }
  return summary;
}

class FileCallJournal implements CallJournal {
  public readonly recovery: JournalRecovery = { truncatedLines: 0 };

  public constructor(
    private readonly dataDir: string,
    private readonly onEventAppended?: CallEventAppendedListener,
    private readonly codec?: StorageCodec,
  ) {}

  public async load(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    for (const path of await this.segmentPaths()) {
      await this.readEvents(path, true);
    }
  }

  public async append(event: CallEvent): Promise<void> {
    const path = join(this.dataDir, segmentName(event.timestamp));
    const serialized = `${this.codec?.encode(`calls/${basename(path)}`, JSON.stringify(event)) ?? JSON.stringify(event)}\n`;
    const offset = await appendDurable(path, serialized);
    const indexPath = path.replace(/\.jsonl$/, '.index.jsonl');
    const record = indexRecord(event, offset, Buffer.byteLength(serialized));
    await appendDurable(indexPath, `${this.codec?.encode(`calls/${basename(indexPath)}`, JSON.stringify(record)) ?? JSON.stringify(record)}\n`);
    this.onEventAppended?.(structuredClone(event));
  }

  public async compressClosedSegments(now: Date): Promise<string[]> {
    const activeDate = now.toISOString().slice(0, 10);
    const compressed: string[] = [];
    for (const path of await this.segmentPaths()) {
      if (path.endsWith('.gz')) {
        continue;
      }
      const date = basename(path).slice('calls-'.length, 'calls-'.length + 10);
      if (date >= activeDate) {
        continue;
      }
      const destination = `${path}.gz`;
      const temporaryPath = join(dirname(path), `.${randomUUID()}.jsonl.gz.tmp`);
      const source = await readFile(path);
      const contents = await gzipAsync(source);
      const file = await open(temporaryPath, 'wx', 0o600);
      try {
        await file.writeFile(contents);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, destination);
      await rm(path);
      compressed.push(basename(destination));
    }
    return compressed;
  }

  public async query(filter: CallFilter, cursor?: string): Promise<CallPage> {
    const timelines = await this.timelines(filter);
    const summaries = [...timelines.values()]
      .map(summarize)
      .sort((left, right) =>
        right.firstSeenAt.localeCompare(left.firstSeenAt) || right.callId.localeCompare(left.callId));
    const scope = cursorScope(filter);
    const anchor = decodeCursor(cursor, scope);
    const remaining = anchor === undefined ? summaries : summaries.filter((item) =>
      item.firstSeenAt < anchor.firstSeenAt ||
      (item.firstSeenAt === anchor.firstSeenAt && item.callId < anchor.callId));
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const items = remaining.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      ...(last !== undefined && items.length < remaining.length
        ? { nextCursor: encodeCursor({ version: 2, firstSeenAt: last.firstSeenAt, callId: last.callId, scope }) }
        : {}),
    };
  }

  public async get(callId: string): Promise<CallTimeline | undefined> {
    const events: CallEvent[] = [];
    for (const path of await this.segmentPaths()) {
      for (const event of await this.readEvents(path, false)) {
        if (event.callId === callId) {
          events.push(event);
        }
      }
    }
    events.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    return events.length === 0 ? undefined : { callId, events };
  }

  public async *export(
    filter: CallFilter,
    format: 'jsonl' | 'csv',
    displayNames?: CallDisplayNameResolver,
  ): AsyncIterable<Uint8Array> {
    const encoder = new TextEncoder();
    if (format === 'csv') {
      const columns = [
        'callId',
        'timestamp',
        'type',
        'clientTokenId',
        'upstreamId',
        'toolName',
        'payload',
        'presentation',
        'denialReason',
        ...(displayNames === undefined
          ? []
          : ['tokenLabel', 'upstreamAlias']),
      ];
      yield encoder.encode(`${columns.join(',')}\n`);
    }
    for (const path of await this.segmentPaths()) {
      for (const event of await this.readEvents(path, false)) {
        if (!matches(event, filter)) {
          continue;
        }
        if (format === 'jsonl') {
          yield encoder.encode(`${JSON.stringify({
            ...event,
            ...displayNames?.(event),
          })}\n`);
        } else {
          const names = displayNames?.(event);
          const cells = [
            event.callId,
            event.timestamp,
            event.type,
            event.clientTokenId,
            event.upstreamId,
            event.toolName,
            event.payload === undefined ? '' : JSON.stringify(event.payload),
            event.presentation === undefined
              ? ''
              : JSON.stringify(event.presentation),
            event.denialReason ?? '',
            ...(displayNames === undefined
              ? []
              : [names?.tokenLabel ?? '', names?.upstreamAlias ?? '']),
          ].map((cell) => `"${cell.replaceAll('"', '""')}"`);
          yield encoder.encode(`${cells.join(',')}\n`);
        }
      }
    }
  }

  public async enforceRetention(now: Date, retentionDays: number): Promise<RetentionResult> {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const activeDate = now.toISOString().slice(0, 10);
    const deletedFiles: string[] = [];
    let deletedBytes = 0;

    for (const path of await this.segmentPaths()) {
      const date = basename(path).slice('calls-'.length, 'calls-'.length + 10);
      if (date >= cutoff || date === activeDate) {
        continue;
      }
      const indexPath = path.replace(/\.jsonl(?:\.gz)?$/, '.index.jsonl');
      for (const candidate of [path, indexPath]) {
        try {
          deletedBytes += (await stat(candidate)).size;
          await rm(candidate);
          deletedFiles.push(basename(candidate));
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !('code' in error) ||
            (error as NodeJS.ErrnoException).code !== 'ENOENT'
          ) {
            throw error;
          }
        }
      }
    }
    return { deletedFiles, deletedBytes };
  }

  private async timelines(filter: CallFilter): Promise<Map<string, CallEvent[]>> {
    const timelines = new Map<string, CallEvent[]>();
    for (const path of await this.segmentPaths()) {
      for (const event of await this.readEvents(path, false)) {
        if (!matches(event, filter)) {
          continue;
        }
        const events = timelines.get(event.callId) ?? [];
        events.push(event);
        timelines.set(event.callId, events);
      }
    }
    return timelines;
  }

  private async segmentPaths(): Promise<string[]> {
    const names = await readdir(this.dataDir);
    return names
      .filter((name) => /^calls-\d{4}-\d{2}-\d{2}\.jsonl(?:\.gz)?$/.test(name))
      .sort()
      .map((name) => join(this.dataDir, name));
  }

  private async readEvents(path: string, trackRecovery: boolean): Promise<CallEvent[]> {
    const raw = await readFile(path);
    let source = path.endsWith('.gz')
      ? (await gunzipAsync(raw)).toString('utf8')
      : raw.toString('utf8');
    if (this.codec !== undefined) {
      const context = `calls/${basename(path).replace(/\.gz$/, '')}`;
      source = source.split('\n').map((line) => line === '' ? '' : this.codec!.decode(context, line)).join('\n');
    }
    const lines = source.split('\n');
    const events: CallEvent[] = [];
    for (const [index, line] of lines.entries()) {
      if (line.length === 0) {
        continue;
      }
      try {
        events.push(JSON.parse(line) as CallEvent);
      } catch (error) {
        const isFinalLine = index === lines.length - 1 && !source.endsWith('\n');
        if (isFinalLine) {
          if (trackRecovery) {
            this.recovery.truncatedLines += 1;
          }
          continue;
        }
        throw new Error(`Invalid call journal JSON on line ${index + 1} in ${basename(path)}`, {
          cause: error,
        });
      }
    }
    return events;
  }
}

export async function createCallJournal(
  dataDir: string,
  onEventAppended?: CallEventAppendedListener,
  codec?: StorageCodec,
): Promise<CallJournal> {
  const journal = new FileCallJournal(dataDir, onEventAppended, codec);
  await journal.load();
  return journal;
}
