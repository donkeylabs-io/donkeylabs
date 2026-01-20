import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppServer } from "../src/server";
import { createRouter } from "../src/router";
import { z } from "zod";
import Database from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";

/**
 * End-to-End Streaming Tests
 *
 * These tests spin up a real HTTP server and verify streaming
 * works correctly over the network.
 */

describe("Stream E2E", () => {
  let server: AppServer;
  let baseUrl: string;
  const port = 9876; // Use a high port to avoid conflicts

  beforeAll(async () => {
    const sqlite = new Database(":memory:");
    const db = new Kysely<any>({
      dialect: new BunSqliteDialect({ database: sqlite }),
    });

    const router = createRouter("api")
      .route("stream.chunks").stream({
        input: z.object({ count: z.number() }),
        handle: async (input) => {
          const stream = new ReadableStream({
            async start(controller) {
              for (let i = 0; i < input.count; i++) {
                controller.enqueue(new TextEncoder().encode(`chunk-${i}\n`));
                await new Promise((r) => setTimeout(r, 20));
              }
              controller.close();
            },
          });
          return new Response(stream, {
            headers: { "Content-Type": "text/plain" },
          });
        },
      })
      .route("stream.continuous").stream({
        input: z.object({}),
        handle: async () => {
          // Simulate continuous stream (like MJPEG)
          const stream = new ReadableStream({
            async pull(controller) {
              controller.enqueue(new TextEncoder().encode(`frame-${Date.now()}\n`));
              await new Promise((r) => setTimeout(r, 50));
            },
          });
          return new Response(stream, {
            headers: { "Content-Type": "multipart/x-mixed-replace; boundary=frame" },
          });
        },
      })
      .route("stream.binary").stream({
        input: z.object({ size: z.number() }),
        handle: async (input) => {
          const data = new Uint8Array(input.size);
          for (let i = 0; i < input.size; i++) {
            data[i] = i % 256;
          }
          return new Response(data, {
            headers: { "Content-Type": "application/octet-stream" },
          });
        },
      })
      .route("stream.video").stream({
        input: z.object({ id: z.string() }),
        handle: async (input) => {
          // Simulate video chunks
          const stream = new ReadableStream({
            async start(controller) {
              for (let i = 0; i < 10; i++) {
                const frame = new Uint8Array(1024).fill(i);
                controller.enqueue(frame);
                await new Promise((r) => setTimeout(r, 10));
              }
              controller.close();
            },
          });
          return new Response(stream, {
            headers: {
              "Content-Type": "video/mp4",
              "X-Video-Id": input.id,
            },
          });
        },
      });

    server = new AppServer({ db, port });
    server.use(router);
    await server.start();
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await server.shutdown();
  });

  it("should stream text chunks via POST", async () => {
    const response = await fetch(`${baseUrl}/api.stream.chunks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: 5 }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain");

    const chunks: string[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    const text = chunks.join("");
    expect(text).toContain("chunk-0");
    expect(text).toContain("chunk-4");
    expect(text.split("\n").filter(Boolean)).toHaveLength(5);
  });

  it("should stream text chunks via GET with query params", async () => {
    const response = await fetch(`${baseUrl}/api.stream.chunks?count=3`, {
      method: "GET",
    });

    expect(response.status).toBe(200);

    const text = await response.text();
    expect(text).toBe("chunk-0\nchunk-1\nchunk-2\n");
  });

  it("should handle continuous stream with client abort", async () => {
    const controller = new AbortController();
    const chunks: string[] = [];

    const response = await fetch(`${baseUrl}/api.stream.continuous`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("multipart/x-mixed-replace");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    // Read 5 frames then abort
    for (let i = 0; i < 5; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    // Abort the request
    controller.abort();

    expect(chunks.length).toBe(5);
    expect(chunks[0]).toContain("frame-");
  });

  it("should stream binary data", async () => {
    const size = 10240; // 10KB
    const response = await fetch(`${baseUrl}/api.stream.binary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");

    const buffer = await response.arrayBuffer();
    expect(buffer.byteLength).toBe(size);

    // Verify data integrity
    const data = new Uint8Array(buffer);
    for (let i = 0; i < size; i++) {
      expect(data[i]).toBe(i % 256);
    }
  });

  it("should stream video via GET (browser video element simulation)", async () => {
    // Simulates: <video src="/api.stream.video?id=test123">
    const response = await fetch(`${baseUrl}/api.stream.video?id=test123`, {
      method: "GET",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("X-Video-Id")).toBe("test123");

    // Verify we received video frames
    const buffer = await response.arrayBuffer();
    expect(buffer.byteLength).toBe(10 * 1024); // 10 frames * 1024 bytes
  });

  it("should handle multiple concurrent streams", async () => {
    const requests = [
      fetch(`${baseUrl}/api.stream.chunks?count=3`),
      fetch(`${baseUrl}/api.stream.chunks?count=5`),
      fetch(`${baseUrl}/api.stream.chunks?count=2`),
    ];

    const responses = await Promise.all(requests);

    expect(responses[0].status).toBe(200);
    expect(responses[1].status).toBe(200);
    expect(responses[2].status).toBe(200);

    const texts = await Promise.all(responses.map((r) => r.text()));

    expect(texts[0].split("\n").filter(Boolean)).toHaveLength(3);
    expect(texts[1].split("\n").filter(Boolean)).toHaveLength(5);
    expect(texts[2].split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("should return validation error for invalid input", async () => {
    const response = await fetch(`${baseUrl}/api.stream.chunks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: "not a number" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Validation Failed");
  });
});
