import { describe, expect, it, vi } from 'vitest';

import {
  ApprovalEventBroker,
  HistoryEventBroker,
} from './sse-broker.js';

describe('ApprovalEventBroker', () => {
  it('does not replay old events to a new connection, but delivers new events', () => {
    const broker = new ApprovalEventBroker(10);
    broker.publish({ approvalId: 'old', status: 'approved' });
    const listener = vi.fn();

    const subscription = broker.subscribe(undefined, listener);
    expect(listener).not.toHaveBeenCalled();

    const next = broker.publish({ approvalId: 'new', status: 'pending' });
    expect(listener).toHaveBeenCalledExactlyOnceWith(next);
    subscription.close();
  });

  it('replays events after Last-Event-ID and cleans up subscribers', () => {
    const broker = new ApprovalEventBroker(10);
    broker.publish({ approvalId: 'a1', status: 'pending' });
    const second = broker.publish({ approvalId: 'a2', status: 'pending' });
    const listener = vi.fn();

    const subscription = broker.subscribe('1', listener);
    expect(listener).toHaveBeenCalledWith(second);
    expect(broker.subscriberCount).toBe(1);

    subscription.close();
    expect(broker.subscriberCount).toBe(0);
  });
});

describe('HistoryEventBroker', () => {
  it('replays events after Last-Event-ID and cleans up subscribers', () => {
    const broker = new HistoryEventBroker(10);
    broker.publish({
      callId: 'c1',
      timestamp: '2026-08-10T10:00:00.000Z',
      type: 'call.received',
    });
    const second = broker.publish({
      callId: 'c1',
      timestamp: '2026-08-10T10:00:01.000Z',
      type: 'policy.decided',
    });
    const listener = vi.fn();

    const subscription = broker.subscribe('1', listener);
    expect(listener).toHaveBeenCalledWith(second);
    expect(broker.subscriberCount).toBe(1);

    subscription.close();
    expect(broker.subscriberCount).toBe(0);
  });

  it('drops a broken subscriber without interrupting publishers', () => {
    const broker = new HistoryEventBroker();
    broker.subscribe(undefined, () => {
      throw new Error('connection closed');
    });

    expect(() => broker.publish({
      callId: 'c1',
      timestamp: '2026-08-10T10:00:00.000Z',
      type: 'call.received',
    })).not.toThrow();
    expect(broker.subscriberCount).toBe(0);
  });
});
