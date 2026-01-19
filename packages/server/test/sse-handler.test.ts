import { describe, it, expect, mock } from "bun:test";
import { createRouter } from "../src/router";
import { SSEHandler } from "../src/handlers";
import { z } from "zod";

/**
 * SSE Handler Tests
 *
 * Tests for the SSE handler which creates Server-Sent Events connections
 * with validated input and channel subscription.
 */

describe("SSE Handler", () => {
  describe("router integration", () => {
    it("should register SSE routes with handler='sse'", () => {
      const router = createRouter("api")
        .route("notifications.subscribe").sse({
          input: z.object({ userId: z.string() }),
          handle: (input) => [`user:${input.userId}`, "global"],
        });

      const routes = router.getRoutes();

      expect(routes).toHaveLength(1);
      expect(routes[0].name).toBe("api.notifications.subscribe");
      expect(routes[0].handler).toBe("sse");
      expect(routes[0].input).toBeDefined();
    });

    it("should support SSE routes without input schema", () => {
      const router = createRouter("api")
        .route("events").sse({
          handle: () => ["global"],
        });

      const routes = router.getRoutes();

      expect(routes).toHaveLength(1);
      expect(routes[0].handler).toBe("sse");
      expect(routes[0].input).toBeUndefined();
    });
  });

  describe("SSEHandler.execute", () => {
    // Create a mock context with SSE service
    const createMockCtx = () => {
      const clients = new Map<string, { channels: Set<string> }>();
      let clientId = 0;

      return {
        core: {
          sse: {
            addClient: mock((options?: { lastEventId?: string }) => {
              const id = `sse_${++clientId}`;
              const client = { id, channels: new Set<string>() };
              clients.set(id, client);

              const stream = new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("retry: 3000\n\n"));
                },
              });

              return {
                client,
                response: new Response(stream, {
                  headers: {
                    "Content-Type": "text/event-stream",
                    "X-SSE-Client-Id": id,
                  },
                }),
              };
            }),
            subscribe: mock((clientId: string, channel: string) => {
              const client = clients.get(clientId);
              if (client) {
                client.channels.add(channel);
                return true;
              }
              return false;
            }),
          },
        },
        clients, // Expose for assertions
      } as any;
    };

    it("should accept GET requests", async () => {
      const mockCtx = createMockCtx();
      const req = new Request("http://localhost/test?userId=abc", { method: "GET" });
      const def = { input: z.object({ userId: z.string() }) };
      const handle = (input: any) => [`user:${input.userId}`];

      const response = await SSEHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    });

    it("should accept POST requests with JSON body", async () => {
      const mockCtx = createMockCtx();
      const req = new Request("http://localhost/test", {
        method: "POST",
        body: JSON.stringify({ userId: "abc" }),
        headers: { "Content-Type": "application/json" },
      });
      const def = { input: z.object({ userId: z.string() }) };
      const handle = (input: any) => [`user:${input.userId}`];

      const response = await SSEHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    });

    it("should reject non-GET/POST methods", async () => {
      const mockCtx = createMockCtx();
      const req = new Request("http://localhost/test", { method: "PUT" });
      const def = {};
      const handle = () => ["global"];

      const response = await SSEHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(405);
    });

    it("should validate input from query params", async () => {
      const mockCtx = createMockCtx();
      const req = new Request("http://localhost/test?wrong=field", { method: "GET" });
      const def = { input: z.object({ userId: z.string() }) };
      const handle = (input: any) => [`user:${input.userId}`];

      const response = await SSEHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Validation Failed");
    });

    it("should subscribe to channels returned by handler", async () => {
      const mockCtx = createMockCtx();
      const req = new Request("http://localhost/test?userId=user123", { method: "GET" });
      const def = { input: z.object({ userId: z.string() }) };
      const handle = (input: any) => [`user:${input.userId}`, "global", "announcements"];

      await SSEHandler.execute(req, def as any, handle, mockCtx);

      expect(mockCtx.core.sse.subscribe).toHaveBeenCalledTimes(3);
    });

    it("should pass Last-Event-ID header to addClient", async () => {
      const mockCtx = createMockCtx();
      const req = new Request("http://localhost/test", {
        method: "GET",
        headers: { "Last-Event-ID": "event_123" },
      });
      const def = {};
      const handle = () => ["global"];

      await SSEHandler.execute(req, def as any, handle, mockCtx);

      expect(mockCtx.core.sse.addClient).toHaveBeenCalledWith({
        lastEventId: "event_123",
      });
    });

    it("should parse JSON values in query params", async () => {
      const mockCtx = createMockCtx();
      const req = new Request("http://localhost/test?count=5&active=true", { method: "GET" });
      const def = { input: z.object({ count: z.number(), active: z.boolean() }) };
      let receivedInput: any;
      const handle = (input: any) => {
        receivedInput = input;
        return ["channel"];
      };

      await SSEHandler.execute(req, def as any, handle, mockCtx);

      expect(receivedInput).toEqual({ count: 5, active: true });
    });
  });

  describe("getMetadata", () => {
    it("should include SSE handler type in metadata", () => {
      const router = createRouter("api")
        .route("events.subscribe").sse({
          input: z.object({ channel: z.string() }),
          handle: (input) => [input.channel],
        });

      const metadata = router.getMetadata();

      expect(metadata).toHaveLength(1);
      expect(metadata[0].name).toBe("api.events.subscribe");
      expect(metadata[0].handler).toBe("sse");
    });
  });
});
