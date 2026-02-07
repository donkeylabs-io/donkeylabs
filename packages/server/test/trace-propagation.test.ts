import { describe, it, expect, afterAll } from "bun:test";
import { z } from "zod";
import { createIntegrationHarness } from "../src/harness";
import { createRouter } from "../src/router";

/**
 * Request Trace Propagation Tests
 *
 * Validates that:
 * - traceId defaults to requestId when no header is sent
 * - X-Request-Id header is picked up as traceId
 * - X-Trace-Id header is picked up as traceId
 * - X-Request-Id takes priority over X-Trace-Id
 * - Response headers include X-Request-Id and X-Trace-Id
 * - Error responses also include trace headers
 */

describe("Request Trace Propagation", () => {
  // Build a simple router that echoes back the requestId and traceId from context
  const echoRouter = createRouter("trace")
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
    .route("fail").raw({
      handle: async (req, ctx) => {
        throw ctx.errors.BadRequest("intentional failure");
      },
    });

  let harness: Awaited<ReturnType<typeof createIntegrationHarness>>;

  // Use a shared harness for all tests in this describe block
  const getHarness = async () => {
    if (!harness) {
      harness = await createIntegrationHarness({
        routers: [echoRouter],
      });
    }
    return harness;
  };

  afterAll(async () => {
    if (harness) {
      await harness.shutdown();
    }
  });

  // ------------------------------------------
  // traceId defaults
  // ------------------------------------------
  describe("traceId defaults to requestId when no trace header is sent", () => {
    it("should have traceId equal to requestId in response body", async () => {
      const h = await getHarness();

      const res = await fetch(`${h.baseUrl}/trace.echo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { requestId: string; traceId: string };

      // When no X-Request-Id or X-Trace-Id header is provided,
      // traceId should equal requestId (auto-generated UUID)
      expect(body.requestId).toBeDefined();
      expect(body.traceId).toBeDefined();
      expect(body.traceId).toBe(body.requestId);
    });
  });

  // ------------------------------------------
  // X-Request-Id header
  // ------------------------------------------
  describe("X-Request-Id header", () => {
    it("should use X-Request-Id as traceId", async () => {
      const h = await getHarness();

      const res = await fetch(`${h.baseUrl}/trace.echo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "custom-request-id-123",
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { requestId: string; traceId: string };

      expect(body.traceId).toBe("custom-request-id-123");
      // requestId should be a fresh UUID (not the header value)
      expect(body.requestId).not.toBe("custom-request-id-123");
    });
  });

  // ------------------------------------------
  // X-Trace-Id header
  // ------------------------------------------
  describe("X-Trace-Id header", () => {
    it("should use X-Trace-Id as traceId when X-Request-Id is absent", async () => {
      const h = await getHarness();

      const res = await fetch(`${h.baseUrl}/trace.echo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Trace-Id": "trace-from-gateway-456",
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { requestId: string; traceId: string };

      expect(body.traceId).toBe("trace-from-gateway-456");
    });
  });

  // ------------------------------------------
  // X-Request-Id takes priority over X-Trace-Id
  // ------------------------------------------
  describe("X-Request-Id priority over X-Trace-Id", () => {
    it("should prefer X-Request-Id when both headers are present", async () => {
      const h = await getHarness();

      const res = await fetch(`${h.baseUrl}/trace.echo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "from-request-id",
          "X-Trace-Id": "from-trace-id",
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { requestId: string; traceId: string };

      // X-Request-Id should take precedence
      expect(body.traceId).toBe("from-request-id");
    });
  });

  // ------------------------------------------
  // Response headers
  // ------------------------------------------
  describe("Response headers include trace IDs", () => {
    it("should set X-Request-Id response header to the auto-generated requestId", async () => {
      const h = await getHarness();

      const res = await fetch(`${h.baseUrl}/trace.echo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const responseRequestId = res.headers.get("X-Request-Id");
      expect(responseRequestId).toBeDefined();
      // Should be a UUID-like string
      expect(responseRequestId!.length).toBeGreaterThan(0);

      const body = await res.json() as { requestId: string };
      expect(responseRequestId).toBe(body.requestId);
    });

    it("should set X-Trace-Id response header to the resolved traceId", async () => {
      const h = await getHarness();

      const res = await fetch(`${h.baseUrl}/trace.echo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "incoming-trace-999",
        },
        body: JSON.stringify({}),
      });

      expect(res.headers.get("X-Trace-Id")).toBe("incoming-trace-999");
    });

    it("should include both X-Request-Id and X-Trace-Id in response when no trace headers sent", async () => {
      const h = await getHarness();

      const res = await fetch(`${h.baseUrl}/trace.echo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const reqId = res.headers.get("X-Request-Id");
      const traceId = res.headers.get("X-Trace-Id");

      expect(reqId).toBeDefined();
      expect(traceId).toBeDefined();
      // When no incoming trace header, both should be the same auto-generated value
      expect(reqId).toBe(traceId);
    });
  });

  // ------------------------------------------
  // Error responses include trace headers
  // ------------------------------------------
  describe("Error responses include trace headers", () => {
    it("should include X-Request-Id and X-Trace-Id on error responses", async () => {
      const h = await getHarness();

      const res = await fetch(`${h.baseUrl}/trace.fail`, {
        method: "POST",
        headers: {
          "X-Request-Id": "error-trace-id",
        },
      });

      expect(res.status).toBe(400);
      expect(res.headers.get("X-Request-Id")).toBeDefined();
      expect(res.headers.get("X-Trace-Id")).toBe("error-trace-id");
    });
  });

  // ------------------------------------------
  // Unique requestId per request
  // ------------------------------------------
  describe("Unique requestId generation", () => {
    it("should generate unique requestIds for consecutive requests", async () => {
      const h = await getHarness();

      const requestIds = new Set<string>();

      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${h.baseUrl}/trace.echo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const body = await res.json() as { requestId: string };
        requestIds.add(body.requestId);
      }

      expect(requestIds.size).toBe(5);
    });
  });
});
