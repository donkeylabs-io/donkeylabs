/**
 * HTTP Error System
 *
 * Provides throwable HTTP errors that are automatically caught by the server
 * and converted to proper HTTP responses with status codes and error bodies.
 *
 * Usage:
 *   throw ctx.errors.BadRequest("Invalid user ID");
 *   throw ctx.errors.NotFound("User not found", { userId: 123 });
 *   throw ctx.errors.Unauthorized("Please log in");
 */

// ==========================================
// Base HTTP Error
// ==========================================

/**
 * Base class for all HTTP errors.
 * Thrown errors are caught by the server and converted to HTTP responses.
 */
export class HttpError extends Error {
  /** HTTP status code */
  readonly status: number;

  /** Error code for client identification (e.g., "BAD_REQUEST", "USER_NOT_FOUND") */
  readonly code: string;

  /** Additional error details/metadata */
  readonly details?: Record<string, any>;

  /** Original error that caused this error */
  override readonly cause?: Error;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, any>,
    cause?: Error
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.cause = cause;

    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Convert to JSON response body
   */
  toJSON(): Record<string, any> {
    const body: Record<string, any> = {
      error: this.code,
      message: this.message,
    };

    if (this.details && Object.keys(this.details).length > 0) {
      body.details = this.details;
    }

    return body;
  }
}

// ==========================================
// Standard HTTP Error Classes
// ==========================================

/** 400 Bad Request */
export class BadRequestError extends HttpError {
  constructor(message: string = "Bad Request", details?: Record<string, any>, cause?: Error) {
    super(400, "BAD_REQUEST", message, details, cause);
    this.name = "BadRequestError";
  }
}

/** 401 Unauthorized */
export class UnauthorizedError extends HttpError {
  constructor(message: string = "Unauthorized", details?: Record<string, any>, cause?: Error) {
    super(401, "UNAUTHORIZED", message, details, cause);
    this.name = "UnauthorizedError";
  }
}

/** 403 Forbidden */
export class ForbiddenError extends HttpError {
  constructor(message: string = "Forbidden", details?: Record<string, any>, cause?: Error) {
    super(403, "FORBIDDEN", message, details, cause);
    this.name = "ForbiddenError";
  }
}

/** 404 Not Found */
export class NotFoundError extends HttpError {
  constructor(message: string = "Not Found", details?: Record<string, any>, cause?: Error) {
    super(404, "NOT_FOUND", message, details, cause);
    this.name = "NotFoundError";
  }
}

/** 405 Method Not Allowed */
export class MethodNotAllowedError extends HttpError {
  constructor(message: string = "Method Not Allowed", details?: Record<string, any>, cause?: Error) {
    super(405, "METHOD_NOT_ALLOWED", message, details, cause);
    this.name = "MethodNotAllowedError";
  }
}

/** 409 Conflict */
export class ConflictError extends HttpError {
  constructor(message: string = "Conflict", details?: Record<string, any>, cause?: Error) {
    super(409, "CONFLICT", message, details, cause);
    this.name = "ConflictError";
  }
}

/** 410 Gone */
export class GoneError extends HttpError {
  constructor(message: string = "Gone", details?: Record<string, any>, cause?: Error) {
    super(410, "GONE", message, details, cause);
    this.name = "GoneError";
  }
}

/** 422 Unprocessable Entity */
export class UnprocessableEntityError extends HttpError {
  constructor(message: string = "Unprocessable Entity", details?: Record<string, any>, cause?: Error) {
    super(422, "UNPROCESSABLE_ENTITY", message, details, cause);
    this.name = "UnprocessableEntityError";
  }
}

/** 429 Too Many Requests */
export class TooManyRequestsError extends HttpError {
  constructor(message: string = "Too Many Requests", details?: Record<string, any>, cause?: Error) {
    super(429, "TOO_MANY_REQUESTS", message, details, cause);
    this.name = "TooManyRequestsError";
  }
}

/** 500 Internal Server Error */
export class InternalServerError extends HttpError {
  constructor(message: string = "Internal Server Error", details?: Record<string, any>, cause?: Error) {
    super(500, "INTERNAL_SERVER_ERROR", message, details, cause);
    this.name = "InternalServerError";
  }
}

/** 501 Not Implemented */
export class NotImplementedError extends HttpError {
  constructor(message: string = "Not Implemented", details?: Record<string, any>, cause?: Error) {
    super(501, "NOT_IMPLEMENTED", message, details, cause);
    this.name = "NotImplementedError";
  }
}

/** 502 Bad Gateway */
export class BadGatewayError extends HttpError {
  constructor(message: string = "Bad Gateway", details?: Record<string, any>, cause?: Error) {
    super(502, "BAD_GATEWAY", message, details, cause);
    this.name = "BadGatewayError";
  }
}

/** 503 Service Unavailable */
export class ServiceUnavailableError extends HttpError {
  constructor(message: string = "Service Unavailable", details?: Record<string, any>, cause?: Error) {
    super(503, "SERVICE_UNAVAILABLE", message, details, cause);
    this.name = "ServiceUnavailableError";
  }
}

/** 504 Gateway Timeout */
export class GatewayTimeoutError extends HttpError {
  constructor(message: string = "Gateway Timeout", details?: Record<string, any>, cause?: Error) {
    super(504, "GATEWAY_TIMEOUT", message, details, cause);
    this.name = "GatewayTimeoutError";
  }
}

// ==========================================
// Error Factory Type
// ==========================================

/**
 * Factory function signature for creating errors
 */
export type ErrorFactory<T extends HttpError = HttpError> = (
  message?: string,
  details?: Record<string, any>,
  cause?: Error
) => T;

/**
 * Base error factories available on ctx.errors
 */
export interface BaseErrorFactories {
  /** 400 Bad Request */
  BadRequest: ErrorFactory<BadRequestError>;
  /** 401 Unauthorized */
  Unauthorized: ErrorFactory<UnauthorizedError>;
  /** 403 Forbidden */
  Forbidden: ErrorFactory<ForbiddenError>;
  /** 404 Not Found */
  NotFound: ErrorFactory<NotFoundError>;
  /** 405 Method Not Allowed */
  MethodNotAllowed: ErrorFactory<MethodNotAllowedError>;
  /** 409 Conflict */
  Conflict: ErrorFactory<ConflictError>;
  /** 410 Gone */
  Gone: ErrorFactory<GoneError>;
  /** 422 Unprocessable Entity */
  UnprocessableEntity: ErrorFactory<UnprocessableEntityError>;
  /** 429 Too Many Requests */
  TooManyRequests: ErrorFactory<TooManyRequestsError>;
  /** 500 Internal Server Error */
  InternalServer: ErrorFactory<InternalServerError>;
  /** 501 Not Implemented */
  NotImplemented: ErrorFactory<NotImplementedError>;
  /** 502 Bad Gateway */
  BadGateway: ErrorFactory<BadGatewayError>;
  /** 503 Service Unavailable */
  ServiceUnavailable: ErrorFactory<ServiceUnavailableError>;
  /** 504 Gateway Timeout */
  GatewayTimeout: ErrorFactory<GatewayTimeoutError>;
}

/**
 * Extended error factories (augmented by plugins and user)
 */
export interface ErrorFactories extends BaseErrorFactories {}

// ==========================================
// Custom Error Definition
// ==========================================

/**
 * Definition for a custom error type
 */
export interface CustomErrorDefinition {
  /** HTTP status code */
  status: number;
  /** Error code (e.g., "PAYMENT_REQUIRED", "USER_SUSPENDED") */
  code: string;
  /** Default message if none provided */
  defaultMessage?: string;
}

/**
 * Registry of custom error definitions
 */
export type CustomErrorRegistry = Record<string, CustomErrorDefinition>;

// ==========================================
// Error Service
// ==========================================

export interface ErrorsConfig {
  /** Include stack traces in error responses (default: false in production) */
  includeStackTrace?: boolean;
  /** Custom error definitions to register */
  customErrors?: CustomErrorRegistry;
}

export interface Errors extends ErrorFactories {
  /**
   * Create a custom HTTP error
   */
  custom(
    status: number,
    code: string,
    message: string,
    details?: Record<string, any>,
    cause?: Error
  ): HttpError;

  /**
   * Check if an error is an HttpError
   */
  isHttpError(error: unknown): error is HttpError;

  /**
   * Register a custom error type
   */
  register<K extends string>(
    name: K,
    definition: CustomErrorDefinition
  ): void;
}

/**
 * Create the errors service
 */
export function createErrors(config: ErrorsConfig = {}): Errors {
  const customErrors = new Map<string, CustomErrorDefinition>(
    Object.entries(config.customErrors || {})
  );

  // Base error factories
  const errors: Errors = {
    // Standard HTTP errors
    BadRequest: (message, details, cause) =>
      new BadRequestError(message, details, cause),
    Unauthorized: (message, details, cause) =>
      new UnauthorizedError(message, details, cause),
    Forbidden: (message, details, cause) =>
      new ForbiddenError(message, details, cause),
    NotFound: (message, details, cause) =>
      new NotFoundError(message, details, cause),
    MethodNotAllowed: (message, details, cause) =>
      new MethodNotAllowedError(message, details, cause),
    Conflict: (message, details, cause) =>
      new ConflictError(message, details, cause),
    Gone: (message, details, cause) =>
      new GoneError(message, details, cause),
    UnprocessableEntity: (message, details, cause) =>
      new UnprocessableEntityError(message, details, cause),
    TooManyRequests: (message, details, cause) =>
      new TooManyRequestsError(message, details, cause),
    InternalServer: (message, details, cause) =>
      new InternalServerError(message, details, cause),
    NotImplemented: (message, details, cause) =>
      new NotImplementedError(message, details, cause),
    BadGateway: (message, details, cause) =>
      new BadGatewayError(message, details, cause),
    ServiceUnavailable: (message, details, cause) =>
      new ServiceUnavailableError(message, details, cause),
    GatewayTimeout: (message, details, cause) =>
      new GatewayTimeoutError(message, details, cause),

    // Utility methods
    custom: (status, code, message, details, cause) =>
      new HttpError(status, code, message, details, cause),

    isHttpError: (error): error is HttpError =>
      error instanceof HttpError,

    register: (name, definition) => {
      customErrors.set(name, definition);
      // Add factory method dynamically
      (errors as any)[name] = (
        message?: string,
        details?: Record<string, any>,
        cause?: Error
      ) =>
        new HttpError(
          definition.status,
          definition.code,
          message || definition.defaultMessage || definition.code,
          details,
          cause
        );
    },
  };

  // Register any custom errors from config
  for (const [name, definition] of customErrors) {
    errors.register(name, definition);
  }

  return errors;
}

// ==========================================
// Validation Error Helper
// ==========================================

/**
 * Create a BadRequestError with validation details
 * Useful for Zod validation errors
 */
export function createValidationError(
  issues: Array<{ path: (string | number)[]; message: string }>
): BadRequestError {
  return new BadRequestError("Validation Failed", {
    issues: issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
    })),
  });
}
