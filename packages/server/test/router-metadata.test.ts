import { describe, it, expect } from "bun:test";
import { createRouter } from "../src/router";
import { z } from "zod";

/**
 * Router Metadata Tests
 *
 * Tests that router correctly exports route metadata including handler types
 */

describe("Router Metadata", () => {
  describe("getRoutes", () => {
    it("should return typed routes with handler='typed'", () => {
      const router = createRouter("api")
        .route("users.list").typed({
          input: z.object({ page: z.number() }),
          output: z.array(z.object({ id: z.string() })),
          handle: async (input) => [{ id: "1" }],
        });

      const routes = router.getRoutes();

      expect(routes).toHaveLength(1);
      expect(routes[0].name).toBe("api.users.list");
      expect(routes[0].handler).toBe("typed");
    });

    it("should return raw routes with handler='raw'", () => {
      const router = createRouter("api")
        .route("webhook").raw({
          handle: async (req) => new Response("ok"),
        });

      const routes = router.getRoutes();

      expect(routes).toHaveLength(1);
      expect(routes[0].name).toBe("api.webhook");
      expect(routes[0].handler).toBe("raw");
    });

    it("should correctly identify mixed typed and raw routes", () => {
      const router = createRouter("api")
        .route("users.list").typed({
          input: z.object({}),
          handle: async () => [],
        })
        .route("users.avatar").raw({
          handle: async (req) => new Response("image"),
        })
        .route("users.create").typed({
          input: z.object({ name: z.string() }),
          handle: async (input) => ({ id: "1" }),
        })
        .route("files.stream").raw({
          handle: async (req) => new Response("stream"),
        });

      const routes = router.getRoutes();

      expect(routes).toHaveLength(4);

      const typedRoutes = routes.filter((r) => r.handler === "typed");
      const rawRoutes = routes.filter((r) => r.handler === "raw");

      expect(typedRoutes).toHaveLength(2);
      expect(rawRoutes).toHaveLength(2);

      expect(typedRoutes.map((r) => r.name)).toContain("api.users.list");
      expect(typedRoutes.map((r) => r.name)).toContain("api.users.create");
      expect(rawRoutes.map((r) => r.name)).toContain("api.users.avatar");
      expect(rawRoutes.map((r) => r.name)).toContain("api.files.stream");
    });
  });

  describe("getTypedMetadata", () => {
    it("should include handler type in metadata for typed routes", () => {
      const router = createRouter("api")
        .route("ping").typed({
          input: z.object({}),
          handle: async () => ({ pong: true }),
        });

      const metadata = router.getTypedMetadata();

      expect(metadata).toHaveLength(1);
      expect(metadata[0].name).toBe("api.ping");
      expect(metadata[0].handler).toBe("typed");
    });

    it("should include handler type in metadata for raw routes", () => {
      const router = createRouter("api")
        .route("stream").raw({
          handle: async (req) => new Response("data"),
        });

      const metadata = router.getTypedMetadata();

      expect(metadata).toHaveLength(1);
      expect(metadata[0].name).toBe("api.stream");
      expect(metadata[0].handler).toBe("raw");
    });

    it("should preserve handler types for all routes in metadata", () => {
      const router = createRouter("api")
        .route("data.list").typed({
          input: z.object({}),
          handle: async () => [],
        })
        .route("data.export").raw({
          handle: async (req) => new Response("csv"),
        })
        .route("webhooks.stripe").raw({
          handle: async (req) => new Response("ok"),
        })
        .route("users.create").typed({
          input: z.object({ email: z.string() }),
          handle: async (input) => ({ id: "1" }),
        });

      const metadata = router.getTypedMetadata();

      expect(metadata).toHaveLength(4);

      const typedMeta = metadata.filter((m) => m.handler === "typed");
      const rawMeta = metadata.filter((m) => m.handler === "raw");

      expect(typedMeta).toHaveLength(2);
      expect(rawMeta).toHaveLength(2);

      expect(typedMeta.map((m) => m.name)).toContain("api.data.list");
      expect(typedMeta.map((m) => m.name)).toContain("api.users.create");
      expect(rawMeta.map((m) => m.name)).toContain("api.data.export");
      expect(rawMeta.map((m) => m.name)).toContain("api.webhooks.stripe");
    });
  });

  describe("nested routers", () => {
    it("should preserve handler types in nested routers", () => {
      const childRouter = createRouter("child")
        .route("typed-route").typed({
          input: z.object({}),
          handle: async () => ({}),
        })
        .route("raw-route").raw({
          handle: async (req) => new Response("ok"),
        });

      const parentRouter = createRouter("parent").router(childRouter);

      const routes = parentRouter.getRoutes();

      expect(routes).toHaveLength(2);

      const typedRoute = routes.find((r) => r.name === "parent.child.typed-route");
      const rawRoute = routes.find((r) => r.name === "parent.child.raw-route");

      expect(typedRoute?.handler).toBe("typed");
      expect(rawRoute?.handler).toBe("raw");
    });
  });
});
