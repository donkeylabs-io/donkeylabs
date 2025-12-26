import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Request, Response } from "express";
import { APIErrors, ApiError, ErrorType } from "@donkeylabs/core";
import { errorHandler, setErrorAuditCallback, type ErrorAuditCallback } from "../errors";

const createResponse = () => {
  const res: Partial<Response> & { statusCode?: number; payload?: unknown } = {};
  res.status = function (code: number) {
    res.statusCode = code;
    return res as Response;
  };
  res.json = function (payload: unknown) {
    res.payload = payload;
    return res as Response;
  };
  return res as Response & { statusCode?: number; payload?: unknown };
};

const createRequest = (overrides: Partial<Request> = {}) => {
  return {
    method: "GET",
    url: "/test",
    path: "/test",
    ...overrides,
  } as Request;
};

describe("errorHandler", () => {
  afterEach(() => {
    // Clear the audit callback after each test
    setErrorAuditCallback(null);
  });

  it("returns structured response for ApiError instances", () => {
    const res = createResponse();
    const apiError = APIErrors.notFound({ resource: "test" });

    errorHandler(apiError, res);

    expect(res.statusCode).toBe(404);
    expect(res.payload).toEqual(apiError.toResponse());
  });

  it("wraps unexpected errors in an internal server error response", () => {
    const res = createResponse();
    const err = new Error("boom");
    const req = createRequest();

    errorHandler(err, res, req);

    expect(res.statusCode).toBe(500);
    expect(res.payload).toMatchObject({
      type: "INTERNAL_SERVER_ERROR",
      message: "Algo salió mal",
    });
  });

  it("handles unexpected errors without request", () => {
    const res = createResponse();
    const err = new Error("boom");

    errorHandler(err, res);

    expect(res.statusCode).toBe(500);
    expect(res.payload).toMatchObject({
      type: "INTERNAL_SERVER_ERROR",
      message: "Algo salió mal",
    });
  });

  it("handles non-Error objects", () => {
    const res = createResponse();
    const err = { customError: true, message: "Custom error object" };
    const req = createRequest();

    errorHandler(err, res, req);

    expect(res.statusCode).toBe(500);
    expect(res.payload).toMatchObject({
      type: "INTERNAL_SERVER_ERROR",
    });
  });

  it("handles string errors", () => {
    const res = createResponse();
    const err = "String error message";
    const req = createRequest();

    errorHandler(err, res, req);

    expect(res.statusCode).toBe(500);
  });

  describe("different ApiError types", () => {
    it("handles unauthorized errors", () => {
      const res = createResponse();
      const apiError = APIErrors.unauthorized({ reason: "invalid token" });

      errorHandler(apiError, res);

      expect(res.statusCode).toBe(401);
    });

    it("handles validation errors", () => {
      const res = createResponse();
      const apiError = APIErrors.validationError({ field: "email" });

      errorHandler(apiError, res);

      expect(res.statusCode).toBe(400);
    });

    it("handles rate limit errors", () => {
      const res = createResponse();
      const apiError = APIErrors.rateLimitExceeded();

      errorHandler(apiError, res);

      expect(res.statusCode).toBe(429);
    });
  });

  describe("audit callback", () => {
    it("calls audit callback for ApiError when set", () => {
      const auditCallback = mock((params: any) => {});
      setErrorAuditCallback(auditCallback);

      const res = createResponse();
      const apiError = APIErrors.notFound({ resource: "user" });
      const req = createRequest({ method: "GET", path: "/users/123" });

      errorHandler(apiError, res, req);

      expect(auditCallback).toHaveBeenCalled();
      const callArgs = auditCallback.mock.calls[0][0];
      expect(callArgs.level).toBe("warn");
      expect(callArgs.event).toBe("error.NOT_FOUND");
      expect(callArgs.method).toBe("GET");
      expect(callArgs.path).toBe("/users/123");
      expect(callArgs.statusCode).toBe(404);
    });

    it("calls audit callback for unexpected errors with level error", () => {
      const auditCallback = mock((params: any) => {});
      setErrorAuditCallback(auditCallback);

      const res = createResponse();
      const err = new Error("Unexpected database error");
      const req = createRequest({ method: "POST", path: "/api/data" });

      errorHandler(err, res, req);

      expect(auditCallback).toHaveBeenCalled();
      const callArgs = auditCallback.mock.calls[0][0];
      expect(callArgs.level).toBe("error");
      expect(callArgs.event).toBe("error.internal_server_error");
      expect(callArgs.method).toBe("POST");
      expect(callArgs.path).toBe("/api/data");
      expect(callArgs.statusCode).toBe(500);
      expect(callArgs.details.errorMessage).toBe("Unexpected database error");
    });

    it("does not call audit callback when not set", () => {
      const res = createResponse();
      const apiError = APIErrors.notFound({ resource: "test" });
      const req = createRequest();

      // Should not throw
      errorHandler(apiError, res, req);

      expect(res.statusCode).toBe(404);
    });

    it("does not call audit callback without request", () => {
      const auditCallback = mock((params: any) => {});
      setErrorAuditCallback(auditCallback);

      const res = createResponse();
      const apiError = APIErrors.notFound({ resource: "test" });

      errorHandler(apiError, res);

      // Callback should not be called without request
      expect(auditCallback).not.toHaveBeenCalled();
    });

    it("extracts audit context from request", () => {
      const auditCallback = mock((params: any) => {});
      setErrorAuditCallback(auditCallback);

      const res = createResponse();
      const apiError = APIErrors.unauthorized({});
      const req = createRequest({ method: "GET", path: "/profile" });
      (req as any).auditContext = { userId: 123, username: "testuser" };

      errorHandler(apiError, res, req);

      expect(auditCallback).toHaveBeenCalled();
      const callArgs = auditCallback.mock.calls[0][0];
      expect(callArgs.context.userId).toBe(123);
      expect(callArgs.context.username).toBe("testuser");
    });
  });

  describe("error details extraction", () => {
    it("extracts stack trace from Error", () => {
      const auditCallback = mock((params: any) => {});
      setErrorAuditCallback(auditCallback);

      const res = createResponse();
      const err = new Error("Test error");
      const req = createRequest();

      errorHandler(err, res, req);

      const callArgs = auditCallback.mock.calls[0][0];
      expect(callArgs.details.errorName).toBe("Error");
      expect(callArgs.details.errorMessage).toBe("Test error");
      expect(callArgs.details.errorStack).toBeDefined();
    });

    it("extracts type and details from ApiError", () => {
      const auditCallback = mock((params: any) => {});
      setErrorAuditCallback(auditCallback);

      const res = createResponse();
      const apiError = APIErrors.validationError({ field: "email", reason: "invalid format" });
      const req = createRequest();

      errorHandler(apiError, res, req);

      const callArgs = auditCallback.mock.calls[0][0];
      expect(callArgs.details.errorType).toBe(ErrorType.VALIDATION_ERROR);
      expect(callArgs.details.errorDetails).toMatchObject({ field: "email", reason: "invalid format" });
    });

    it("extracts additional properties from error objects", () => {
      const auditCallback = mock((params: any) => {});
      setErrorAuditCallback(auditCallback);

      const res = createResponse();
      const err = new Error("Custom error");
      (err as any).customProp = "custom value";
      (err as any).code = "ERR_CUSTOM";
      const req = createRequest();

      errorHandler(err, res, req);

      const callArgs = auditCallback.mock.calls[0][0];
      expect(callArgs.details.error_customProp).toBe("custom value");
      expect(callArgs.details.error_code).toBe("ERR_CUSTOM");
    });
  });
});

describe("setErrorAuditCallback", () => {
  afterEach(() => {
    setErrorAuditCallback(null);
  });

  it("sets and clears audit callback", () => {
    const callback = mock(() => {});
    setErrorAuditCallback(callback);

    // Callback should be set - verify by triggering an error
    const res = createResponse();
    const apiError = APIErrors.notFound({});
    const req = createRequest();

    errorHandler(apiError, res, req);
    expect(callback).toHaveBeenCalled();

    // Clear and verify
    callback.mockClear();
    setErrorAuditCallback(null);

    errorHandler(apiError, res, req);
    expect(callback).not.toHaveBeenCalled();
  });
});
