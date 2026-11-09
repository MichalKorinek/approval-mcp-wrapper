import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { StateCorruptionError } from '@approval-mcp/contracts';
import { z } from 'zod';

import {
  configStateSchema,
  createEmptyConfigState,
  reduceState,
  stateEventSchema,
  type ConfigState,
  type StateEvent,
} from './state-schema.js';
import {
  createNodeFileOperations,
  type StateStoreFileOperations,
} from './file-operations.js';

interface JournalRecord {
  sequence: number;
  event: StateEvent;
  checksum: string;
}

interface SnapshotRecord {
  schemaVersion: 1;
  sequence: number;
  state: ConfigState;
  checksum: string;
}

export interface ConfigStateStore {
  load(): Promise<Readonly<ConfigState>>;
  read<T>(select: (state: Readonly<ConfigState>) => T): T;
  mutate(event: StateEvent): Promise<Readonly<ConfigState>>;
  /**
   * Runs `decide` inside the mutation queue against the state left by every
   * earlier queued mutation, then durably writes the returned event, if any.
   * Nothing else can be written between the decision and the write, so checks
   * such as record versions belong in `decide`.
   */
  transact<T>(
    decide: (state: Readonly<ConfigState>) => { event?: StateEvent; result: T },
  ): Promise<T>;
  snapshot(): Promise<void>;
  close(): Promise<void>;
}

const journalRecordSchema = z.object({
  sequence: z.number().int().positive(),
  event: stateEventSchema,
  checksum: z.string().length(64),
});

const snapshotRecordSchema = z.object({
  schemaVersion: z.literal(1),
  sequence: z.number().int().nonnegative(),
  state: z.record(z.string(), z.unknown()),
  checksum: z.string().length(64),
});

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function verifyJournalRecord(value: unknown): JournalRecord {
  const parsed = journalRecordSchema.parse(value) as JournalRecord;
  const expected = checksum({ sequence: parsed.sequence, event: parsed.event });
  if (parsed.checksum !== expected) {
    throw new StateCorruptionError(`Journal checksum mismatch at sequence ${parsed.sequence}`);
  }
  return parsed;
}

function verifySnapshotRecord(value: unknown): SnapshotRecord {
  const parsed = snapshotRecordSchema.parse(value);
  const expected = checksum({
    schemaVersion: parsed.schemaVersion,
    sequence: parsed.sequence,
    state: parsed.state,
  });
  if (parsed.checksum !== expected) {
    throw new StateCorruptionError(`Snapshot checksum mismatch at sequence ${parsed.sequence}`);
  }
  return {
    ...parsed,
    state: configStateSchema.parse(parsed.state) as ConfigState,
  };
}

class FileConfigStateStore implements ConfigStateStore {
  private state: ConfigState = createEmptyConfigState();
  private sequence = 0;
  private mutationQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly dataDir: string,
    private readonly files: StateStoreFileOperations,
  ) {}

  public async load(): Promise<Readonly<ConfigState>> {
    await this.files.ensureDir(this.dataDir);
    const snapshotText = await this.files.readText(this.snapshotPath);

    if (snapshotText !== undefined) {
      const snapshot = verifySnapshotRecord(JSON.parse(snapshotText));
      this.state = snapshot.state;
      this.sequence = snapshot.sequence;
    }

    const journalText = await this.files.readText(this.journalPath);
    if (journalText === undefined || journalText.length === 0) {
      return this.state;
    }

    const lines = journalText.split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.length === 0) {
        continue;
      }
      try {
        const record = verifyJournalRecord(JSON.parse(line));
        if (record.sequence <= this.sequence) {
          continue;
        }
        if (record.sequence !== this.sequence + 1) {
          throw new StateCorruptionError(
            `Journal sequence gap: expected ${this.sequence + 1}, received ${record.sequence}`,
          );
        }
        this.state = reduceState(this.state, record.event);
        this.sequence = record.sequence;
      } catch (error) {
        if (error instanceof StateCorruptionError) {
          throw error;
        }
        throw new StateCorruptionError(`Invalid journal record on line ${index + 1}`, {
          cause: error,
        });
      }
    }
    return this.state;
  }

  public read<T>(select: (state: Readonly<ConfigState>) => T): T {
    return select(this.state);
  }

  public mutate(event: StateEvent): Promise<Readonly<ConfigState>> {
    return this.transact(() => ({ event, result: undefined })).then(() => this.state);
  }

  public transact<T>(
    decide: (state: Readonly<ConfigState>) => { event?: StateEvent; result: T },
  ): Promise<T> {
    const operation = this.mutationQueue.then(async () => {
      const { event, result } = decide(this.state);
      if (event !== undefined) await this.commit(event);
      return result;
    });
    this.mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async commit(event: StateEvent): Promise<void> {
    const parsedEvent = stateEventSchema.parse(event) as StateEvent;
    const nextState = reduceState(this.state, parsedEvent);
    const sequence = this.sequence + 1;
    const recordWithoutChecksum = { sequence, event: parsedEvent };
    const record: JournalRecord = {
      ...recordWithoutChecksum,
      checksum: checksum(recordWithoutChecksum),
    };
    await this.files.appendDurable(this.journalPath, `${JSON.stringify(record)}\n`);
    this.state = nextState;
    this.sequence = sequence;
  }

  public async snapshot(): Promise<void> {
    await this.enqueue(async () => {
      const withoutChecksum = {
        schemaVersion: 1 as const,
        sequence: this.sequence,
        state: this.state,
      };
      const snapshot: SnapshotRecord = {
        ...withoutChecksum,
        checksum: checksum(withoutChecksum),
      };
      await this.files.writeAtomic(this.snapshotPath, `${JSON.stringify(snapshot)}\n`);
    });
  }

  public async close(): Promise<void> {
    await this.snapshot();
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.mutationQueue.then(operation);
    this.mutationQueue = queued.catch(() => undefined);
    return queued;
  }

  private get journalPath(): string {
    return join(this.dataDir, 'state.journal.jsonl');
  }

  private get snapshotPath(): string {
    return join(this.dataDir, 'state.snapshot.json');
  }
}

export async function createConfigStateStore(
  dataDir: string,
  files: StateStoreFileOperations = createNodeFileOperations(),
): Promise<ConfigStateStore> {
  const store = new FileConfigStateStore(dataDir, files);
  await store.load();
  return store;
}

export { createNodeFileOperations } from './file-operations.js';
