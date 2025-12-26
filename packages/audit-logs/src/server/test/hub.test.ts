import { describe, expect, it, mock, beforeEach } from "bun:test";
import { WebSocketHub, type ConnectionData } from "../hub";
import type { LogEntry, LogLevel } from "../../shared/types";
import type { ServerWebSocket } from "bun";

// Mock ServerWebSocket for testing
function createMockWebSocket(userId: number = 1): ServerWebSocket<ConnectionData> {
  const sentMessages: string[] = [];

  const ws = {
    data: {
      connectionId: "",
      userId,
      connectedAt: 0,
      filters: null,
    } as ConnectionData,
    send: mock((message: string) => {
      sentMessages.push(message);
    }),
    sentMessages,
    close: mock(() => {}),
    readyState: 1,
  } as unknown as ServerWebSocket<ConnectionData> & { sentMessages: string[] };

  return ws;
}

function createLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: "log_test_123",
    timestamp: Date.now(),
    level: "info" as LogLevel,
    event: "test.event",
    userId: null,
    companyId: null,
    employeeId: null,
    username: null,
    ipAddress: null,
    userAgent: null,
    geoCountry: null,
    geoCity: null,
    method: null,
    path: null,
    statusCode: null,
    durationMs: null,
    metadata: null,
    message: null,
    traceId: null,
    ...overrides,
  };
}

describe("WebSocketHub", () => {
  let hub: WebSocketHub;

  beforeEach(() => {
    hub = new WebSocketHub();
  });

  describe("handleOpen", () => {
    it("registers a new connection", () => {
      const ws = createMockWebSocket(1);

      hub.handleOpen(ws);

      expect(ws.data.connectionId).toMatch(/^conn_/);
      expect(ws.data.connectedAt).toBeGreaterThan(0);
      expect(ws.data.filters).toBeNull();

      const stats = hub.getStats();
      expect(stats.totalConnections).toBe(1);
      expect(stats.uniqueUsers).toBe(1);
    });

    it("sends connected message", () => {
      const ws = createMockWebSocket(1);

      hub.handleOpen(ws);

      expect((ws as any).sentMessages.length).toBe(1);
      const message = JSON.parse((ws as any).sentMessages[0]);
      expect(message.type).toBe("connected");
      expect(message.connectionId).toBe(ws.data.connectionId);
    });

    it("tracks multiple connections from same user", () => {
      const ws1 = createMockWebSocket(1);
      const ws2 = createMockWebSocket(1);

      hub.handleOpen(ws1);
      hub.handleOpen(ws2);

      const stats = hub.getStats();
      expect(stats.totalConnections).toBe(2);
      expect(stats.uniqueUsers).toBe(1);
    });

    it("tracks connections from different users", () => {
      const ws1 = createMockWebSocket(1);
      const ws2 = createMockWebSocket(2);

      hub.handleOpen(ws1);
      hub.handleOpen(ws2);

      const stats = hub.getStats();
      expect(stats.totalConnections).toBe(2);
      expect(stats.uniqueUsers).toBe(2);
    });
  });

  describe("handleMessage", () => {
    it("handles subscribe message", () => {
      const ws = createMockWebSocket(1);
      hub.handleOpen(ws);

      const subscribeMsg = JSON.stringify({
        type: "subscribe",
        filters: { levels: ["error", "warn"] },
      });

      hub.handleMessage(ws, subscribeMsg);

      expect(ws.data.filters).toEqual({ levels: ["error", "warn"] });
      const lastMessage = JSON.parse((ws as any).sentMessages[(ws as any).sentMessages.length - 1]);
      expect(lastMessage.type).toBe("subscribed");
    });

    it("handles unsubscribe message", () => {
      const ws = createMockWebSocket(1);
      hub.handleOpen(ws);

      // First subscribe
      hub.handleMessage(ws, JSON.stringify({
        type: "subscribe",
        filters: { levels: ["error"] },
      }));

      // Then unsubscribe
      hub.handleMessage(ws, JSON.stringify({ type: "unsubscribe" }));

      expect(ws.data.filters).toBeNull();
    });

    it("handles ping message", () => {
      const ws = createMockWebSocket(1);
      hub.handleOpen(ws);

      hub.handleMessage(ws, JSON.stringify({ type: "ping" }));

      const lastMessage = JSON.parse((ws as any).sentMessages[(ws as any).sentMessages.length - 1]);
      expect(lastMessage.type).toBe("pong");
    });

    it("handles invalid JSON", () => {
      const ws = createMockWebSocket(1);
      hub.handleOpen(ws);

      hub.handleMessage(ws, "not-json");

      const lastMessage = JSON.parse((ws as any).sentMessages[(ws as any).sentMessages.length - 1]);
      expect(lastMessage.type).toBe("error");
    });

    it("handles invalid message format", () => {
      const ws = createMockWebSocket(1);
      hub.handleOpen(ws);

      hub.handleMessage(ws, JSON.stringify({ type: "invalid" }));

      const lastMessage = JSON.parse((ws as any).sentMessages[(ws as any).sentMessages.length - 1]);
      expect(lastMessage.type).toBe("error");
    });

    it("handles Buffer message", () => {
      const ws = createMockWebSocket(1);
      hub.handleOpen(ws);

      const buffer = Buffer.from(JSON.stringify({ type: "ping" }));
      hub.handleMessage(ws, buffer);

      const lastMessage = JSON.parse((ws as any).sentMessages[(ws as any).sentMessages.length - 1]);
      expect(lastMessage.type).toBe("pong");
    });
  });

  describe("handleClose", () => {
    it("removes connection from tracking", () => {
      const ws = createMockWebSocket(1);
      hub.handleOpen(ws);

      expect(hub.getStats().totalConnections).toBe(1);

      hub.handleClose(ws);

      expect(hub.getStats().totalConnections).toBe(0);
    });

    it("removes user from tracking when last connection closes", () => {
      const ws = createMockWebSocket(1);
      hub.handleOpen(ws);

      expect(hub.isUserConnected(1)).toBe(true);

      hub.handleClose(ws);

      expect(hub.isUserConnected(1)).toBe(false);
    });

    it("keeps user in tracking when other connections remain", () => {
      const ws1 = createMockWebSocket(1);
      const ws2 = createMockWebSocket(1);

      hub.handleOpen(ws1);
      hub.handleOpen(ws2);

      hub.handleClose(ws1);

      expect(hub.isUserConnected(1)).toBe(true);
      expect(hub.getStats().totalConnections).toBe(1);
    });
  });

  describe("broadcast", () => {
    it("broadcasts to all connections without filters", () => {
      const ws1 = createMockWebSocket(1);
      const ws2 = createMockWebSocket(2);

      hub.handleOpen(ws1);
      hub.handleOpen(ws2);

      const entry = createLogEntry({ event: "test.broadcast" });
      hub.broadcast(entry);

      // Both should receive the log
      const ws1Messages = (ws1 as any).sentMessages;
      const ws2Messages = (ws2 as any).sentMessages;

      const ws1Log = JSON.parse(ws1Messages[ws1Messages.length - 1]);
      const ws2Log = JSON.parse(ws2Messages[ws2Messages.length - 1]);

      expect(ws1Log.type).toBe("log");
      expect(ws1Log.entry.event).toBe("test.broadcast");
      expect(ws2Log.type).toBe("log");
    });

    it("respects level filters", () => {
      const ws1 = createMockWebSocket(1);
      const ws2 = createMockWebSocket(2);

      hub.handleOpen(ws1);
      hub.handleOpen(ws2);

      // ws1 subscribes to errors only
      hub.handleMessage(ws1, JSON.stringify({
        type: "subscribe",
        filters: { levels: ["error"] },
      }));

      // ws2 subscribes to info
      hub.handleMessage(ws2, JSON.stringify({
        type: "subscribe",
        filters: { levels: ["info"] },
      }));

      // Broadcast an info log
      const entry = createLogEntry({ level: "info" });
      hub.broadcast(entry);

      // ws1 should not receive it, ws2 should
      const ws1Messages = (ws1 as any).sentMessages;
      const ws2Messages = (ws2 as any).sentMessages;

      // ws1: connected + subscribed = 2 messages (no log)
      // ws2: connected + subscribed + log = 3 messages
      expect(ws1Messages.length).toBe(2);
      expect(ws2Messages.length).toBe(3);
    });

    it("respects minLevel filter", () => {
      const ws = createMockWebSocket(1);
      hub.handleOpen(ws);

      hub.handleMessage(ws, JSON.stringify({
        type: "subscribe",
        filters: { minLevel: "warn" },
      }));

      // Broadcast logs of different levels
      hub.broadcast(createLogEntry({ level: "debug" }));
      hub.broadcast(createLogEntry({ level: "info" }));
      hub.broadcast(createLogEntry({ level: "warn" }));
      hub.broadcast(createLogEntry({ level: "error" }));

      const messages = (ws as any).sentMessages;
      // connected + subscribed + warn + error = 4 messages
      expect(messages.length).toBe(4);
    });

    it("respects userId filter", () => {
      const ws = createMockWebSocket(1);
      hub.handleOpen(ws);

      hub.handleMessage(ws, JSON.stringify({
        type: "subscribe",
        filters: { userId: 42 },
      }));

      // Broadcast logs with different userIds
      hub.broadcast(createLogEntry({ userId: 42 }));
      hub.broadcast(createLogEntry({ userId: 99 }));
      hub.broadcast(createLogEntry({ userId: null }));

      const messages = (ws as any).sentMessages;
      // connected + subscribed + 1 log = 3 messages
      expect(messages.length).toBe(3);
    });

    it("respects companyId filter", () => {
      const ws = createMockWebSocket(1);
      hub.handleOpen(ws);

      hub.handleMessage(ws, JSON.stringify({
        type: "subscribe",
        filters: { companyId: 100 },
      }));

      hub.broadcast(createLogEntry({ companyId: 100 }));
      hub.broadcast(createLogEntry({ companyId: 200 }));

      const messages = (ws as any).sentMessages;
      // connected + subscribed + 1 log = 3 messages
      expect(messages.length).toBe(3);
    });

    it("respects event patterns with wildcard suffix", () => {
      const ws = createMockWebSocket(1);
      hub.handleOpen(ws);

      hub.handleMessage(ws, JSON.stringify({
        type: "subscribe",
        filters: { events: ["auth.*"] },
      }));

      hub.broadcast(createLogEntry({ event: "auth.login" }));
      hub.broadcast(createLogEntry({ event: "auth.logout" }));
      hub.broadcast(createLogEntry({ event: "api.request" }));

      const messages = (ws as any).sentMessages;
      // connected + subscribed + 2 logs = 4 messages
      expect(messages.length).toBe(4);
    });

    it("respects event patterns with wildcard prefix", () => {
      const ws = createMockWebSocket(1);
      hub.handleOpen(ws);

      hub.handleMessage(ws, JSON.stringify({
        type: "subscribe",
        filters: { events: ["*.error"] },
      }));

      hub.broadcast(createLogEntry({ event: "auth.error" }));
      hub.broadcast(createLogEntry({ event: "api.error" }));
      hub.broadcast(createLogEntry({ event: "auth.success" }));

      const messages = (ws as any).sentMessages;
      // connected + subscribed + 2 logs = 4 messages
      expect(messages.length).toBe(4);
    });

    it("respects exact event match", () => {
      const ws = createMockWebSocket(1);
      hub.handleOpen(ws);

      hub.handleMessage(ws, JSON.stringify({
        type: "subscribe",
        filters: { events: ["auth.login"] },
      }));

      hub.broadcast(createLogEntry({ event: "auth.login" }));
      hub.broadcast(createLogEntry({ event: "auth.logout" }));

      const messages = (ws as any).sentMessages;
      // connected + subscribed + 1 log = 3 messages
      expect(messages.length).toBe(3);
    });
  });

  describe("sendToUser", () => {
    it("sends to all connections of a specific user", () => {
      const ws1 = createMockWebSocket(1);
      const ws2 = createMockWebSocket(1);
      const ws3 = createMockWebSocket(2);

      hub.handleOpen(ws1);
      hub.handleOpen(ws2);
      hub.handleOpen(ws3);

      const entry = createLogEntry();
      hub.sendToUser(1, entry);

      // User 1's connections should receive it
      expect((ws1 as any).sentMessages.length).toBe(2); // connected + log
      expect((ws2 as any).sentMessages.length).toBe(2); // connected + log
      // User 2's connection should not
      expect((ws3 as any).sentMessages.length).toBe(1); // connected only
    });

    it("does nothing if user has no connections", () => {
      const entry = createLogEntry();
      // Should not throw
      hub.sendToUser(999, entry);
    });
  });

  describe("utility methods", () => {
    it("isUserConnected returns correct status", () => {
      expect(hub.isUserConnected(1)).toBe(false);

      const ws = createMockWebSocket(1);
      hub.handleOpen(ws);

      expect(hub.isUserConnected(1)).toBe(true);

      hub.handleClose(ws);

      expect(hub.isUserConnected(1)).toBe(false);
    });

    it("getUserConnections returns connection IDs", () => {
      expect(hub.getUserConnections(1)).toEqual([]);

      const ws1 = createMockWebSocket(1);
      const ws2 = createMockWebSocket(1);

      hub.handleOpen(ws1);
      hub.handleOpen(ws2);

      const connections = hub.getUserConnections(1);
      expect(connections.length).toBe(2);
      expect(connections).toContain(ws1.data.connectionId);
      expect(connections).toContain(ws2.data.connectionId);
    });

    it("getStats returns correct counts", () => {
      expect(hub.getStats()).toEqual({
        totalConnections: 0,
        uniqueUsers: 0,
      });

      const ws1 = createMockWebSocket(1);
      const ws2 = createMockWebSocket(2);
      const ws3 = createMockWebSocket(1);

      hub.handleOpen(ws1);
      hub.handleOpen(ws2);
      hub.handleOpen(ws3);

      expect(hub.getStats()).toEqual({
        totalConnections: 3,
        uniqueUsers: 2,
      });
    });
  });
});
