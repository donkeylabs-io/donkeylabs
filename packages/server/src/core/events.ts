// Core Events Service
// Pub/sub async event queue

export interface EventHandler<T = any> {
  (data: T): void | Promise<void>;
}

export interface Subscription {
  unsubscribe(): void;
}

export interface EventRecord {
  event: string;
  data: any;
  timestamp: Date;
}

export interface EventAdapter {
  publish(event: string, data: any): Promise<void>;
  getHistory(event: string, limit?: number): Promise<EventRecord[]>;
}

export interface EventsConfig {
  adapter?: EventAdapter;
  maxHistorySize?: number;
}

export interface Events {
  emit<T = any>(event: string, data: T): Promise<void>;
  on<T = any>(event: string, handler: EventHandler<T>): Subscription;
  once<T = any>(event: string, handler: EventHandler<T>): Subscription;
  off(event: string, handler?: EventHandler): void;
  getHistory(event: string, limit?: number): Promise<EventRecord[]>;
}

// In-memory event adapter with history
export class MemoryEventAdapter implements EventAdapter {
  private history: EventRecord[] = [];
  private maxHistorySize: number;

  constructor(maxHistorySize: number = 1000) {
    this.maxHistorySize = maxHistorySize;
  }

  async publish(event: string, data: any): Promise<void> {
    const record: EventRecord = {
      event,
      data,
      timestamp: new Date(),
    };

    this.history.push(record);

    // Trim history if needed
    while (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
  }

  async getHistory(event: string, limit: number = 100): Promise<EventRecord[]> {
    return this.history
      .filter(r => r.event === event || event === "*")
      .slice(-limit);
  }
}

class EventsImpl implements Events {
  private handlers = new Map<string, Set<EventHandler>>();
  private adapter: EventAdapter;

  constructor(config: EventsConfig = {}) {
    this.adapter = config.adapter ?? new MemoryEventAdapter(config.maxHistorySize);
  }

  async emit<T = any>(event: string, data: T): Promise<void> {
    // Store in adapter (for history/persistence)
    await this.adapter.publish(event, data);

    // Notify handlers
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      const promises: Promise<void>[] = [];
      for (const handler of eventHandlers) {
        try {
          const result = handler(data);
          if (result instanceof Promise) {
            promises.push(result.catch(err => {
              console.error(`[Events] Handler error for "${event}":`, err);
            }));
          }
        } catch (err) {
          console.error(`[Events] Handler error for "${event}":`, err);
        }
      }
      // Wait for all async handlers
      await Promise.all(promises);
    }

    // Also notify pattern handlers (e.g., "user.*" matches "user.created")
    for (const [pattern, handlers] of this.handlers.entries()) {
      if (pattern.includes("*") && this.matchPattern(event, pattern)) {
        for (const handler of handlers) {
          try {
            const result = handler(data);
            if (result instanceof Promise) {
              await result.catch(err => {
                console.error(`[Events] Pattern handler error for "${pattern}":`, err);
              });
            }
          } catch (err) {
            console.error(`[Events] Pattern handler error for "${pattern}":`, err);
          }
        }
      }
    }
  }

  on<T = any>(event: string, handler: EventHandler<T>): Subscription {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler);

    return {
      unsubscribe: () => {
        this.handlers.get(event)?.delete(handler as EventHandler);
      },
    };
  }

  once<T = any>(event: string, handler: EventHandler<T>): Subscription {
    const wrappedHandler: EventHandler<T> = async (data) => {
      this.handlers.get(event)?.delete(wrappedHandler as EventHandler);
      await handler(data);
    };

    return this.on(event, wrappedHandler);
  }

  off(event: string, handler?: EventHandler): void {
    if (handler) {
      this.handlers.get(event)?.delete(handler);
    } else {
      this.handlers.delete(event);
    }
  }

  async getHistory(event: string, limit?: number): Promise<EventRecord[]> {
    return this.adapter.getHistory(event, limit);
  }

  private matchPattern(event: string, pattern: string): boolean {
    // Convert glob pattern to regex (e.g., "user.*" -> /^user\..*$/)
    const regex = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"
    );
    return regex.test(event);
  }
}

export function createEvents(config?: EventsConfig): Events {
  return new EventsImpl(config);
}
