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
});
