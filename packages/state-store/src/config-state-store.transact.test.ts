import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createConfigStateStore } from './config-state-store.js';
import { createNodeFileOperations, type StateStoreFileOperations } from './file-operations.js';

/** File operations whose durable append can be held, to keep a write in flight. */
function gatedFiles() {
  const node = createNodeFileOperations();
  let gate: Promise<void> | undefined;
  let release = () => {};
  const files: StateStoreFileOperations = {
    ...node,
    appendDurable: async (path, contents) => {
      if (gate !== undefined) await gate;
      await node.appendDurable(path, contents);
    },
  };
  return {
    files,
    hold: () => { gate = new Promise((resolve) => { release = resolve; }); },
    release: () => { gate = undefined; release(); },
  };
}

describe('ConfigStateStore.transact', () => {
  it('decides against writes that are queued but not yet durable', async () => {
    const io = gatedFiles();
    const store = await createConfigStateStore(await mkdtemp(join(tmpdir(), 'state-transact-')), io.files);
    io.hold();
    const write = store.mutate({ type: 'record.upserted', collection: 'settings', id: 'a', value: 1 });
    expect(store.read((state) => state.settings['a'])).toBeUndefined();
    const seen = store.transact((state) => ({ result: state.settings['a'] }));
    io.release();
    await write;
    await expect(seen).resolves.toBe(1);
  });

  it('writes the event it returns and returns its result', async () => {
    const store = await createConfigStateStore(await mkdtemp(join(tmpdir(), 'state-transact-')));
    const result = await store.transact(() => ({
      event: { type: 'record.upserted', collection: 'settings', id: 'b', value: 2 },
      result: 'written',
    }));
    expect(result).toBe('written');
    expect(store.read((state) => state.settings['b'])).toBe(2);
  });

  it('writes nothing when decide throws and keeps the queue usable', async () => {
    const store = await createConfigStateStore(await mkdtemp(join(tmpdir(), 'state-transact-')));
    await expect(store.transact(() => { throw new Error('rejected'); })).rejects.toThrow('rejected');
    await store.mutate({ type: 'record.upserted', collection: 'settings', id: 'c', value: 3 });
    expect(store.read((state) => state.settings['c'])).toBe(3);
  });
});
