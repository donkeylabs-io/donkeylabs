import { describe, it, expect } from "bun:test";
import { createRouter } from "../src/router";
import { StreamHandler } from "../src/handlers";
import { z } from "zod";

/**
 * Stream Handler Tests
 *
 * Tests for the stream handler which validates input like typed
 * but returns Response directly like raw (for streaming/binary data).
 */

describe("Stream Handler", () => {
  describe("router integration", () => {
    it("should register stream routes with handler='stream'", () => {
      const router = createRouter("api")
        .route("files.download").stream({
          input: z.object({ fileId: z.string() }),
          handle: async (input, ctx) => {
            return new Response(`File: ${input.fileId}`);
          },
        });

      const routes = router.getRoutes();

      expect(routes).toHaveLength(1);
      expect(routes[0].name).toBe("api.files.download");
      expect(routes[0].handler).toBe("stream");
      expect(routes[0].input).toBeDefined();
    });

    it("should support stream routes without input schema", () => {
      const router = createRouter("api")
        .route("stream").stream({
          handle: async (input, ctx) => {
            return new Response("streaming...");
          },
        });

      const routes = router.getRoutes();

      expect(routes).toHaveLength(1);
      expect(routes[0].handler).toBe("stream");
      expect(routes[0].input).toBeUndefined();
    });

    it("should handle mixed typed, raw, and stream routes", () => {
      const router = createRouter("api")
        .route("data.list").typed({
          input: z.object({}),
          handle: async () => [],
        })
        .route("data.export").raw({
          handle: async (req) => new Response("csv"),
        })
        .route("data.stream").stream({
          input: z.object({ format: z.string() }),
          handle: async (input) => new Response(`streaming ${input.format}`),
        });

      const routes = router.getRoutes();

      expect(routes).toHaveLength(3);

      const typedRoutes = routes.filter((r) => r.handler === "typed");
      const rawRoutes = routes.filter((r) => r.handler === "raw");
      const streamRoutes = routes.filter((r) => r.handler === "stream");

      expect(typedRoutes).toHaveLength(1);
      expect(rawRoutes).toHaveLength(1);
      expect(streamRoutes).toHaveLength(1);

      expect(streamRoutes[0].name).toBe("api.data.stream");
    });
  });

  describe("StreamHandler.execute", () => {
    const mockCtx = {} as any;

    it("should accept GET requests with query params", async () => {
      const req = new Request("http://localhost/test?name=test", { method: "GET" });
      const def = { input: z.object({ name: z.string() }) };
      let receivedInput: any;
      const handle = async (input: any) => {
        receivedInput = input;
        return new Response("ok");
      };

      const response = await StreamHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(200);
      expect(receivedInput).toEqual({ name: "test" });
    });

    it("should reject non-GET/POST requests (e.g., DELETE)", async () => {
      const req = new Request("http://localhost/test", { method: "DELETE" });
      const def = { input: z.object({}) };
      const handle = async () => new Response("ok");

      const response = await StreamHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(405);
      expect(await response.text()).toBe("Method Not Allowed");
    });

    it("should reject invalid JSON", async () => {
      const req = new Request("http://localhost/test", {
        method: "POST",
        body: "invalid json",
        headers: { "Content-Type": "application/json" },
      });
      const def = { input: z.object({}) };
      const handle = async () => new Response("ok");

      const response = await StreamHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid JSON");
    });

    it("should validate input with Zod schema", async () => {
      const req = new Request("http://localhost/test", {
        method: "POST",
        body: JSON.stringify({ wrong: "field" }),
        headers: { "Content-Type": "application/json" },
      });
      const def = {
        input: z.object({ fileId: z.string() }),
      };
      const handle = async () => new Response("ok");

      const response = await StreamHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Validation Failed");
      expect(body.details).toBeDefined();
    });

    it("should pass validated input to handler", async () => {
      let receivedInput: any;
      const req = new Request("http://localhost/test", {
        method: "POST",
        body: JSON.stringify({ fileId: "abc123", format: "mp4" }),
        headers: { "Content-Type": "application/json" },
      });
      const def = {
        input: z.object({ fileId: z.string(), format: z.string() }),
      };
      const handle = async (input: any) => {
        receivedInput = input;
        return new Response("ok");
      };

      await StreamHandler.execute(req, def as any, handle, mockCtx);

      expect(receivedInput).toEqual({ fileId: "abc123", format: "mp4" });
    });

    it("should return Response directly without output validation", async () => {
      const req = new Request("http://localhost/test", {
        method: "POST",
        body: JSON.stringify({ id: "123" }),
        headers: { "Content-Type": "application/json" },
      });
      const def = {
        input: z.object({ id: z.string() }),
      };

      // Return a streaming response
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk1"));
          controller.enqueue(new TextEncoder().encode("chunk2"));
          controller.close();
        },
      });

      const handle = async () =>
        new Response(stream, {
          headers: { "Content-Type": "application/octet-stream" },
        });

      const response = await StreamHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
      const text = await response.text();
      expect(text).toBe("chunk1chunk2");
    });

    it("should work without input schema (pass body as-is)", async () => {
      let receivedInput: any;
      const req = new Request("http://localhost/test", {
        method: "POST",
        body: JSON.stringify({ anything: "goes" }),
        headers: { "Content-Type": "application/json" },
      });
      const def = {}; // No input schema
      const handle = async (input: any) => {
        receivedInput = input;
        return new Response("ok");
      };

      await StreamHandler.execute(req, def as any, handle, mockCtx);

      expect(receivedInput).toEqual({ anything: "goes" });
    });

    it("should handle errors with status codes", async () => {
      const req = new Request("http://localhost/test", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });
      const def = {};
      const handle = async () => {
        const error = new Error("Not Found") as any;
        error.status = 404;
        throw error;
      };

      const response = await StreamHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("Not Found");
    });

    it("should handle binary data responses", async () => {
      const req = new Request("http://localhost/test", {
        method: "POST",
        body: JSON.stringify({ imageId: "abc" }),
        headers: { "Content-Type": "application/json" },
      });
      const def = {
        input: z.object({ imageId: z.string() }),
      };

      // Return binary data
      const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
      const handle = async () =>
        new Response(binaryData, {
          headers: { "Content-Type": "image/png" },
        });

      const response = await StreamHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/png");
      const buffer = await response.arrayBuffer();
      expect(new Uint8Array(buffer)).toEqual(binaryData);
    });
  });

  describe("getMetadata", () => {
    it("should include stream handler type in metadata", () => {
      const router = createRouter("api")
        .route("video.stream").stream({
          input: z.object({ videoId: z.string() }),
          handle: async (input) => new Response("video data"),
        });

      const metadata = router.getMetadata();

      expect(metadata).toHaveLength(1);
      expect(metadata[0].name).toBe("api.video.stream");
      expect(metadata[0].handler).toBe("stream");
    });

    it("should include stream routes in getTypedMetadata", () => {
      const router = createRouter("api")
        .route("media.stream").stream({
          input: z.object({ id: z.string() }),
          handle: async (input) => new Response("data"),
        });

      const typedMetadata = router.getTypedMetadata();

      expect(typedMetadata).toHaveLength(1);
      expect(typedMetadata[0].name).toBe("api.media.stream");
      expect(typedMetadata[0].handler).toBe("stream");
      expect(typedMetadata[0].inputType).toBeDefined();
    });
  });

  describe("nested routers", () => {
    it("should preserve stream handler type in nested routers", () => {
      const childRouter = createRouter("child")
        .route("typed-route").typed({
          input: z.object({}),
          handle: async () => ({}),
        })
        .route("stream-route").stream({
          input: z.object({ id: z.string() }),
          handle: async (input) => new Response("ok"),
        })
        .route("raw-route").raw({
          handle: async (req) => new Response("ok"),
        });

      const parentRouter = createRouter("parent").router(childRouter);

      const routes = parentRouter.getRoutes();

      expect(routes).toHaveLength(3);

      const typedRoute = routes.find((r) => r.name === "parent.child.typed-route");
      const streamRoute = routes.find((r) => r.name === "parent.child.stream-route");
      const rawRoute = routes.find((r) => r.name === "parent.child.raw-route");

      expect(typedRoute?.handler).toBe("typed");
      expect(streamRoute?.handler).toBe("stream");
      expect(rawRoute?.handler).toBe("raw");
    });
  });

  describe("streaming integration", () => {
    it("should stream chunks incrementally to client", async () => {
      const chunks = ["chunk1", "chunk2", "chunk3", "chunk4", "chunk5"];
      const receivedChunks: string[] = [];

      // Create a streaming response
      const stream = new ReadableStream({
        async start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk + "\n"));
            // Small delay to simulate real streaming
            await new Promise((r) => setTimeout(r, 10));
          }
          controller.close();
        },
      });

      const def = { input: z.object({}) };
      const handle = async () =>
        new Response(stream, {
          headers: { "Content-Type": "text/plain" },
        });

      const req = new Request("http://localhost/test", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });

      const response = await StreamHandler.execute(req, def as any, handle, {} as any);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/plain");

      // Read the stream incrementally
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedChunks.push(decoder.decode(value));
      }

      // Verify all chunks arrived
      const allData = receivedChunks.join("");
      expect(allData).toBe("chunk1\nchunk2\nchunk3\nchunk4\nchunk5\n");
    });

    it("should handle continuous stream with abort signal", async () => {
      let streamCancelled = false;
      const receivedChunks: string[] = [];

      // Create an infinite-ish stream (simulates MJPEG or similar)
      const stream = new ReadableStream({
        async pull(controller) {
          // Send a frame every 10ms
          controller.enqueue(new TextEncoder().encode("frame\n"));
          await new Promise((r) => setTimeout(r, 10));
        },
        cancel() {
          streamCancelled = true;
        },
      });

      const def = { input: z.object({}) };
      const handle = async () =>
        new Response(stream, {
          headers: { "Content-Type": "multipart/x-mixed-replace" },
        });

      const req = new Request("http://localhost/test", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });

      const response = await StreamHandler.execute(req, def as any, handle, {} as any);

      expect(response.status).toBe(200);

      // Read a few chunks then cancel
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      for (let i = 0; i < 5; i++) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedChunks.push(decoder.decode(value));
      }

      // Cancel the stream (simulates client disconnect)
      await reader.cancel();

      // Verify we got some data
      expect(receivedChunks.length).toBeGreaterThanOrEqual(5);
      expect(receivedChunks[0]).toBe("frame\n");

      // Verify stream was cancelled
      // Give it a moment to propagate
      await new Promise((r) => setTimeout(r, 50));
      expect(streamCancelled).toBe(true);
    });

    it("should stream large binary data", async () => {
      // Create 1MB of random binary data
      const size = 1024 * 1024;
      const originalData = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        originalData[i] = i % 256;
      }

      // Stream it in 64KB chunks
      const chunkSize = 64 * 1024;
      const stream = new ReadableStream({
        start(controller) {
          let offset = 0;
          const pushChunk = () => {
            if (offset >= size) {
              controller.close();
              return;
            }
            const chunk = originalData.slice(offset, offset + chunkSize);
            controller.enqueue(chunk);
            offset += chunkSize;
            // Use setTimeout to simulate async chunking
            setTimeout(pushChunk, 0);
          };
          pushChunk();
        },
      });

      const def = { input: z.object({}) };
      const handle = async () =>
        new Response(stream, {
          headers: { "Content-Type": "application/octet-stream" },
        });

      const req = new Request("http://localhost/test", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });

      const response = await StreamHandler.execute(req, def as any, handle, {} as any);

      // Collect all chunks
      const chunks: Uint8Array[] = [];
      const reader = response.body!.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      // Combine and verify
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      expect(totalLength).toBe(size);

      const received = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        received.set(chunk, offset);
        offset += chunk.length;
      }

      // Verify data integrity
      expect(received).toEqual(originalData);
    });

    it("should handle GET request with query params for streaming", async () => {
      let receivedInput: any;

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("video data"));
          controller.close();
        },
      });

      const def = {
        input: z.object({
          videoId: z.string(),
          quality: z.string(),
        }),
      };

      const handle = async (input: any) => {
        receivedInput = input;
        return new Response(stream, {
          headers: { "Content-Type": "video/mp4" },
        });
      };

      // GET request with query params (like <video src="...">)
      const req = new Request(
        "http://localhost/test?videoId=abc123&quality=1080p",
        { method: "GET" }
      );

      const response = await StreamHandler.execute(req, def as any, handle, {} as any);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("video/mp4");
      expect(receivedInput).toEqual({ videoId: "abc123", quality: "1080p" });

      const text = await response.text();
      expect(text).toBe("video data");
    });
  });
});
