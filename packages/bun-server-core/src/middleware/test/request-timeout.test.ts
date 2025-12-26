import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "events";
import { requestTimeout, withTimeout, isRequestTimedOut } from "../request-timeout";
import type { Request, Response, NextFunction } from "express";

// Mock Express Request
function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    method: "GET",
    path: "/test",
    ...overrides,
  } as Request;
}

// Mock Express Response with EventEmitter for event handling
function createMockResponse(): Response & EventEmitter & { payload: any; statusCode: number } {
  const res = new EventEmitter() as Response & EventEmitter & { payload: any; statusCode: number };

  res.statusCode = 200;
  res.headersSent = false;
  res.payload = null;

  (res as any).status = (code: number) => {
    res.statusCode = code;
    return res;
  };

  (res as any).json = (data: any) => {
    res.payload = data;
    res.headersSent = true;
    return res;
  };

  return res;
}

describe("requestTimeout middleware", () => {
  describe("basic functionality", () => {
    it("calls next() immediately", () => {
      const middleware = requestTimeout({ timeout: 1000 });
      const req = createMockRequest();
      const res = createMockResponse();
      let nextCalled = false;

      middleware(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
    });

    it("skips if headers already sent", () => {
      const middleware = requestTimeout({ timeout: 1000 });
      const req = createMockRequest();
      const res = createMockResponse();
      res.headersSent = true;
      let nextCalled = false;

      middleware(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
    });
  });

  describe("timeout behavior", () => {
    it("responds with 504 on timeout", async () => {
      const middleware = requestTimeout({ timeout: 50 });
      const req = createMockRequest();
      const res = createMockResponse();

      middleware(req, res, () => {});

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(res.statusCode).toBe(504);
      expect(res.payload.type).toBe("GATEWAY_TIMEOUT");
    });

    it("includes request details in timeout response", async () => {
      const middleware = requestTimeout({ timeout: 50 });
      const req = createMockRequest({ method: "POST", path: "/api/slow" });
      const res = createMockResponse();

      middleware(req, res, () => {});

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(res.payload.details.method).toBe("POST");
      expect(res.payload.details.path).toBe("/api/slow");
      expect(res.payload.details.timeout).toBe(50);
    });

    it("uses custom message when provided", async () => {
      const middleware = requestTimeout({
        timeout: 50,
        message: "Custom timeout message",
      });
      const req = createMockRequest();
      const res = createMockResponse();

      middleware(req, res, () => {});

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(res.payload.message).toBe("Custom timeout message");
    });

    it("calls onTimeout callback when timeout occurs", async () => {
      let callbackCalled = false;
      let callbackReq: Request | null = null;

      const middleware = requestTimeout({
        timeout: 50,
        onTimeout: (req) => {
          callbackCalled = true;
          callbackReq = req;
        },
      });
      const req = createMockRequest();
      const res = createMockResponse();

      middleware(req, res, () => {});

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(callbackCalled).toBe(true);
      expect(callbackReq).toBe(req);
    });
  });

  describe("cleanup on response completion", () => {
    it("does not timeout if response finishes in time", async () => {
      const middleware = requestTimeout({ timeout: 100 });
      const req = createMockRequest();
      const res = createMockResponse();

      middleware(req, res, () => {});

      // Simulate response finishing
      res.emit("finish");

      // Wait past the timeout period
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should not have timed out since response finished
      expect(res.payload).toBe(null);
    });

    it("does not timeout if connection closes", async () => {
      const middleware = requestTimeout({ timeout: 100 });
      const req = createMockRequest();
      const res = createMockResponse();

      middleware(req, res, () => {});

      // Simulate connection close
      res.emit("close");

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(res.payload).toBe(null);
    });

    it("does not timeout on error event", async () => {
      const middleware = requestTimeout({ timeout: 100 });
      const req = createMockRequest();
      const res = createMockResponse();

      middleware(req, res, () => {});

      // Simulate error
      res.emit("error", new Error("Connection error"));

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(res.payload).toBe(null);
    });
  });

  describe("isTimedOut tracking", () => {
    it("isTimedOut returns false before timeout", () => {
      const middleware = requestTimeout({ timeout: 1000 });
      const req = createMockRequest();
      const res = createMockResponse();

      middleware(req, res, () => {});

      expect(isRequestTimedOut(req)).toBe(false);
    });

    it("isTimedOut returns true after timeout", async () => {
      const middleware = requestTimeout({ timeout: 50 });
      const req = createMockRequest();
      const res = createMockResponse();

      middleware(req, res, () => {});

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(isRequestTimedOut(req)).toBe(true);
    });
  });

  describe("event listener cleanup (memory leak prevention)", () => {
    it("uses once() for event listeners to auto-remove", async () => {
      const middleware = requestTimeout({ timeout: 100 });
      const req = createMockRequest();
      const res = createMockResponse();

      middleware(req, res, () => {});

      // Check that listeners are registered
      expect(res.listenerCount("finish")).toBe(1);
      expect(res.listenerCount("close")).toBe(1);
      expect(res.listenerCount("error")).toBe(1);

      // Emit finish event
      res.emit("finish");

      // Listeners should be auto-removed after firing once
      expect(res.listenerCount("finish")).toBe(0);
      // Other listeners still present since they didn't fire
      expect(res.listenerCount("close")).toBe(1);
      expect(res.listenerCount("error")).toBe(1);
    });
  });
});

describe("withTimeout", () => {
  it("creates middleware with specified timeout", async () => {
    const middleware = withTimeout(50);
    const req = createMockRequest();
    const res = createMockResponse();

    middleware(req, res, () => {});

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(res.statusCode).toBe(504);
    expect(res.payload.details.timeout).toBe(50);
  });
});

describe("isRequestTimedOut", () => {
  it("returns false for requests without timeout tracking", () => {
    const req = createMockRequest();
    expect(isRequestTimedOut(req)).toBe(false);
  });

  it("returns false if isTimedOut is not a function", () => {
    const req = createMockRequest();
    (req as any).isTimedOut = "not a function";
    expect(isRequestTimedOut(req)).toBe(false);
  });
});
