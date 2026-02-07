import { describe, it, expect } from "bun:test";
import {
  createErrors,
  HttpError,
  MethodNotAllowedError,
  GoneError,
  UnprocessableEntityError,
  TooManyRequestsError,
  NotImplementedError,
  BadGatewayError,
  ServiceUnavailableError,
  GatewayTimeoutError,
} from "../src/core/index";

// ==========================================
// Extended Error Subclass Tests
// ==========================================

describe("MethodNotAllowedError", () => {
  it("should have correct defaults", () => {
    const error = new MethodNotAllowedError();
    expect(error.status).toBe(405);
    expect(error.code).toBe("METHOD_NOT_ALLOWED");
    expect(error.message).toBe("Method Not Allowed");
    expect(error.name).toBe("MethodNotAllowedError");
    expect(error instanceof HttpError).toBe(true);
    expect(error instanceof Error).toBe(true);
  });

  it("should accept custom message, details, and cause", () => {
    const cause = new Error("original");
    const error = new MethodNotAllowedError("POST not allowed", { allowed: ["GET"] }, cause);
    expect(error.message).toBe("POST not allowed");
    expect(error.details).toEqual({ allowed: ["GET"] });
    expect(error.cause).toBe(cause);
  });
});

describe("GoneError", () => {
  it("should have correct defaults", () => {
    const error = new GoneError();
    expect(error.status).toBe(410);
    expect(error.code).toBe("GONE");
    expect(error.message).toBe("Gone");
    expect(error.name).toBe("GoneError");
    expect(error instanceof HttpError).toBe(true);
  });

  it("should accept custom message, details, and cause", () => {
    const cause = new Error("removed");
    const error = new GoneError("Resource deleted", { resourceId: "abc" }, cause);
    expect(error.message).toBe("Resource deleted");
    expect(error.details).toEqual({ resourceId: "abc" });
    expect(error.cause).toBe(cause);
  });
});

describe("UnprocessableEntityError", () => {
  it("should have correct defaults", () => {
    const error = new UnprocessableEntityError();
    expect(error.status).toBe(422);
    expect(error.code).toBe("UNPROCESSABLE_ENTITY");
    expect(error.message).toBe("Unprocessable Entity");
    expect(error.name).toBe("UnprocessableEntityError");
    expect(error instanceof HttpError).toBe(true);
  });

  it("should accept custom message, details, and cause", () => {
    const cause = new Error("parse fail");
    const error = new UnprocessableEntityError("Invalid payload", { field: "age" }, cause);
    expect(error.message).toBe("Invalid payload");
    expect(error.details).toEqual({ field: "age" });
    expect(error.cause).toBe(cause);
  });
});

describe("TooManyRequestsError", () => {
  it("should have correct defaults", () => {
    const error = new TooManyRequestsError();
    expect(error.status).toBe(429);
    expect(error.code).toBe("TOO_MANY_REQUESTS");
    expect(error.message).toBe("Too Many Requests");
    expect(error.name).toBe("TooManyRequestsError");
    expect(error instanceof HttpError).toBe(true);
  });

  it("should accept custom message, details, and cause", () => {
    const cause = new Error("rate limited");
    const error = new TooManyRequestsError("Slow down", { retryAfter: 60 }, cause);
    expect(error.message).toBe("Slow down");
    expect(error.details).toEqual({ retryAfter: 60 });
    expect(error.cause).toBe(cause);
  });
});

describe("NotImplementedError", () => {
  it("should have correct defaults", () => {
    const error = new NotImplementedError();
    expect(error.status).toBe(501);
    expect(error.code).toBe("NOT_IMPLEMENTED");
    expect(error.message).toBe("Not Implemented");
    expect(error.name).toBe("NotImplementedError");
    expect(error instanceof HttpError).toBe(true);
  });

  it("should accept custom message, details, and cause", () => {
    const cause = new Error("missing feature");
    const error = new NotImplementedError("Feature coming soon", { feature: "export" }, cause);
    expect(error.message).toBe("Feature coming soon");
    expect(error.details).toEqual({ feature: "export" });
    expect(error.cause).toBe(cause);
  });
});

describe("BadGatewayError", () => {
  it("should have correct defaults", () => {
    const error = new BadGatewayError();
    expect(error.status).toBe(502);
    expect(error.code).toBe("BAD_GATEWAY");
    expect(error.message).toBe("Bad Gateway");
    expect(error.name).toBe("BadGatewayError");
    expect(error instanceof HttpError).toBe(true);
  });

  it("should accept custom message, details, and cause", () => {
    const cause = new Error("upstream failed");
    const error = new BadGatewayError("Upstream error", { upstream: "api.example.com" }, cause);
    expect(error.message).toBe("Upstream error");
    expect(error.details).toEqual({ upstream: "api.example.com" });
    expect(error.cause).toBe(cause);
  });
});

describe("ServiceUnavailableError", () => {
  it("should have correct defaults", () => {
    const error = new ServiceUnavailableError();
    expect(error.status).toBe(503);
    expect(error.code).toBe("SERVICE_UNAVAILABLE");
    expect(error.message).toBe("Service Unavailable");
    expect(error.name).toBe("ServiceUnavailableError");
    expect(error instanceof HttpError).toBe(true);
  });

  it("should accept custom message, details, and cause", () => {
    const cause = new Error("overloaded");
    const error = new ServiceUnavailableError("Under maintenance", { eta: "10m" }, cause);
    expect(error.message).toBe("Under maintenance");
    expect(error.details).toEqual({ eta: "10m" });
    expect(error.cause).toBe(cause);
  });
});

describe("GatewayTimeoutError", () => {
  it("should have correct defaults", () => {
    const error = new GatewayTimeoutError();
    expect(error.status).toBe(504);
    expect(error.code).toBe("GATEWAY_TIMEOUT");
    expect(error.message).toBe("Gateway Timeout");
    expect(error.name).toBe("GatewayTimeoutError");
    expect(error instanceof HttpError).toBe(true);
  });

  it("should accept custom message, details, and cause", () => {
    const cause = new Error("timed out");
    const error = new GatewayTimeoutError("Upstream timed out", { timeout: 30000 }, cause);
    expect(error.message).toBe("Upstream timed out");
    expect(error.details).toEqual({ timeout: 30000 });
    expect(error.cause).toBe(cause);
  });
});

// ==========================================
// toJSON Edge Case
// ==========================================

describe("toJSON edge cases", () => {
  it("should omit details when details is an empty object", () => {
    const error = new HttpError(400, "BAD_REQUEST", "Bad request", {});
    const json = error.toJSON();
    expect(json).toEqual({
      error: "BAD_REQUEST",
      message: "Bad request",
    });
    expect(json.details).toBeUndefined();
  });

  it("should include details when details has properties", () => {
    const error = new MethodNotAllowedError("Not allowed", { allowed: ["GET"] });
    const json = error.toJSON();
    expect(json.details).toEqual({ allowed: ["GET"] });
  });
});

// ==========================================
// Factory Invocations via createErrors()
// ==========================================

describe("createErrors() factory invocations for extended errors", () => {
  it("should create MethodNotAllowedError via factory", () => {
    const errors = createErrors();
    const error = errors.MethodNotAllowed("DELETE not supported", { allowed: ["GET", "POST"] });
    expect(error instanceof MethodNotAllowedError).toBe(true);
    expect(error.status).toBe(405);
    expect(error.message).toBe("DELETE not supported");
    expect(error.details).toEqual({ allowed: ["GET", "POST"] });
  });

  it("should create GoneError via factory", () => {
    const errors = createErrors();
    const error = errors.Gone("Endpoint retired");
    expect(error instanceof GoneError).toBe(true);
    expect(error.status).toBe(410);
    expect(error.message).toBe("Endpoint retired");
  });

  it("should create UnprocessableEntityError via factory", () => {
    const errors = createErrors();
    const error = errors.UnprocessableEntity("Semantically invalid");
    expect(error instanceof UnprocessableEntityError).toBe(true);
    expect(error.status).toBe(422);
    expect(error.message).toBe("Semantically invalid");
  });

  it("should create TooManyRequestsError via factory", () => {
    const errors = createErrors();
    const error = errors.TooManyRequests("Rate limit exceeded", { retryAfter: 120 });
    expect(error instanceof TooManyRequestsError).toBe(true);
    expect(error.status).toBe(429);
    expect(error.details).toEqual({ retryAfter: 120 });
  });

  it("should create NotImplementedError via factory", () => {
    const errors = createErrors();
    const error = errors.NotImplemented();
    expect(error instanceof NotImplementedError).toBe(true);
    expect(error.status).toBe(501);
    expect(error.message).toBe("Not Implemented");
  });

  it("should create BadGatewayError via factory", () => {
    const errors = createErrors();
    const error = errors.BadGateway("Proxy error");
    expect(error instanceof BadGatewayError).toBe(true);
    expect(error.status).toBe(502);
    expect(error.message).toBe("Proxy error");
  });

  it("should create ServiceUnavailableError via factory", () => {
    const errors = createErrors();
    const error = errors.ServiceUnavailable("Maintenance mode");
    expect(error instanceof ServiceUnavailableError).toBe(true);
    expect(error.status).toBe(503);
    expect(error.message).toBe("Maintenance mode");
  });

  it("should create GatewayTimeoutError via factory", () => {
    const errors = createErrors();
    const cause = new Error("connection timeout");
    const error = errors.GatewayTimeout("Upstream timed out", undefined, cause);
    expect(error instanceof GatewayTimeoutError).toBe(true);
    expect(error.status).toBe(504);
    expect(error.cause).toBe(cause);
  });
});

// ==========================================
// register() and isHttpError()
// ==========================================

describe("register() custom error", () => {
  it("should register and invoke a custom error with default message", () => {
    const errors = createErrors();
    errors.register("Teapot", {
      status: 418,
      code: "IM_A_TEAPOT",
      defaultMessage: "I'm a teapot",
    });
    const error = (errors as any).Teapot();
    expect(error.status).toBe(418);
    expect(error.code).toBe("IM_A_TEAPOT");
    expect(error.message).toBe("I'm a teapot");
    expect(error instanceof HttpError).toBe(true);
  });

  it("should register custom error with details and cause", () => {
    const errors = createErrors();
    errors.register("Locked", {
      status: 423,
      code: "RESOURCE_LOCKED",
      defaultMessage: "Resource is locked",
    });
    const cause = new Error("lock held");
    const error = (errors as any).Locked("File locked", { file: "a.txt" }, cause);
    expect(error.status).toBe(423);
    expect(error.message).toBe("File locked");
    expect(error.details).toEqual({ file: "a.txt" });
    expect(error.cause).toBe(cause);
  });

  it("should fall back to code when no message or defaultMessage", () => {
    const errors = createErrors();
    errors.register("NoDefault", {
      status: 499,
      code: "NO_DEFAULT",
    });
    const error = (errors as any).NoDefault();
    expect(error.message).toBe("NO_DEFAULT");
  });
});

describe("isHttpError() type guard", () => {
  it("should return true for all error subclasses", () => {
    const errors = createErrors();
    expect(errors.isHttpError(new MethodNotAllowedError())).toBe(true);
    expect(errors.isHttpError(new GoneError())).toBe(true);
    expect(errors.isHttpError(new UnprocessableEntityError())).toBe(true);
    expect(errors.isHttpError(new TooManyRequestsError())).toBe(true);
    expect(errors.isHttpError(new NotImplementedError())).toBe(true);
    expect(errors.isHttpError(new BadGatewayError())).toBe(true);
    expect(errors.isHttpError(new ServiceUnavailableError())).toBe(true);
    expect(errors.isHttpError(new GatewayTimeoutError())).toBe(true);
  });

  it("should return false for non-HttpError values", () => {
    const errors = createErrors();
    expect(errors.isHttpError(new Error("plain"))).toBe(false);
    expect(errors.isHttpError(null)).toBe(false);
    expect(errors.isHttpError(undefined)).toBe(false);
    expect(errors.isHttpError(42)).toBe(false);
    expect(errors.isHttpError({ status: 400 })).toBe(false);
  });
});

// ==========================================
// Factory coverage for Unauthorized/Forbidden/InternalServer
// ==========================================
describe("createErrors factory - remaining factories", () => {
  it("should create Unauthorized via factory", () => {
    const errors = createErrors();
    const error = errors.Unauthorized("Invalid token");
    expect(error.status).toBe(401);
    expect(error.message).toBe("Invalid token");
    expect(error instanceof HttpError).toBe(true);
  });

  it("should create Forbidden via factory", () => {
    const errors = createErrors();
    const error = errors.Forbidden("Access denied");
    expect(error.status).toBe(403);
    expect(error.message).toBe("Access denied");
  });

  it("should create InternalServer via factory", () => {
    const errors = createErrors();
    const error = errors.InternalServer("Unexpected error");
    expect(error.status).toBe(500);
    expect(error.message).toBe("Unexpected error");
  });

  it("should create BadRequest via factory", () => {
    const errors = createErrors();
    const error = errors.BadRequest("Bad input", { field: "email" });
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ field: "email" });
  });

  it("should create NotFound via factory", () => {
    const errors = createErrors();
    const error = errors.NotFound("User not found");
    expect(error.status).toBe(404);
    expect(error.message).toBe("User not found");
  });

  it("should create Conflict via factory", () => {
    const errors = createErrors();
    const error = errors.Conflict("Already exists");
    expect(error.status).toBe(409);
    expect(error.message).toBe("Already exists");
  });
});
