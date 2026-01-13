import { describe, it, expect, beforeEach } from "bun:test";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { PluginManager, createPlugin, type CoreServices } from "../core";
import {
  createErrors,
  createLogger,
  createCache,
  createEvents,
  createCron,
  createJobs,
  createSSE,
  createRateLimiter,
  HttpError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InternalServerError,
  createValidationError,
} from "../core/index";

// ==========================================
// Error System Unit Tests
// ==========================================

describe("HttpError Base Class", () => {
  it("should create error with all properties", () => {
    const error = new HttpError(400, "BAD_REQUEST", "Invalid input", { field: "email" });

    expect(error.status).toBe(400);
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toBe("Invalid input");
    expect(error.details).toEqual({ field: "email" });
    expect(error.name).toBe("HttpError");
  });

  it("should create error with cause", () => {
    const cause = new Error("Original error");
    const error = new HttpError(500, "INTERNAL_SERVER_ERROR", "Something went wrong", undefined, cause);

    expect(error.cause).toBe(cause);
  });

  it("should convert to JSON correctly", () => {
    const error = new HttpError(404, "NOT_FOUND", "User not found", { userId: 123 });
    const json = error.toJSON();

    expect(json).toEqual({
      error: "NOT_FOUND",
      message: "User not found",
      details: { userId: 123 },
    });
  });

  it("should omit empty details in JSON", () => {
    const error = new HttpError(400, "BAD_REQUEST", "Bad request");
    const json = error.toJSON();

    expect(json).toEqual({
      error: "BAD_REQUEST",
      message: "Bad request",
    });
    expect(json.details).toBeUndefined();
  });

  it("should be instanceof Error", () => {
    const error = new HttpError(400, "BAD_REQUEST", "Test");
    expect(error instanceof Error).toBe(true);
    expect(error instanceof HttpError).toBe(true);
  });
});

describe("Standard HTTP Error Classes", () => {
  it("should create BadRequestError with defaults", () => {
    const error = new BadRequestError();
    expect(error.status).toBe(400);
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toBe("Bad Request");
    expect(error.name).toBe("BadRequestError");
  });

  it("should create BadRequestError with custom message", () => {
    const error = new BadRequestError("Invalid user ID");
    expect(error.message).toBe("Invalid user ID");
    expect(error.status).toBe(400);
  });

  it("should create UnauthorizedError", () => {
    const error = new UnauthorizedError("Please log in");
    expect(error.status).toBe(401);
    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.message).toBe("Please log in");
    expect(error.name).toBe("UnauthorizedError");
  });

  it("should create ForbiddenError", () => {
    const error = new ForbiddenError("Access denied");
    expect(error.status).toBe(403);
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toBe("Access denied");
  });

  it("should create NotFoundError", () => {
    const error = new NotFoundError("User not found", { userId: 123 });
    expect(error.status).toBe(404);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.details).toEqual({ userId: 123 });
  });

  it("should create ConflictError", () => {
    const error = new ConflictError("Email already exists");
    expect(error.status).toBe(409);
    expect(error.code).toBe("CONFLICT");
  });

  it("should create InternalServerError", () => {
    const error = new InternalServerError("Database connection failed");
    expect(error.status).toBe(500);
    expect(error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});

describe("createValidationError Helper", () => {
  it("should create validation error from Zod-like issues", () => {
    const error = createValidationError([
      { path: ["email"], message: "Invalid email format" },
      { path: ["password"], message: "Password too short" },
    ]);

    expect(error.status).toBe(400);
    expect(error.message).toBe("Validation Failed");
    expect(error.details?.issues).toHaveLength(2);
    expect(error.details?.issues[0]).toEqual({
      path: ["email"],
      message: "Invalid email format",
    });
  });
});

describe("Errors Service (createErrors)", () => {
  it("should create errors service with all standard factories", () => {
    const errors = createErrors();

    expect(typeof errors.BadRequest).toBe("function");
    expect(typeof errors.Unauthorized).toBe("function");
    expect(typeof errors.Forbidden).toBe("function");
    expect(typeof errors.NotFound).toBe("function");
    expect(typeof errors.MethodNotAllowed).toBe("function");
    expect(typeof errors.Conflict).toBe("function");
    expect(typeof errors.Gone).toBe("function");
    expect(typeof errors.UnprocessableEntity).toBe("function");
    expect(typeof errors.TooManyRequests).toBe("function");
    expect(typeof errors.InternalServer).toBe("function");
    expect(typeof errors.NotImplemented).toBe("function");
    expect(typeof errors.BadGateway).toBe("function");
    expect(typeof errors.ServiceUnavailable).toBe("function");
    expect(typeof errors.GatewayTimeout).toBe("function");
  });

  it("should create throwable errors via factories", () => {
    const errors = createErrors();

    const badRequest = errors.BadRequest("Invalid input");
    expect(badRequest instanceof BadRequestError).toBe(true);
    expect(badRequest.message).toBe("Invalid input");

    const notFound = errors.NotFound("User not found", { userId: 123 });
    expect(notFound instanceof NotFoundError).toBe(true);
    expect(notFound.details).toEqual({ userId: 123 });
  });

  it("should create custom errors via custom() method", () => {
    const errors = createErrors();

    const customError = errors.custom(418, "IM_A_TEAPOT", "I'm a teapot");
    expect(customError.status).toBe(418);
    expect(customError.code).toBe("IM_A_TEAPOT");
    expect(customError.message).toBe("I'm a teapot");
  });

  it("should check if error is HttpError via isHttpError()", () => {
    const errors = createErrors();

    const httpError = errors.BadRequest("Test");
    const regularError = new Error("Regular error");

    expect(errors.isHttpError(httpError)).toBe(true);
    expect(errors.isHttpError(regularError)).toBe(false);
    expect(errors.isHttpError("not an error")).toBe(false);
  });

  it("should register custom errors dynamically", () => {
    const errors = createErrors();

    errors.register("PaymentRequired", {
      status: 402,
      code: "PAYMENT_REQUIRED",
      defaultMessage: "Payment is required",
    });

    // After registration, the factory should be available
    const paymentError = (errors as any).PaymentRequired();
    expect(paymentError.status).toBe(402);
    expect(paymentError.code).toBe("PAYMENT_REQUIRED");
    expect(paymentError.message).toBe("Payment is required");
  });

  it("should allow custom message when using registered error", () => {
    const errors = createErrors();

    errors.register("UserSuspended", {
      status: 403,
      code: "USER_SUSPENDED",
      defaultMessage: "Your account has been suspended",
    });

    const error = (errors as any).UserSuspended("Account suspended for policy violation");
    expect(error.message).toBe("Account suspended for policy violation");
    expect(error.code).toBe("USER_SUSPENDED");
  });

  it("should initialize with custom errors from config", () => {
    const errors = createErrors({
      customErrors: {
        QuotaExceeded: {
          status: 429,
          code: "QUOTA_EXCEEDED",
          defaultMessage: "API quota exceeded",
        },
        FeatureDisabled: {
          status: 403,
          code: "FEATURE_DISABLED",
          defaultMessage: "This feature is not available",
        },
      },
    });

    const quotaError = (errors as any).QuotaExceeded();
    expect(quotaError.status).toBe(429);
    expect(quotaError.code).toBe("QUOTA_EXCEEDED");

    const featureError = (errors as any).FeatureDisabled("Premium feature");
    expect(featureError.message).toBe("Premium feature");
  });
});

describe("Plugin Error Registration", () => {
  function createTestCoreServices(db: Kysely<any>): CoreServices {
    return {
      db,
      config: { env: "test" },
      logger: createLogger({ level: "error" }),
      cache: createCache(),
      events: createEvents(),
      cron: createCron(),
      jobs: createJobs({ events: createEvents() }),
      sse: createSSE(),
      rateLimiter: createRateLimiter(),
      errors: createErrors(),
    };
  }

  it("should register plugin custom errors during initialization", async () => {
    const paymentPlugin = createPlugin.define({
      name: "payment",
      customErrors: {
        PaymentFailed: {
          status: 402,
          code: "PAYMENT_FAILED",
          defaultMessage: "Payment processing failed",
        },
        InsufficientFunds: {
          status: 402,
          code: "INSUFFICIENT_FUNDS",
          defaultMessage: "Insufficient funds in account",
        },
      },
      service: async (ctx) => ({
        processPayment: () => {
          // Can throw custom error
          throw (ctx.core.errors as any).InsufficientFunds("Not enough balance");
        },
      }),
    });

    const db = new Kysely<any>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
    });

    const core = createTestCoreServices(db);
    const manager = new PluginManager(core);
    manager.register(paymentPlugin);

    await manager.init();

    // Verify custom errors were registered
    const paymentError = (core.errors as any).PaymentFailed();
    expect(paymentError.status).toBe(402);
    expect(paymentError.code).toBe("PAYMENT_FAILED");

    const fundsError = (core.errors as any).InsufficientFunds("Custom message");
    expect(fundsError.message).toBe("Custom message");
    expect(fundsError.code).toBe("INSUFFICIENT_FUNDS");
  });

  it("should make plugin errors available to route handlers", async () => {
    const testPlugin = createPlugin.define({
      name: "testPlugin",
      customErrors: {
        ResourceLocked: {
          status: 423,
          code: "RESOURCE_LOCKED",
          defaultMessage: "Resource is locked",
        },
      },
      service: async (ctx) => ({
        checkLock: () => {
          // Simulate throwing a custom error
          throw (ctx.core.errors as any).ResourceLocked("File is being edited");
        },
      }),
    });

    const db = new Kysely<any>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
    });

    const core = createTestCoreServices(db);
    const manager = new PluginManager(core);
    manager.register(testPlugin);

    await manager.init();

    const service = manager.getServices().testPlugin;

    // Verify the error is thrown correctly
    let caughtError: HttpError | null = null;
    try {
      service.checkLock();
    } catch (e) {
      caughtError = e as HttpError;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.status).toBe(423);
    expect(caughtError?.code).toBe("RESOURCE_LOCKED");
    expect(caughtError?.message).toBe("File is being edited");
  });
});

describe("Error Usage in Route Handlers", () => {
  it("should support throwing errors in typical handler patterns", () => {
    const errors = createErrors();

    // Simulating route handler pattern
    function getUserById(id: number) {
      if (id <= 0) {
        throw errors.BadRequest("Invalid user ID", { provided: id });
      }
      if (id === 999) {
        throw errors.NotFound("User not found", { userId: id });
      }
      return { id, name: "Test User" };
    }

    // Valid case
    expect(getUserById(1)).toEqual({ id: 1, name: "Test User" });

    // Invalid ID
    expect(() => getUserById(-1)).toThrow(BadRequestError);
    try {
      getUserById(-1);
    } catch (e) {
      expect((e as BadRequestError).details?.provided).toBe(-1);
    }

    // Not found
    expect(() => getUserById(999)).toThrow(NotFoundError);
  });

  it("should work with async handlers", async () => {
    const errors = createErrors();

    async function createUser(data: { email: string }) {
      if (!data.email.includes("@")) {
        throw errors.BadRequest("Invalid email format");
      }
      // Simulate existing email
      if (data.email === "existing@test.com") {
        throw errors.Conflict("Email already registered");
      }
      return { id: 1, email: data.email };
    }

    // Valid
    await expect(createUser({ email: "new@test.com" })).resolves.toEqual({
      id: 1,
      email: "new@test.com",
    });

    // Invalid email
    await expect(createUser({ email: "invalid" })).rejects.toBeInstanceOf(BadRequestError);

    // Conflict
    await expect(createUser({ email: "existing@test.com" })).rejects.toBeInstanceOf(ConflictError);
  });
});
