# Events Service

Asynchronous pub/sub event system with pattern matching, history tracking, and support for both sync and async handlers.

## Quick Start

```ts
// Subscribe to events
ctx.core.events.on("user.created", async (user) => {
  console.log("New user:", user.email);
});

// Emit events
await ctx.core.events.emit("user.created", { id: 1, email: "alice@example.com" });
```

---

## API Reference

### Interface

```ts
interface Events {
  emit<T = any>(event: string, data: T): Promise<void>;
  on<T = any>(event: string, handler: EventHandler<T>): Subscription;
  once<T = any>(event: string, handler: EventHandler<T>): Subscription;
  off(event: string, handler?: EventHandler): void;
  getHistory(event: string, limit?: number): Promise<EventRecord[]>;
}

interface Subscription {
  unsubscribe(): void;
}

interface EventRecord {
  event: string;
  data: any;
  timestamp: Date;
}
```

### Methods

| Method | Description |
|--------|-------------|
| `emit(event, data)` | Emit event to all subscribers |
| `on(event, handler)` | Subscribe to event, returns subscription |
| `once(event, handler)` | Subscribe to single occurrence |
| `off(event, handler?)` | Unsubscribe handler or all handlers |
| `getHistory(event, limit?)` | Get past events for replay |

---

## Configuration

```ts
const server = new AppServer({
  db,
  events: {
    maxHistorySize: 1000,  // Events to keep in history (default: 1000)
  },
});
```

---

## Usage Examples

### Basic Pub/Sub

```ts
// Subscribe
const subscription = ctx.core.events.on("order.created", (order) => {
  console.log("Order received:", order.id);
});

// Emit
await ctx.core.events.emit("order.created", {
  id: "order-123",
  total: 99.99,
  items: ["item-1", "item-2"],
});

// Unsubscribe
subscription.unsubscribe();
```

### Once Handler

Subscribe to a single event occurrence:

```ts
// Only fires once
ctx.core.events.once("app.ready", () => {
  console.log("Application started!");
});

await ctx.core.events.emit("app.ready", {});
await ctx.core.events.emit("app.ready", {}); // Handler not called
```

### Pattern Matching

Subscribe to events matching a pattern using wildcards:

```ts
// Match all user events
ctx.core.events.on("user.*", (data) => {
  console.log("User event:", data);
});

// These all match
await ctx.core.events.emit("user.created", { id: 1 });
await ctx.core.events.emit("user.updated", { id: 1 });
await ctx.core.events.emit("user.deleted", { id: 1 });

// Match all events in a namespace
ctx.core.events.on("analytics.*", (data) => {
  // Handle all analytics events
});

// Multi-level patterns
ctx.core.events.on("shop.order.*", (data) => {
  // Matches shop.order.created, shop.order.paid, etc.
});
```

### Async Handlers

Handlers can be async - emit() waits for all handlers:

```ts
ctx.core.events.on("order.paid", async (order) => {
  // These run in parallel
  await sendConfirmationEmail(order);
});

ctx.core.events.on("order.paid", async (order) => {
  await updateInventory(order);
});

ctx.core.events.on("order.paid", async (order) => {
  await notifyWarehouse(order);
});

// emit() waits for all handlers to complete
await ctx.core.events.emit("order.paid", order);
console.log("All handlers finished");
```

### Event History

Retrieve past events for debugging or replay:

```ts
// Get last 10 events of a type
const history = await ctx.core.events.getHistory("user.login", 10);

for (const record of history) {
  console.log(`${record.timestamp}: ${record.event}`, record.data);
}

// Get all events (use "*" pattern)
const allEvents = await ctx.core.events.getHistory("*", 100);
```

---

## Real-World Examples

### Event-Driven Architecture

```ts
// plugins/orders/index.ts
service: async (ctx) => ({
  async createOrder(data: OrderData) {
    const order = await ctx.db
      .insertInto("orders")
      .values(data)
      .returningAll()
      .executeTakeFirstOrThrow();

    // Emit event - let other systems react
    await ctx.core.events.emit("order.created", order);

    return order;
  },

  async markAsPaid(orderId: string) {
    const order = await ctx.db
      .updateTable("orders")
      .set({ status: "paid", paidAt: new Date().toISOString() })
      .where("id", "=", orderId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await ctx.core.events.emit("order.paid", order);

    return order;
  },
});

// plugins/inventory/index.ts
service: async (ctx) => {
  // React to order events
  ctx.core.events.on("order.paid", async (order) => {
    for (const item of order.items) {
      await ctx.db
        .updateTable("inventory")
        .set((eb) => ({ quantity: eb("quantity", "-", item.quantity) }))
        .where("productId", "=", item.productId)
        .execute();
    }
    ctx.core.logger.info("Inventory updated", { orderId: order.id });
  });

  return { /* inventory methods */ };
};

// plugins/notifications/index.ts
service: async (ctx) => {
  ctx.core.events.on("order.created", async (order) => {
    await sendEmail(order.customerEmail, "Order Confirmation", { order });
  });

  ctx.core.events.on("order.paid", async (order) => {
    await sendEmail(order.customerEmail, "Payment Received", { order });
    await notifySlack(`New paid order: ${order.id} - $${order.total}`);
  });

  return { /* notification methods */ };
};
```

### Audit Logging

```ts
// Log all events for audit trail
ctx.core.events.on("*", async (data) => {
  // This catches ALL events
  await ctx.db.insertInto("audit_log").values({
    event: data._eventName, // Added automatically
    data: JSON.stringify(data),
    timestamp: new Date().toISOString(),
  }).execute();
});
```

### Real-Time Updates with SSE

```ts
// Bridge events to SSE for real-time UI updates
ctx.core.events.on("notification.*", async (data) => {
  const { userId } = data;

  // Broadcast to user's SSE channel
  ctx.core.sse.broadcast(`user:${userId}`, "notification", data);
});

// When notification is created
await ctx.core.events.emit("notification.created", {
  userId: 123,
  message: "You have a new message",
});
// -> Automatically pushed to user's browser via SSE
```

### Deferred Processing with Jobs

```ts
// Convert events to background jobs for heavy processing
ctx.core.events.on("video.uploaded", async (video) => {
  // Queue for background processing instead of blocking
  await ctx.core.jobs.enqueue("processVideo", {
    videoId: video.id,
    operations: ["transcode", "thumbnail", "analyze"],
  });
});
```

---

## Event Naming Conventions

Use consistent, hierarchical event names:

```ts
// Resource lifecycle events
"user.created"
"user.updated"
"user.deleted"

// State transitions
"order.pending"
"order.paid"
"order.shipped"
"order.delivered"

// Actions
"email.sent"
"payment.processed"
"file.uploaded"

// Namespaced events
"auth.login.success"
"auth.login.failed"
"auth.logout"
```

---

## Error Handling

Handler errors are caught and logged, but don't prevent other handlers:

```ts
ctx.core.events.on("test", async () => {
  throw new Error("Handler 1 failed");
});

ctx.core.events.on("test", async () => {
  console.log("Handler 2 still runs");
});

// Both handlers are called, error is logged
await ctx.core.events.emit("test", {});
```

To handle errors explicitly:

```ts
ctx.core.events.on("critical.event", async (data) => {
  try {
    await riskyOperation(data);
  } catch (error) {
    ctx.core.logger.error("Handler failed", { error: error.message, data });
    // Optionally emit error event
    await ctx.core.events.emit("critical.event.failed", { error, data });
  }
});
```

---

## Custom Adapters

Implement `EventAdapter` for persistence or distribution:

```ts
interface EventAdapter {
  publish(event: string, data: any): Promise<void>;
  getHistory(event: string, limit?: number): Promise<EventRecord[]>;
}
```

### Redis Pub/Sub Adapter

```ts
import { createEvents, type EventAdapter } from "./core/events";
import Redis from "ioredis";

class RedisEventAdapter implements EventAdapter {
  private history: EventRecord[] = [];

  constructor(
    private publisher: Redis,
    private subscriber: Redis,
    private onMessage: (event: string, data: any) => void
  ) {
    subscriber.on("pmessage", (pattern, channel, message) => {
      const data = JSON.parse(message);
      this.onMessage(channel, data);
    });
    subscriber.psubscribe("*");
  }

  async publish(event: string, data: any): Promise<void> {
    this.history.push({ event, data, timestamp: new Date() });
    await this.publisher.publish(event, JSON.stringify(data));
  }

  async getHistory(event: string, limit: number = 100): Promise<EventRecord[]> {
    return this.history
      .filter((r) => r.event === event || event === "*")
      .slice(-limit);
  }
}
```

---

## Best Practices

### 1. Keep Events Small

```ts
// Good - include only what's needed
await events.emit("user.created", {
  id: user.id,
  email: user.email,
});

// Bad - including unnecessary data
await events.emit("user.created", {
  ...user,           // Full user object
  password: user.password,  // Sensitive!
  internalData: {...},      // Unnecessary
});
```

### 2. Use Past Tense for Completed Actions

```ts
// Good - indicates action completed
"order.created"
"payment.processed"
"email.sent"

// Avoid - ambiguous timing
"order.create"
"payment.process"
```

### 3. Include Identifiers for Correlation

```ts
await events.emit("order.shipped", {
  orderId: order.id,
  userId: order.userId,
  trackingNumber: shipment.trackingNumber,
  // Correlate with requestId if available
  requestId: ctx.requestId,
});
```

### 4. Document Event Schemas

```ts
// events.ts - Central event type definitions
export interface UserCreatedEvent {
  id: number;
  email: string;
  createdAt: string;
}

export interface OrderPaidEvent {
  orderId: string;
  amount: number;
  currency: string;
  paidAt: string;
}

// Type-safe emission
await ctx.core.events.emit<UserCreatedEvent>("user.created", {
  id: 1,
  email: "test@example.com",
  createdAt: new Date().toISOString(),
});
```
