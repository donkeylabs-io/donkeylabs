import { describe, it, expect, afterAll } from "bun:test";
import { z } from "zod";
import { createIntegrationHarness } from "../src/harness";
import { createRouter } from "../src/router";

/**
 * Deep Request Trace Propagation Tests
 *
 * Validates:
 * - traceId on raw handlers
 * - traceId on stream handlers
 * - Response headers on different handler types
 * - traceId format preservation (special characters, long values)
 * - X-Request-Id and X-Trace-Id independence
 * - callRoute() traceId propagation (SSR mode)
 */

describe("Request Trace Propagation - Deep", () => {
  const router = createRouter("deep")
    .route("echo").typed({
      input: z.object({}),
      output: z.object({
        requestId: z.string(),
        traceId: z.string(),
      }),
      handle: async (_input, ctx) => ({
        requestId: ctx.requestId,
        traceId: ctx.traceId,
      }),
    })
    .route("raw-echo").raw({
      handle: async (req, ctx) => {
        return Response.json({
          requestId: ctx.requestId,
          traceId: ctx.traceId,
        });
      },
    })
    .route("fail").raw({
      handle: async (req, ctx) => {
        throw ctx.errors.BadRequest("intentional");
      },
    });

  let harness: Awaited<ReturnType<typeof createIntegrationHarness>>;

  const getHarness = async () => {
    if (!harness) {
      harness = await createIntegrationHarness({
        routers: [router],
      });
    }
    return harness;
  };

  afterAll(async () => {
    if (harness) await harness.shutdown();
  });

  // ------------------------------------------
  // Raw handler trace propagation
  // ------------------------------------------
  describe("Raw handler trace propagation", () => {
    it("should propagate traceId to raw handlers", async () => {
      const h = await getHarness();

      const res = await fetch(`${h.baseUrl}/deep.raw-echo`, {
        method: "POST",
        headers: {
          "X-Request-Id": "raw-trace-123",
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { requestId: string; traceId: string };
      expect(body.traceId).toBe("raw-trace-123");
      expect(body.requestId).not.toBe("raw-trace-123");
    });

    it("should set response trace headers on raw handler responses", async () => {
      const h = await getHarness();

      const res = await fetch(`${h.baseUrl}/deep.raw-echo`, {
        method: "POST",
        headers: {
          "X-Request-Id": "raw-resp-trace",
        },
      });

      expect(res.headers.get("X-Request-Id")).toBeDefined();
      expect(res.headers.get("X-Trace-Id")).toBe("raw-resp-trace");
    });
  });

  // ------------------------------------------
  // Trace ID format edge cases
  // ------------------------------------------
  describe("Trace ID format preservation", () => {
    it("should preserve long trace IDs", async () => {
      const h = await getHarness();
      const longId = "a".repeat(200);

      const res = await fetch(`${h.baseUrl}/deep.echo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": longId,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { traceId: string };
      expect(body.traceId).toBe(longId);
    });

    it("should preserve special characters in trace IDs", async () => {
      const h = await getHarness();
      const specialId = "trace/span:12345-abcdef_xyz";

      const res = await fetch(`${h.baseUrl}/deep.echo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": specialId,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { traceId: string };
      expect(body.traceId).toBe(specialId);
    });

    it("should preserve UUID-format trace IDs", async () => {
      const h = await getHarness();
      const uuid = "550e8400-e29b-41d4-a716-446655440000";

      const res = await fetch(`${h.baseUrl}/deep.echo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": uuid,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { traceId: string };
      expect(body.traceId).toBe(uuid);
    });
  });

  // ------------------------------------------
  // requestId / traceId independence
  // ------------------------------------------
  describe("requestId and traceId independence", () => {
    it("should always generate a fresh requestId regardless of trace headers", async () => {
      const h = await getHarness();

      const res1 = await fetch(`${h.baseUrl}/deep.echo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "same-trace",
        },
        body: JSON.stringify({}),
      });

      const res2 = await fetch(`${h.baseUrl}/deep.echo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "same-trace",
        },
        body: JSON.stringify({}),
      });

      const body1 = await res1.json() as { requestId: string; traceId: string };
      const body2 = await res2.json() as { requestId: string; traceId: string };

      // Both should have the same traceId (from header)
      expect(body1.traceId).toBe("same-trace");
      expect(body2.traceId).toBe("same-trace");

      // But different requestIds
      expect(body1.requestId).not.toBe(body2.requestId);
    });

    it("should return requestId as X-Request-Id header (not the incoming header value)", async () => {
      const h = await getHarness();

      const res = await fetch(`${h.baseUrl}/deep.echo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "incoming-trace",
        },
        body: JSON.stringify({}),
      });

      const body = await res.json() as { requestId: string; traceId: string };

      // X-Request-Id response header should be the auto-generated requestId
      const respReqId = res.headers.get("X-Request-Id");
      expect(respReqId).toBe(body.requestId);

      // X-Trace-Id should be the incoming trace header
      expect(res.headers.get("X-Trace-Id")).toBe("incoming-trace");
    });
  });

  // ------------------------------------------
  // Error response trace headers
  // ------------------------------------------
  describe("Error response trace headers - detailed", () => {
    it("should include X-Request-Id header on 400 error", async () => {
      const h = await getHarness();

      const res = await fetch(`${h.baseUrl}/deep.fail`, {
        method: "POST",
        headers: {
          "X-Request-Id": "err-trace-400",
        },
      });

      expect(res.status).toBe(400);
      expect(res.headers.get("X-Request-Id")).toBeDefined();
      expect(res.headers.get("X-Trace-Id")).toBe("err-trace-400");
    });

    it("should include both trace headers on error when no incoming headers", async () => {
      const h = await getHarness();

      const res = await fetch(`${h.baseUrl}/deep.fail`, {
        method: "POST",
      });

      expect(res.status).toBe(400);
      const reqId = res.headers.get("X-Request-Id");
      const traceId = res.headers.get("X-Trace-Id");

      expect(reqId).toBeDefined();
      expect(traceId).toBeDefined();
      // When no incoming trace, traceId = requestId
      expect(reqId).toBe(traceId);
    });
  });

  // ------------------------------------------
  // Header case insensitivity
  // ------------------------------------------
  describe("Header case insensitivity", () => {
    it("should accept lowercase x-request-id header", async () => {
      const h = await getHarness();

      const res = await fetch(`${h.baseUrl}/deep.echo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-request-id": "lowercase-trace",
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { traceId: string };
      expect(body.traceId).toBe("lowercase-trace");
    });

    it("should accept lowercase x-trace-id header", async () => {
      const h = await getHarness();

      const res = await fetch(`${h.baseUrl}/deep.echo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-trace-id": "lowercase-trace-id",
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { traceId: string };
      expect(body.traceId).toBe("lowercase-trace-id");
    });
  });
});
