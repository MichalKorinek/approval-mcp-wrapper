export interface SseEvent<Data extends object> {
  id: string;
  data: Data;
}

export interface SseSubscription {
  close(): void;
}

class ReplayEventBroker<Data extends object> {
  readonly #events: SseEvent<Data>[] = [];
  readonly #subscribers = new Set<(event: SseEvent<Data>) => void>();
  #sequence = 0;

  constructor(readonly replayLimit = 1_000) {}

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  publish(data: Data): SseEvent<Data> {
    const event = { id: String(++this.#sequence), data: structuredClone(data) };
    this.#events.push(event);
    if (this.#events.length > this.replayLimit) this.#events.shift();
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(structuredClone(event));
      } catch {
        this.#subscribers.delete(subscriber);
      }
    }
    return event;
  }

  subscribe(
    lastEventId: string | undefined,
    listener: (event: SseEvent<Data>) => void,
  ): SseSubscription {
    // A fresh connection gets its current snapshot from the API. Replay only
    // when a reconnect explicitly supplies the last event it received.
    if (lastEventId !== undefined && /^\d+$/.test(lastEventId)) {
      const last = Number(lastEventId);
      for (const event of this.#events) {
        if (Number(event.id) > last) listener(structuredClone(event));
      }
    }
    this.#subscribers.add(listener);
    return {
      close: () => this.#subscribers.delete(listener),
    };
  }
}

export interface ApprovalEventData {
  approvalId: string;
  status: string;
  [key: string]: unknown;
}

export interface HistoryEventData {
  callId: string;
  timestamp: string;
  type: string;
}

export type ApprovalSseEvent = SseEvent<ApprovalEventData>;
export type ApprovalSubscription = SseSubscription;
export type HistorySseEvent = SseEvent<HistoryEventData>;

export class ApprovalEventBroker extends ReplayEventBroker<ApprovalEventData> {}

export class HistoryEventBroker extends ReplayEventBroker<HistoryEventData> {}
