# SSE Service

Server-Sent Events for real-time server-to-client push notifications. Supports channels, broadcasting, and automatic heartbeats.

## Quick Start

```ts
// Create SSE endpoint
router.route("events").raw({
  handle: async (req, ctx) => {
    const { client, response } = ctx.core.sse.addClient();
    ctx.core.sse.subscribe(client.id, `user:${ctx.user.id}`);
    return response;
  },
});

// Broadcast updates from anywhere
ctx.core.sse.broadcast(`user:${userId}`, "notification", {
  message: "You have a new message",
});
```

---

## API Reference

### Interface

```ts
interface SSE {
  addClient(options?: { lastEventId?: string }): { client: SSEClient; response: Response };
  removeClient(clientId: string): void;
  getClient(clientId: string): SSEClient | undefined;
  subscribe(clientId: string, channel: string): boolean;
  unsubscribe(clientId: string, channel: string): boolean;
  broadcast(channel: string, event: string, data: any, id?: string): void;
  broadcastAll(event: string, data: any, id?: string): void;
  sendTo(clientId: string, event: string, data: any, id?: string): boolean;
  getClients(): SSEClient[];
  getClientsByChannel(channel: string): SSEClient[];
  shutdown(): void;
}

interface SSEClient {
  id: string;
  channels: Set<string>;
  controller: ReadableStreamDefaultController<Uint8Array>;
  createdAt: Date;
  lastEventId?: string;
}
```

### Methods

| Method | Description |
|--------|-------------|
| `addClient(opts?)` | Create new SSE client, returns client and response |
| `removeClient(id)` | Disconnect and remove client |
| `getClient(id)` | Get client by ID |
| `subscribe(clientId, channel)` | Subscribe client to channel |
| `unsubscribe(clientId, channel)` | Unsubscribe from channel |
| `broadcast(channel, event, data, id?)` | Send to all channel subscribers |
| `broadcastAll(event, data, id?)` | Send to all connected clients |
| `sendTo(clientId, event, data, id?)` | Send to specific client |
| `getClients()` | Get all connected clients |
| `getClientsByChannel(channel)` | Get clients subscribed to channel |
| `shutdown()` | Close all connections |

---

## Configuration

```ts
const server = new AppServer({
  db,
  sse: {
    heartbeatInterval: 30000,  // Keep-alive interval (default: 30s)
    retryInterval: 3000,       // Client reconnect hint (default: 3s)
  },
});
```

---

## Usage Examples

### Basic SSE Endpoint

```ts
// Subscribe to user-specific updates
router.route("subscribe").raw({
  handle: async (req, ctx) => {
    // Create SSE client
    const { client, response } = ctx.core.sse.addClient();

    // Subscribe to user's channel
    ctx.core.sse.subscribe(client.id, `user:${ctx.user.id}`);

    // Log connection
    ctx.core.logger.info("SSE client connected", {
      clientId: client.id,
      userId: ctx.user.id,
    });

    return response;
  },
});
```

### Client-Side JavaScript

```js
// Connect to SSE endpoint
const eventSource = new EventSource("/subscribe", {
  withCredentials: true, // For cookies/auth
});

// Listen for specific events
eventSource.addEventListener("notification", (event) => {
  const data = JSON.parse(event.data);
  console.log("Notification:", data);
  showNotification(data.message);
});

eventSource.addEventListener("message", (event) => {
  console.log("Message:", JSON.parse(event.data));
});

// Handle connection errors
eventSource.onerror = (error) => {
  console.error("SSE error:", error);
  // EventSource auto-reconnects
};

// Close connection
eventSource.close();
```

### Broadcasting Events

```ts
// From route handler
router.route("sendMessage").typed({
  handle: async (input, ctx) => {
    const message = await ctx.db.insertInto("messages").values({
      fromUserId: ctx.user.id,
      toUserId: input.recipientId,
      content: input.content,
    }).returningAll().executeTakeFirstOrThrow();

    // Push to recipient in real-time
    ctx.core.sse.broadcast(`user:${input.recipientId}`, "newMessage", {
      id: message.id,
      from: ctx.user.name,
      content: input.content,
    });

    return message;
  },
});

// From job handler
ctx.core.jobs.register("broadcastAnnouncement", async (data) => {
  // Send to all connected clients
  ctx.core.sse.broadcastAll("announcement", {
    title: data.title,
    message: data.message,
    priority: data.priority,
  });
});
```

### Channel-Based Subscriptions

```ts
// Multiple channel subscriptions
router.route("subscribe").raw({
  handle: async (req, ctx) => {
    const url = new URL(req.url);
    const channels = url.searchParams.getAll("channel");

    const { client, response } = ctx.core.sse.addClient();

    // Subscribe to requested channels
    for (const channel of channels) {
      // Validate channel access
      if (await canAccessChannel(ctx.user, channel)) {
        ctx.core.sse.subscribe(client.id, channel);
      }
    }

    // Always subscribe to user channel
    ctx.core.sse.subscribe(client.id, `user:${ctx.user.id}`);

    return response;
  },
});

// Client: /subscribe?channel=orders&channel=notifications
```

---

## Real-World Examples

### Live Notifications

```ts
// plugins/notifications/index.ts
service: async (ctx) => {
  return {
    async create(userId: number, notification: NotificationData) {
      // Save to database
      const saved = await ctx.db.insertInto("notifications").values({
        userId,
        ...notification,
        read: false,
        createdAt: new Date().toISOString(),
      }).returningAll().executeTakeFirstOrThrow();

      // Push to user in real-time
      ctx.core.sse.broadcast(`user:${userId}`, "notification", {
        id: saved.id,
        title: notification.title,
        body: notification.body,
        type: notification.type,
        createdAt: saved.createdAt,
      });

      return saved;
    },

    async markAsRead(userId: number, notificationId: number) {
      await ctx.db.updateTable("notifications")
        .set({ read: true })
        .where("id", "=", notificationId)
        .where("userId", "=", userId)
        .execute();

      // Update badge count in real-time
      const unreadCount = await ctx.db
        .selectFrom("notifications")
        .where("userId", "=", userId)
        .where("read", "=", false)
        .count()
        .executeTakeFirst();

      ctx.core.sse.broadcast(`user:${userId}`, "unreadCount", {
        count: Number(unreadCount?.count ?? 0),
      });
    },
  };
};
```

### Live Dashboard Updates

```ts
// Subscribe to dashboard updates
router.route("dashboard/live").raw({
  handle: async (req, ctx) => {
    const { client, response } = ctx.core.sse.addClient();

    ctx.core.sse.subscribe(client.id, "dashboard:stats");
    ctx.core.sse.subscribe(client.id, "dashboard:orders");
    ctx.core.sse.subscribe(client.id, "dashboard:alerts");

    // Send initial data
    const stats = await getDashboardStats();
    ctx.core.sse.sendTo(client.id, "initialData", stats);

    return response;
  },
});

// Update all dashboard viewers when data changes
ctx.core.events.on("order.created", async (order) => {
  ctx.core.sse.broadcast("dashboard:orders", "newOrder", {
    id: order.id,
    total: order.total,
    customer: order.customerName,
  });
});

ctx.core.cron.schedule("*/30 * * * * *", async () => {
  const stats = await getDashboardStats();
  ctx.core.sse.broadcast("dashboard:stats", "statsUpdate", stats);
});
```

### Collaborative Features

```ts
// Document collaboration
router.route("document/:id/live").raw({
  handle: async (req, ctx) => {
    const docId = ctx.params.id;

    // Verify access
    const canAccess = await checkDocumentAccess(ctx.user.id, docId);
    if (!canAccess) {
      return new Response("Forbidden", { status: 403 });
    }

    const { client, response } = ctx.core.sse.addClient();
    ctx.core.sse.subscribe(client.id, `document:${docId}`);

    // Notify others of new collaborator
    ctx.core.sse.broadcast(`document:${docId}`, "userJoined", {
      userId: ctx.user.id,
      name: ctx.user.name,
    });

    return response;
  },
});

// Broadcast document changes
router.route("document/:id/edit").typed({
  handle: async (input, ctx) => {
    const docId = ctx.params.id;

    // Save changes
    await saveDocumentChanges(docId, input.changes);

    // Broadcast to all viewers
    ctx.core.sse.broadcast(`document:${docId}`, "documentChanged", {
      changes: input.changes,
      userId: ctx.user.id,
      timestamp: Date.now(),
    });

    return { success: true };
  },
});
```

### Progress Updates

```ts
// Long-running task with progress
router.route("process").typed({
  handle: async (input, ctx) => {
    const taskId = crypto.randomUUID();

    // Start background processing
    ctx.core.jobs.enqueue("longProcess", {
      taskId,
      data: input.data,
      userId: ctx.user.id,
    });

    return { taskId };
  },
});

// In job handler
ctx.core.jobs.register("longProcess", async (data) => {
  const { taskId, data: items, userId } = data;
  const total = items.length;

  for (let i = 0; i < total; i++) {
    await processItem(items[i]);

    // Send progress update
    ctx.core.sse.broadcast(`user:${userId}`, "taskProgress", {
      taskId,
      current: i + 1,
      total,
      percent: Math.round(((i + 1) / total) * 100),
    });
  }

  // Send completion
  ctx.core.sse.broadcast(`user:${userId}`, "taskComplete", {
    taskId,
    result: "success",
  });
});
```

---

## SSE Message Format

Messages sent to clients follow the SSE format:

```
id: optional-event-id
event: eventName
data: {"json":"payload"}

```

Example:

```ts
ctx.core.sse.sendTo(clientId, "notification", { message: "Hello" }, "msg-123");
```

Client receives:

```
id: msg-123
event: notification
data: {"message":"Hello"}

```

---

## Connection Management

### Tracking Connections

```ts
// Get connection statistics
router.route("admin/connections").typed({
  handle: async (input, ctx) => {
    const clients = ctx.core.sse.getClients();

    const byChannel: Record<string, number> = {};
    for (const client of clients) {
      for (const channel of client.channels) {
        byChannel[channel] = (byChannel[channel] || 0) + 1;
      }
    }

    return {
      totalConnections: clients.length,
      byChannel,
      oldestConnection: clients.reduce(
        (oldest, c) => (c.createdAt < oldest ? c.createdAt : oldest),
        new Date()
      ),
    };
  },
});
```

### Graceful Disconnect

```ts
// Client disconnection is handled automatically when:
// 1. Client closes connection
// 2. Network error occurs
// 3. Server calls removeClient()

// Force disconnect a client
ctx.core.sse.removeClient(clientId);

// Shutdown all connections (called by server.shutdown())
ctx.core.sse.shutdown();
```

---

## Best Practices

### 1. Use Specific Channels

```ts
// Good - targeted channels
ctx.core.sse.subscribe(clientId, `user:${userId}`);
ctx.core.sse.subscribe(clientId, `order:${orderId}`);
ctx.core.sse.subscribe(clientId, `team:${teamId}`);

// Bad - one channel for everything
ctx.core.sse.subscribe(clientId, "all");
```

### 2. Include Event IDs for Resume

```ts
// Include ID for client resume capability
ctx.core.sse.broadcast(channel, event, data, `evt-${Date.now()}`);

// Client can resume from last event
const { client, response } = ctx.core.sse.addClient({
  lastEventId: req.headers.get("Last-Event-ID") ?? undefined,
});
```

### 3. Send Initial State

```ts
router.route("subscribe").raw({
  handle: async (req, ctx) => {
    const { client, response } = ctx.core.sse.addClient();

    ctx.core.sse.subscribe(client.id, `user:${ctx.user.id}`);

    // Send initial state immediately
    const unreadCount = await getUnreadCount(ctx.user.id);
    ctx.core.sse.sendTo(client.id, "initialState", {
      unreadNotifications: unreadCount,
      online: true,
    });

    return response;
  },
});
```

### 4. Handle Client Limits

```ts
router.route("subscribe").raw({
  handle: async (req, ctx) => {
    // Limit connections per user
    const existingClients = ctx.core.sse.getClientsByChannel(`user:${ctx.user.id}`);

    if (existingClients.length >= 5) {
      // Remove oldest connection
      ctx.core.sse.removeClient(existingClients[0].id);
    }

    const { client, response } = ctx.core.sse.addClient();
    ctx.core.sse.subscribe(client.id, `user:${ctx.user.id}`);

    return response;
  },
});
```

### 5. Keep Payloads Small

```ts
// Good - minimal data, client fetches details if needed
ctx.core.sse.broadcast(channel, "orderUpdated", {
  orderId: order.id,
  status: order.status,
});

// Bad - full object over SSE
ctx.core.sse.broadcast(channel, "orderUpdated", {
  ...order,
  items: order.items,
  customer: order.customer,
  // Large nested data
});
```
