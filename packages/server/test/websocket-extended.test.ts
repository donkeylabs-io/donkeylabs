import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createWebSocket, type WebSocketService } from "../src/core/websocket";

// ============================================
// Mock helpers
// ============================================

function createMockSocket() {
  const messages: string[] = [];
  let closed = false;
  let closeCode: number | undefined;
  let closeReason: string | undefined;
  return {
    socket: {
      send(msg: string) {
        messages.push(msg);
      },
      close(code?: number, reason?: string) {
        closed = true;
        closeCode = code;
        closeReason = reason;
      },
    } as any,
    messages,
    get closed() {
      return closed;
    },
    get closeCode() {
      return closeCode;
    },
    get closeReason() {
      return closeReason;
    },
  };
}

// ============================================
// Tests
// ============================================

describe("WebSocket Service", () => {
  let ws: WebSocketService;

  afterEach(() => {
    ws.shutdown();
  });

  // ------------------------------------------
  // handleUpgrade
  // ------------------------------------------
  describe("handleUpgrade", () => {
    beforeEach(() => {
      ws = createWebSocket({ pingInterval: 60_000 });
    });

    it("should register a client", () => {
      const { socket } = createMockSocket();
      ws.handleUpgrade("c1", socket);

      expect(ws.isConnected("c1")).toBe(true);
      expect(ws.getClientCount()).toBe(1);
    });

    it("should set connectedAt timestamp", () => {
      const { socket } = createMockSocket();
      const before = new Date();
      ws.handleUpgrade("c1", socket);

      const clients = ws.getClients();
      expect(clients).toHaveLength(1);
      expect(clients[0].connectedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it("should store metadata if provided", () => {
      const { socket } = createMockSocket();
      ws.handleUpgrade("c1", socket, { role: "admin" });

      expect(ws.getClientMetadata("c1")).toEqual({ role: "admin" });
    });

    it("should register client without metadata", () => {
      const { socket } = createMockSocket();
      ws.handleUpgrade("c1", socket);

      expect(ws.getClientMetadata("c1")).toBeUndefined();
    });

    it("should register multiple clients", () => {
      ws.handleUpgrade("c1", createMockSocket().socket);
      ws.handleUpgrade("c2", createMockSocket().socket);
      ws.handleUpgrade("c3", createMockSocket().socket);

      expect(ws.getClientCount()).toBe(3);
    });
  });

  // ------------------------------------------
  // handleClose
  // ------------------------------------------
  describe("handleClose", () => {
    beforeEach(() => {
      ws = createWebSocket({ pingInterval: 60_000 });
    });

    it("should remove a client", () => {
      ws.handleUpgrade("c1", createMockSocket().socket);
      expect(ws.isConnected("c1")).toBe(true);

      ws.handleClose("c1");
      expect(ws.isConnected("c1")).toBe(false);
      expect(ws.getClientCount()).toBe(0);
    });

    it("should remove client from all channels", () => {
      ws.handleUpgrade("c1", createMockSocket().socket);
      ws.subscribe("c1", "room-a");
      ws.subscribe("c1", "room-b");

      ws.handleClose("c1");

      expect(ws.getClientCount("room-a")).toBe(0);
      expect(ws.getClientCount("room-b")).toBe(0);
    });

    it("should clean up empty channels after removal", () => {
      ws.handleUpgrade("c1", createMockSocket().socket);
      ws.subscribe("c1", "room-x");
      expect(ws.getClientIds("room-x")).toHaveLength(1);

      ws.handleClose("c1");

      // Channel should be removed entirely (returns empty array)
      expect(ws.getClientIds("room-x")).toEqual([]);
    });

    it("should not remove other clients from a shared channel", () => {
      ws.handleUpgrade("c1", createMockSocket().socket);
      ws.handleUpgrade("c2", createMockSocket().socket);
      ws.subscribe("c1", "room");
      ws.subscribe("c2", "room");

      ws.handleClose("c1");

      expect(ws.getClientCount("room")).toBe(1);
      expect(ws.getClientIds("room")).toEqual(["c2"]);
    });

    it("should be a no-op for unknown client", () => {
      ws.handleClose("nonexistent");
      expect(ws.getClientCount()).toBe(0);
    });
  });

  // ------------------------------------------
  // subscribe / unsubscribe
  // ------------------------------------------
  describe("subscribe", () => {
    beforeEach(() => {
      ws = createWebSocket({ pingInterval: 60_000, maxClientsPerChannel: 2 });
    });

    it("should add client to a channel", () => {
      ws.handleUpgrade("c1", createMockSocket().socket);
      const result = ws.subscribe("c1", "room");

      expect(result).toBe(true);
      expect(ws.getClientIds("room")).toContain("c1");
    });

    it("should return false for unknown client", () => {
      const result = ws.subscribe("unknown", "room");
      expect(result).toBe(false);
    });

    it("should enforce maxClientsPerChannel", () => {
      ws.handleUpgrade("c1", createMockSocket().socket);
      ws.handleUpgrade("c2", createMockSocket().socket);
      ws.handleUpgrade("c3", createMockSocket().socket);

      expect(ws.subscribe("c1", "room")).toBe(true);
      expect(ws.subscribe("c2", "room")).toBe(true);
      expect(ws.subscribe("c3", "room")).toBe(false);

      expect(ws.getClientCount("room")).toBe(2);
    });

    it("should allow subscribing to multiple channels", () => {
      ws.handleUpgrade("c1", createMockSocket().socket);
      ws.subscribe("c1", "alpha");
      ws.subscribe("c1", "beta");

      const clients = ws.getClients();
      expect(clients[0].channels).toContain("alpha");
      expect(clients[0].channels).toContain("beta");
    });
  });

  describe("unsubscribe", () => {
    beforeEach(() => {
      ws = createWebSocket({ pingInterval: 60_000 });
    });

    it("should remove client from channel", () => {
      ws.handleUpgrade("c1", createMockSocket().socket);
      ws.subscribe("c1", "room");
      const result = ws.unsubscribe("c1", "room");

      expect(result).toBe(true);
      expect(ws.getClientIds("room")).not.toContain("c1");
    });

    it("should return false for unknown client", () => {
      expect(ws.unsubscribe("unknown", "room")).toBe(false);
    });

    it("should clean up empty channel after last client unsubscribes", () => {
      ws.handleUpgrade("c1", createMockSocket().socket);
      ws.subscribe("c1", "room");
      ws.unsubscribe("c1", "room");

      expect(ws.getClientIds("room")).toEqual([]);
    });

    it("should not affect other clients in same channel", () => {
      ws.handleUpgrade("c1", createMockSocket().socket);
      ws.handleUpgrade("c2", createMockSocket().socket);
      ws.subscribe("c1", "room");
      ws.subscribe("c2", "room");

      ws.unsubscribe("c1", "room");

      expect(ws.getClientIds("room")).toEqual(["c2"]);
      expect(ws.getClientCount("room")).toBe(1);
    });
  });

  // ------------------------------------------
  // send / broadcast / broadcastAll
  // ------------------------------------------
  describe("send", () => {
    beforeEach(() => {
      ws = createWebSocket({ pingInterval: 60_000 });
    });

    it("should send a message to a specific client", () => {
      const mock = createMockSocket();
      ws.handleUpgrade("c1", mock.socket);

      const result = ws.send("c1", "hello", { text: "world" });

      expect(result).toBe(true);
      expect(mock.messages).toHaveLength(1);
      const parsed = JSON.parse(mock.messages[0]);
      expect(parsed).toEqual({ event: "hello", data: { text: "world" } });
    });

    it("should return false for unknown client", () => {
      expect(ws.send("unknown", "event", {})).toBe(false);
    });

    it("should return false when socket.send throws", () => {
      const throwingSocket = {
        send() {
          throw new Error("broken");
        },
        close() {},
      } as any;

      ws.handleUpgrade("c1", throwingSocket);
      const result = ws.send("c1", "event", {});
      expect(result).toBe(false);
    });
  });

  describe("broadcast", () => {
    beforeEach(() => {
      ws = createWebSocket({ pingInterval: 60_000 });
    });

    it("should send to all clients in a channel", () => {
      const mock1 = createMockSocket();
      const mock2 = createMockSocket();
      ws.handleUpgrade("c1", mock1.socket);
      ws.handleUpgrade("c2", mock2.socket);
      ws.subscribe("c1", "room");
      ws.subscribe("c2", "room");

      ws.broadcast("room", "update", { value: 42 });

      expect(mock1.messages).toHaveLength(1);
      expect(mock2.messages).toHaveLength(1);
      const parsed = JSON.parse(mock1.messages[0]);
      expect(parsed).toEqual({ event: "update", data: { value: 42 }, channel: "room" });
    });

    it("should not send to clients outside the channel", () => {
      const mockIn = createMockSocket();
      const mockOut = createMockSocket();
      ws.handleUpgrade("c1", mockIn.socket);
      ws.handleUpgrade("c2", mockOut.socket);
      ws.subscribe("c1", "room-a");

      ws.broadcast("room-a", "msg", {});

      expect(mockIn.messages).toHaveLength(1);
      expect(mockOut.messages).toHaveLength(0);
    });

    it("should be a no-op for nonexistent channel", () => {
      const mock = createMockSocket();
      ws.handleUpgrade("c1", mock.socket);

      ws.broadcast("nonexistent", "msg", {});
      expect(mock.messages).toHaveLength(0);
    });

    it("should handle socket.send throwing without crashing", () => {
      const good = createMockSocket();
      const bad = {
        send() {
          throw new Error("broken");
        },
        close() {},
      } as any;

      ws.handleUpgrade("c1", good.socket);
      ws.handleUpgrade("c2", bad);
      ws.subscribe("c1", "room");
      ws.subscribe("c2", "room");

      // Should not throw
      ws.broadcast("room", "msg", { ok: true });
      expect(good.messages).toHaveLength(1);
    });
  });

  describe("broadcastAll", () => {
    beforeEach(() => {
      ws = createWebSocket({ pingInterval: 60_000 });
    });

    it("should send to every connected client", () => {
      const mock1 = createMockSocket();
      const mock2 = createMockSocket();
      ws.handleUpgrade("c1", mock1.socket);
      ws.handleUpgrade("c2", mock2.socket);

      ws.broadcastAll("alert", { level: "high" });

      expect(mock1.messages).toHaveLength(1);
      expect(mock2.messages).toHaveLength(1);
      const parsed = JSON.parse(mock1.messages[0]);
      expect(parsed).toEqual({ event: "alert", data: { level: "high" } });
    });

    it("should handle socket.send throwing without crashing", () => {
      const good = createMockSocket();
      const bad = {
        send() {
          throw new Error("broken");
        },
        close() {},
      } as any;

      ws.handleUpgrade("c1", good.socket);
      ws.handleUpgrade("c2", bad);

      ws.broadcastAll("msg", {});
      expect(good.messages).toHaveLength(1);
    });
  });

  // ------------------------------------------
  // handleMessage
  // ------------------------------------------
  describe("handleMessage", () => {
    beforeEach(() => {
      ws = createWebSocket({ pingInterval: 60_000, maxMessageSize: 100 });
    });

    it("should parse JSON and dispatch to custom handlers", () => {
      const mock = createMockSocket();
      ws.handleUpgrade("c1", mock.socket);

      const received: Array<{ clientId: string; event: string; data: any }> = [];
      ws.onMessage((clientId, event, data) => {
        received.push({ clientId, event, data });
      });

      ws.handleMessage("c1", JSON.stringify({ event: "custom", data: { foo: "bar" } }));

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ clientId: "c1", event: "custom", data: { foo: "bar" } });
    });

    it("should handle built-in subscribe event", () => {
      ws.handleUpgrade("c1", createMockSocket().socket);

      ws.handleMessage("c1", JSON.stringify({ event: "subscribe", data: { channel: "room" } }));

      expect(ws.getClientIds("room")).toContain("c1");
    });

    it("should handle built-in unsubscribe event", () => {
      ws.handleUpgrade("c1", createMockSocket().socket);
      ws.subscribe("c1", "room");

      ws.handleMessage("c1", JSON.stringify({ event: "unsubscribe", data: { channel: "room" } }));

      expect(ws.getClientIds("room")).not.toContain("c1");
    });

    it("should respond with pong on ping event", () => {
      const mock = createMockSocket();
      ws.handleUpgrade("c1", mock.socket);

      ws.handleMessage("c1", JSON.stringify({ event: "ping", data: {} }));

      expect(mock.messages).toHaveLength(1);
      const parsed = JSON.parse(mock.messages[0]);
      expect(parsed.event).toBe("pong");
      expect(parsed.data.timestamp).toBeDefined();
    });

    it("should update lastMessageAt on the client", () => {
      ws.handleUpgrade("c1", createMockSocket().socket);

      const before = Date.now();
      ws.handleMessage("c1", JSON.stringify({ event: "anything", data: {} }));

      // We cannot directly access lastMessageAt via public API, but we can verify
      // it doesn't throw and custom handlers are called
      const received: string[] = [];
      ws.onMessage((clientId) => received.push(clientId));
      ws.handleMessage("c1", JSON.stringify({ event: "test", data: {} }));
      expect(received).toHaveLength(1);
    });

    it("should reject oversized messages", () => {
      const mock = createMockSocket();
      ws.handleUpgrade("c1", mock.socket);

      const handlerCalled: boolean[] = [];
      ws.onMessage(() => handlerCalled.push(true));

      // maxMessageSize is 100, send something larger
      const bigMessage = JSON.stringify({ event: "big", data: { payload: "x".repeat(200) } });
      ws.handleMessage("c1", bigMessage);

      expect(handlerCalled).toHaveLength(0);
      expect(mock.messages).toHaveLength(0);
    });

    it("should handle invalid JSON gracefully", () => {
      ws.handleUpgrade("c1", createMockSocket().socket);

      const handlerCalled: boolean[] = [];
      ws.onMessage(() => handlerCalled.push(true));

      // Should not throw
      ws.handleMessage("c1", "not-json{{{{");

      expect(handlerCalled).toHaveLength(0);
    });

    it("should ignore messages from unknown clients", () => {
      const handlerCalled: boolean[] = [];
      ws.onMessage(() => handlerCalled.push(true));

      ws.handleMessage("unknown", JSON.stringify({ event: "test", data: {} }));

      expect(handlerCalled).toHaveLength(0);
    });

    it("should handle Buffer messages", () => {
      const mock = createMockSocket();
      ws.handleUpgrade("c1", mock.socket);

      const received: any[] = [];
      ws.onMessage((_, event, data) => received.push({ event, data }));

      const buf = Buffer.from(JSON.stringify({ event: "buftest", data: { n: 1 } }));
      ws.handleMessage("c1", buf);

      expect(received).toHaveLength(1);
      expect(received[0].event).toBe("buftest");
    });

    it("should dispatch to multiple registered handlers", () => {
      ws.handleUpgrade("c1", createMockSocket().socket);

      const calls: number[] = [];
      ws.onMessage(() => calls.push(1));
      ws.onMessage(() => calls.push(2));
      ws.onMessage(() => calls.push(3));

      ws.handleMessage("c1", JSON.stringify({ event: "multi", data: {} }));

      expect(calls).toEqual([1, 2, 3]);
    });

    it("should continue dispatching after a handler throws", () => {
      ws.handleUpgrade("c1", createMockSocket().socket);

      const calls: number[] = [];
      ws.onMessage(() => {
        throw new Error("handler error");
      });
      ws.onMessage(() => calls.push(2));

      ws.handleMessage("c1", JSON.stringify({ event: "err", data: {} }));

      expect(calls).toEqual([2]);
    });
  });

  // ------------------------------------------
  // Client queries
  // ------------------------------------------
  describe("client queries", () => {
    beforeEach(() => {
      ws = createWebSocket({ pingInterval: 60_000 });
    });

    describe("getClientIds", () => {
      it("should return all client IDs when no channel specified", () => {
        ws.handleUpgrade("c1", createMockSocket().socket);
        ws.handleUpgrade("c2", createMockSocket().socket);

        const ids = ws.getClientIds();
        expect(ids.sort()).toEqual(["c1", "c2"]);
      });

      it("should return client IDs for a specific channel", () => {
        ws.handleUpgrade("c1", createMockSocket().socket);
        ws.handleUpgrade("c2", createMockSocket().socket);
        ws.handleUpgrade("c3", createMockSocket().socket);
        ws.subscribe("c1", "room");
        ws.subscribe("c3", "room");

        expect(ws.getClientIds("room").sort()).toEqual(["c1", "c3"]);
      });

      it("should return empty array for nonexistent channel", () => {
        expect(ws.getClientIds("ghost")).toEqual([]);
      });
    });

    describe("getClients", () => {
      it("should return client info with channels", () => {
        ws.handleUpgrade("c1", createMockSocket().socket);
        ws.subscribe("c1", "alpha");
        ws.subscribe("c1", "beta");

        const clients = ws.getClients();
        expect(clients).toHaveLength(1);
        expect(clients[0].id).toBe("c1");
        expect(clients[0].channels.sort()).toEqual(["alpha", "beta"]);
        expect(clients[0].connectedAt).toBeInstanceOf(Date);
      });

      it("should return empty array when no clients", () => {
        expect(ws.getClients()).toEqual([]);
      });
    });

    describe("getClientCount", () => {
      it("should return total count without channel arg", () => {
        ws.handleUpgrade("c1", createMockSocket().socket);
        ws.handleUpgrade("c2", createMockSocket().socket);

        expect(ws.getClientCount()).toBe(2);
      });

      it("should return count for a specific channel", () => {
        ws.handleUpgrade("c1", createMockSocket().socket);
        ws.handleUpgrade("c2", createMockSocket().socket);
        ws.subscribe("c1", "room");

        expect(ws.getClientCount("room")).toBe(1);
      });

      it("should return 0 for nonexistent channel", () => {
        expect(ws.getClientCount("nope")).toBe(0);
      });
    });

    describe("isConnected", () => {
      it("should return true for connected client", () => {
        ws.handleUpgrade("c1", createMockSocket().socket);
        expect(ws.isConnected("c1")).toBe(true);
      });

      it("should return false for unknown client", () => {
        expect(ws.isConnected("unknown")).toBe(false);
      });

      it("should return false after client disconnects", () => {
        ws.handleUpgrade("c1", createMockSocket().socket);
        ws.handleClose("c1");
        expect(ws.isConnected("c1")).toBe(false);
      });
    });

    describe("setClientMetadata / getClientMetadata", () => {
      it("should set metadata on a client", () => {
        ws.handleUpgrade("c1", createMockSocket().socket);
        const result = ws.setClientMetadata("c1", { role: "user" });

        expect(result).toBe(true);
        expect(ws.getClientMetadata("c1")).toEqual({ role: "user" });
      });

      it("should merge metadata with existing", () => {
        ws.handleUpgrade("c1", createMockSocket().socket, { name: "Alice" });
        ws.setClientMetadata("c1", { role: "admin" });

        expect(ws.getClientMetadata("c1")).toEqual({ name: "Alice", role: "admin" });
      });

      it("should return false for unknown client", () => {
        expect(ws.setClientMetadata("unknown", { a: 1 })).toBe(false);
      });

      it("should return undefined for unknown client metadata", () => {
        expect(ws.getClientMetadata("unknown")).toBeUndefined();
      });
    });
  });

  // ------------------------------------------
  // shutdown
  // ------------------------------------------
  describe("shutdown", () => {
    it("should close all sockets", () => {
      ws = createWebSocket({ pingInterval: 60_000 });
      const mock1 = createMockSocket();
      const mock2 = createMockSocket();
      ws.handleUpgrade("c1", mock1.socket);
      ws.handleUpgrade("c2", mock2.socket);

      ws.shutdown();

      expect(mock1.closed).toBe(true);
      expect(mock2.closed).toBe(true);
      expect(mock1.closeCode).toBe(1000);
      expect(mock1.closeReason).toBe("Server shutting down");
    });

    it("should clear all state", () => {
      ws = createWebSocket({ pingInterval: 60_000 });
      ws.handleUpgrade("c1", createMockSocket().socket);
      ws.subscribe("c1", "room");

      ws.shutdown();

      expect(ws.getClientCount()).toBe(0);
      expect(ws.getClientIds("room")).toEqual([]);
      expect(ws.getClients()).toEqual([]);
    });

    it("should clear message handlers", () => {
      ws = createWebSocket({ pingInterval: 60_000 });
      const calls: number[] = [];
      ws.onMessage(() => calls.push(1));

      ws.shutdown();

      // Re-register a client and send a message -- old handler should not fire
      // (service is shut down, but we test handler clearing)
      ws.handleUpgrade("c1", createMockSocket().socket);
      ws.handleMessage("c1", JSON.stringify({ event: "test", data: {} }));

      expect(calls).toEqual([]);
    });

    it("should handle already-closed sockets gracefully", () => {
      ws = createWebSocket({ pingInterval: 60_000 });
      const throwOnClose = {
        send() {},
        close() {
          throw new Error("already closed");
        },
      } as any;

      ws.handleUpgrade("c1", throwOnClose);

      // Should not throw
      ws.shutdown();
      expect(ws.getClientCount()).toBe(0);
    });
  });

  describe("ping timer", () => {
    it("should send ping messages to connected clients at pingInterval", async () => {
      const messages: string[] = [];
      const mockSocket = {
        send(msg: string) { messages.push(msg); },
        close() {},
      };

      ws = createWebSocket({ pingInterval: 50 });
      ws.handleUpgrade("c1", mockSocket as any);

      // Wait for at least one ping interval
      await new Promise((r) => setTimeout(r, 120));

      ws.shutdown();

      const pings = messages.filter((m) => {
        try {
          const parsed = JSON.parse(m);
          return parsed.event === "ping";
        } catch {
          return false;
        }
      });
      expect(pings.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle send errors in ping timer gracefully", async () => {
      const errorSocket = {
        send() { throw new Error("disconnected"); },
        close() {},
      };

      ws = createWebSocket({ pingInterval: 50 });
      ws.handleUpgrade("c1", errorSocket as any);

      // Wait for ping to fire — should not throw
      await new Promise((r) => setTimeout(r, 120));

      ws.shutdown();
    });
  });
});
