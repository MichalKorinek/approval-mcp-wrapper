import { open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { CallEvent } from './call-event.js';
import type { StorageCodec } from '@approval-mcp/contracts';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

export interface SegmentIndexRecord {
  offset: number;
  length: number;
  callId: string;
  timestamp: string;
  clientTokenId: string;
  upstreamId: string;
  toolName: string;
  policyOutcome?: CallEvent['policyOutcome'];
  approvalStatus?: string;
  finalStatus?: CallEvent['finalStatus'];
}

export function indexRecord(event: CallEvent, offset: number, length: number): SegmentIndexRecord {
  return {
    offset,
    length,
    callId: event.callId,
    timestamp: event.timestamp,
    clientTokenId: event.clientTokenId,
    upstreamId: event.upstreamId,
    toolName: event.toolName,
    ...(event.policyOutcome === undefined ? {} : { policyOutcome: event.policyOutcome }),
    ...(event.approvalStatus === undefined ? {} : { approvalStatus: event.approvalStatus }),
    ...(event.finalStatus === undefined ? {} : { finalStatus: event.finalStatus }),
  };
}

export async function rebuildSegmentIndex(segmentPath: string, indexPath: string, codec?: StorageCodec): Promise<void> {
  const raw = await readFile(segmentPath);
  const source = segmentPath.endsWith('.gz') ? await promisify(gunzip)(raw) : raw;
  const records: string[] = [];
  let offset = 0;

  for (const lineWithNewline of source.toString('utf8').match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const line = lineWithNewline.endsWith('\n')
      ? lineWithNewline.slice(0, -1)
      : lineWithNewline;
    const length = Buffer.byteLength(lineWithNewline);
    if (line.length > 0) {
      try {
        const event = JSON.parse(codec?.decode(`calls/${basename(segmentPath).replace(/\.gz$/, '')}`, line) ?? line) as CallEvent;
        const record = JSON.stringify(indexRecord(event, offset, length));
        records.push(codec?.encode(`calls/${basename(indexPath)}`, record) ?? record);
      } catch {
        if (codec !== undefined || offset + length !== source.length) {
          throw new Error(`Invalid non-terminal JSONL record at byte ${offset}`);
        }
      }
    }
    offset += length;
  }

  const temporaryPath = join(dirname(indexPath), `.${randomUUID()}.index.tmp`);
  const file = await open(temporaryPath, 'wx', 0o600);
  try {
    await file.writeFile(records.length === 0 ? '' : `${records.join('\n')}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporaryPath, indexPath);
  const directory = await open(dirname(indexPath), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
