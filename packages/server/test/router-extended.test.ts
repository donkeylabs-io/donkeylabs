import { describe, it, expect } from "bun:test";
import { Router } from "../src/router";
import { z } from "zod";

describe("Router", () => {
  describe("getPrefix", () => {
    it("should return the router prefix", () => {
      const router = new Router("users");
      expect(router.getPrefix()).toBe("users");
    });

    it("should return empty string for no prefix", () => {
      const router = new Router();
      expect(router.getPrefix()).toBe("");
    });
  });

  describe("middleware builder proxy", () => {
    it("should add middleware to the stack via proxy", () => {
      const router = new Router("api");

      // Access middleware builder and call a middleware method
      const result = router.middleware.authRequired();

      // Should return the router for chaining
      expect(result).toBe(router);

      // Routes defined after middleware should include it
      router.route("list").typed({
        input: z.object({}),
        handle: async () => ({ items: [] }),
      });

      const routes = router.getRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].middleware).toHaveLength(1);
      expect(routes[0].middleware![0].name).toBe("authRequired");
    });

    it("should support middleware with config", () => {
      const router = new Router("api");

      router.middleware.rateLimited({ limit: 100, windowMs: 60000 });

      router.route("action").typed({
        input: z.object({}),
        handle: async () => ({}),
      });

      const routes = router.getRoutes();
      expect(routes[0].middleware![0].name).toBe("rateLimited");
      expect(routes[0].middleware![0].config).toEqual({ limit: 100, windowMs: 60000 });
    });
  });

  describe("router() - child router mounting", () => {
    it("should merge routes from an existing child router", () => {
      const parent = new Router("api");
      const child = new Router("users");

      child.route("list").typed({
        input: z.object({}),
        handle: async () => [],
      });

      child.route("get").typed({
        input: z.object({ id: z.string() }),
        handle: async () => ({}),
      });

      // Mount child into parent
      parent.router(child);

      const routes = parent.getRoutes();
      expect(routes).toHaveLength(2);

      const names = routes.map((r) => r.name);
      expect(names).toContain("api.users.list");
      expect(names).toContain("api.users.get");
    });
  });

  describe("route().addHandler()", () => {
    it("should add a route with a custom handler type", () => {
      const router = new Router("test");

      router.route("custom").addHandler("xml", {
        handle: async () => "<xml />",
      });

      const routes = router.getRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].name).toBe("test.custom");
      expect(routes[0].handler).toBe("xml");
    });
  });
});
