import { describe, it, expect } from "bun:test";
import { createRouter } from "../src/router";
import { HTMLHandler } from "../src/handlers";
import { z } from "zod";

/**
 * HTML Handler Tests
 *
 * Tests for the HTML handler which returns HTML responses
 * with validated input, perfect for htmx and server components.
 */

describe("HTML Handler", () => {
  describe("router integration", () => {
    it("should register HTML routes with handler='html'", () => {
      const router = createRouter("api")
        .route("components.card").html({
          input: z.object({ userId: z.string() }),
          handle: (input) => `<div class="card">${input.userId}</div>`,
        });

      const routes = router.getRoutes();

      expect(routes).toHaveLength(1);
      expect(routes[0].name).toBe("api.components.card");
      expect(routes[0].handler).toBe("html");
      expect(routes[0].input).toBeDefined();
    });

    it("should support HTML routes without input schema", () => {
      const router = createRouter("api")
        .route("components.header").html({
          handle: () => `<header>Welcome</header>`,
        });

      const routes = router.getRoutes();

      expect(routes).toHaveLength(1);
      expect(routes[0].handler).toBe("html");
      expect(routes[0].input).toBeUndefined();
    });
  });

  describe("HTMLHandler.execute", () => {
    const mockCtx = {} as any;

    it("should accept GET requests with query params", async () => {
      const req = new Request("http://localhost/test?name=John", { method: "GET" });
      const def = { input: z.object({ name: z.string() }) };
      const handle = (input: any) => `<h1>Hello, ${input.name}!</h1>`;

      const response = await HTMLHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      const html = await response.text();
      expect(html).toBe("<h1>Hello, John!</h1>");
    });

    it("should accept POST requests with JSON body", async () => {
      const req = new Request("http://localhost/test", {
        method: "POST",
        body: JSON.stringify({ name: "Jane" }),
        headers: { "Content-Type": "application/json" },
      });
      const def = { input: z.object({ name: z.string() }) };
      const handle = (input: any) => `<h1>Hello, ${input.name}!</h1>`;

      const response = await HTMLHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toBe("<h1>Hello, Jane!</h1>");
    });

    it("should accept POST requests with form-urlencoded body", async () => {
      const formData = new URLSearchParams();
      formData.append("name", "Bob");

      const req = new Request("http://localhost/test", {
        method: "POST",
        body: formData.toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      const def = { input: z.object({ name: z.string() }) };
      const handle = (input: any) => `<h1>Hello, ${input.name}!</h1>`;

      const response = await HTMLHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toBe("<h1>Hello, Bob!</h1>");
    });

    it("should reject non-GET/POST methods", async () => {
      const req = new Request("http://localhost/test", { method: "PUT" });
      const def = {};
      const handle = () => "<div>test</div>";

      const response = await HTMLHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(405);
    });

    it("should validate input from query params", async () => {
      const req = new Request("http://localhost/test?wrong=field", { method: "GET" });
      const def = { input: z.object({ userId: z.string() }) };
      const handle = (input: any) => `<div>${input.userId}</div>`;

      const response = await HTMLHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(400);
      expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      const html = await response.text();
      expect(html).toContain("Validation Error");
    });

    it("should return Response directly if handler returns Response", async () => {
      const req = new Request("http://localhost/test", { method: "GET" });
      const def = {};
      const handle = () =>
        new Response("<div>Custom Response</div>", {
          status: 201,
          headers: { "X-Custom": "header" },
        });

      const response = await HTMLHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(201);
      expect(response.headers.get("X-Custom")).toBe("header");
    });

    it("should parse JSON values in query params", async () => {
      let receivedInput: any;
      const req = new Request("http://localhost/test?count=5&active=true", { method: "GET" });
      const def = { input: z.object({ count: z.number(), active: z.boolean() }) };
      const handle = (input: any) => {
        receivedInput = input;
        return "<div>ok</div>";
      };

      await HTMLHandler.execute(req, def as any, handle, mockCtx);

      expect(receivedInput).toEqual({ count: 5, active: true });
    });

    it("should handle async handlers", async () => {
      // Use a non-numeric string to avoid JSON.parse converting it
      const req = new Request("http://localhost/test?id=abc123", { method: "GET" });
      const def = { input: z.object({ id: z.string() }) };
      const handle = async (input: any) => {
        await new Promise((r) => setTimeout(r, 10));
        return `<div data-id="${input.id}">Loaded</div>`;
      };

      const response = await HTMLHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-id="abc123"');
    });

    it("should return HTML error on handler errors", async () => {
      const req = new Request("http://localhost/test", { method: "GET" });
      const def = {};
      const handle = () => {
        throw new Error("Something went wrong");
      };

      const response = await HTMLHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(500);
      expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      const html = await response.text();
      expect(html).toContain("Something went wrong");
    });

    it("should respect error status codes", async () => {
      const req = new Request("http://localhost/test", { method: "GET" });
      const def = {};
      const handle = () => {
        const error = new Error("Not Found") as any;
        error.status = 404;
        throw error;
      };

      const response = await HTMLHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(404);
    });
  });

  describe("getMetadata", () => {
    it("should include HTML handler type in metadata", () => {
      const router = createRouter("api")
        .route("pages.home").html({
          handle: () => "<html><body>Home</body></html>",
        });

      const metadata = router.getMetadata();

      expect(metadata).toHaveLength(1);
      expect(metadata[0].name).toBe("api.pages.home");
      expect(metadata[0].handler).toBe("html");
    });
  });

  describe("nested routers", () => {
    it("should preserve HTML handler type in nested routers", () => {
      const childRouter = createRouter("components")
        .route("button").html({
          input: z.object({ label: z.string() }),
          handle: (input) => `<button>${input.label}</button>`,
        })
        .route("card").html({
          input: z.object({ title: z.string() }),
          handle: (input) => `<div class="card">${input.title}</div>`,
        });

      const parentRouter = createRouter("ui").router(childRouter);

      const routes = parentRouter.getRoutes();

      expect(routes).toHaveLength(2);
      expect(routes.every((r) => r.handler === "html")).toBe(true);
    });
  });
});
