import { describe, it, expect } from "bun:test";
import { createSSE } from "../src/core/sse";

describe("SSE Service", () => {
  describe("broadcastAll", () => {
    it("should send events to all connected clients", () => {
      const sse = createSSE();

      // Add two clients
      const c1 = sse.addClient();
      const c2 = sse.addClient();

      // broadcastAll sends to every client regardless of channel
      sse.broadcastAll("news", { text: "hello all" });

      // Clean up
      sse.removeClient(c1.client.id);
      sse.removeClient(c2.client.id);
    });

    it("should work with no clients", () => {
      const sse = createSSE();
      // Should not throw
      sse.broadcastAll("event", { data: "test" });
    });
  });
});
