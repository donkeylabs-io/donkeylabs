import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createSSE, type SSE } from "../src/core/sse";

/**
 * SSE Heartbeat Tests
 *
 * Tests to verify SSE connections don't timeout due to missing heartbeats.
 * These tests ensure:
 * 1. Immediate heartbeat is sent on client connect
 * 2. Regular heartbeats are sent at the configured interval
 * 3. Heartbeat format is correct for SSE spec
 */

describe("SSE Heartbeat", () => {
  let sse: SSE;

  afterEach(() => {
    sse?.shutdown();
  });

  describe("immediate heartbeat on connect", () => {
    it("should send retry directive and heartbeat immediately on connect", async () => {
      sse = createSSE({ heartbeatInterval: 60000 }); // Long interval to isolate initial data

      const { response } = sse.addClient();
      const reader = response.body!.getReader();

      // Read initial chunks sent on connect (may be split across reads)
      let allText = "";
      for (let i = 0; i < 3; i++) {
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 50)
        );
        const result = await Promise.race([readPromise, timeoutPromise]);
        if (result.done || !result.value) break;
        allText += new TextDecoder().decode(result.value);
      }

      // Should contain retry directive
      expect(allText).toContain("retry:");

      // Should contain immediate heartbeat
      expect(allText).toContain(": heartbeat");

      reader.cancel();
    });

    it("should send heartbeat before first interval elapses", async () => {
      sse = createSSE({ heartbeatInterval: 5000 }); // 5 second interval

      const { response } = sse.addClient();
      const reader = response.body!.getReader();

      // Read all initial data within a short timeout
      let allText = "";
      const startTime = Date.now();
      while (Date.now() - startTime < 200) {
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 50)
        );
        const result = await Promise.race([readPromise, timeoutPromise]);
        if (result.done || !result.value) break;
        allText += new TextDecoder().decode(result.value);
        if (allText.includes(": heartbeat")) break;
      }

      // Should have received heartbeat within 200ms (not waiting for 5s interval)
      expect(allText).toContain(": heartbeat");

      reader.cancel();
    });
  });

  describe("heartbeat format", () => {
    it("should use SSE comment format for heartbeat", async () => {
      sse = createSSE({ heartbeatInterval: 60000 });

      const { response } = sse.addClient();
      const reader = response.body!.getReader();

      // Read all initial chunks
      let allText = "";
      for (let i = 0; i < 3; i++) {
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 50)
        );
        const result = await Promise.race([readPromise, timeoutPromise]);
        if (result.done || !result.value) break;
        allText += new TextDecoder().decode(result.value);
      }

      // Heartbeat should be an SSE comment (starts with :)
      // Format: `: heartbeat <timestamp>\n\n`
      const heartbeatMatch = allText.match(/: heartbeat \d+\n\n/);
      expect(heartbeatMatch).not.toBeNull();

      reader.cancel();
    });

    it("should include timestamp in heartbeat", async () => {
      sse = createSSE({ heartbeatInterval: 60000 });
      const beforeConnect = Date.now();

      const { response } = sse.addClient();
      const reader = response.body!.getReader();

      // Read all initial chunks
      let allText = "";
      for (let i = 0; i < 3; i++) {
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 50)
        );
        const result = await Promise.race([readPromise, timeoutPromise]);
        if (result.done || !result.value) break;
        allText += new TextDecoder().decode(result.value);
      }

      const afterConnect = Date.now();

      // Extract timestamp from heartbeat
      const match = allText.match(/: heartbeat (\d+)/);
      expect(match).not.toBeNull();

      const timestamp = parseInt(match![1], 10);
      expect(timestamp).toBeGreaterThanOrEqual(beforeConnect);
      expect(timestamp).toBeLessThanOrEqual(afterConnect);

      reader.cancel();
    });
  });

  describe("periodic heartbeats", () => {
    it("should send heartbeats at configured interval", async () => {
      // Use short interval for test
      sse = createSSE({ heartbeatInterval: 100 }); // 100ms

      const { response } = sse.addClient();
      const reader = response.body!.getReader();

      // Drain initial data (retry + immediate heartbeat)
      let initialText = "";
      for (let i = 0; i < 3; i++) {
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 20)
        );
        const result = await Promise.race([readPromise, timeoutPromise]);
        if (result.done || !result.value) break;
        initialText += new TextDecoder().decode(result.value);
      }

      // Now wait for the periodic heartbeat (not the immediate one)
      const startTime = Date.now();
      const { value } = await reader.read();
      const elapsed = Date.now() - startTime;

      // Should receive heartbeat around 100ms (with tolerance for timing variations)
      expect(elapsed).toBeGreaterThanOrEqual(50);
      expect(elapsed).toBeLessThan(200);

      const text = new TextDecoder().decode(value);
      expect(text).toContain(": heartbeat");

      reader.cancel();
    });

    it("should send multiple heartbeats over time", async () => {
      sse = createSSE({ heartbeatInterval: 50 }); // 50ms

      const { response } = sse.addClient();
      const reader = response.body!.getReader();

      // Collect all heartbeats over 250ms
      let heartbeatCount = 0;
      const startTime = Date.now();

      while (Date.now() - startTime < 250) {
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 100)
        );

        const result = await Promise.race([readPromise, timeoutPromise]);
        if (result && !result.done && result.value) {
          const text = new TextDecoder().decode(result.value);
          // Count heartbeats (there may be multiple per chunk or multiple chunks)
          const matches = text.match(/: heartbeat/g);
          if (matches) {
            heartbeatCount += matches.length;
          }
        }
      }

      // Should have received multiple heartbeats:
      // 1 immediate + ~4-5 periodic in 250ms with 50ms interval
      expect(heartbeatCount).toBeGreaterThanOrEqual(3);

      reader.cancel();
    });
  });

  describe("heartbeat keeps connection alive", () => {
    it("should keep client in clients list while receiving heartbeats", async () => {
      sse = createSSE({ heartbeatInterval: 50 });

      const { client, response } = sse.addClient();
      const reader = response.body!.getReader();

      // Verify client is registered
      expect(sse.getClients()).toHaveLength(1);
      expect(sse.getClient(client.id)).toBeDefined();

      // Read initial + a few heartbeats
      await reader.read();
      await reader.read();
      await reader.read();

      // Client should still be registered
      expect(sse.getClients()).toHaveLength(1);
      expect(sse.getClient(client.id)).toBeDefined();

      reader.cancel();
    });

    it("should remove client when stream is cancelled", async () => {
      sse = createSSE({ heartbeatInterval: 50 });

      const { client, response } = sse.addClient();
      const reader = response.body!.getReader();

      expect(sse.getClients()).toHaveLength(1);

      // Cancel the stream (simulates client disconnect)
      await reader.cancel();

      // Give cleanup a moment to process
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Client should be removed
      expect(sse.getClients()).toHaveLength(0);
      expect(sse.getClient(client.id)).toBeUndefined();
    });
  });

  describe("retry directive", () => {
    it("should send retry directive with configured interval", async () => {
      sse = createSSE({ heartbeatInterval: 60000, retryInterval: 5000 });

      const { response } = sse.addClient();
      const reader = response.body!.getReader();

      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);

      // Should contain retry directive with configured value
      expect(text).toContain("retry: 5000");

      reader.cancel();
    });

    it("should use default retry interval of 3000ms", async () => {
      sse = createSSE({ heartbeatInterval: 60000 }); // Only set heartbeat, not retry

      const { response } = sse.addClient();
      const reader = response.body!.getReader();

      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);

      // Default retry should be 3000ms
      expect(text).toContain("retry: 3000");

      reader.cancel();
    });
  });
});
