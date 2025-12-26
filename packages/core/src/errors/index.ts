import { z } from "zod";

export enum ErrorType {
  REFRESH_TOKEN_EXPIRED = "REFRESH_TOKEN_EXPIRED",
  INVALID_CREDENTIALS = "INVALID_CREDENTIALS",
  UNAUTHORIZED = "UNAUTHORIZED",
  FORBIDDEN = "FORBIDDEN",
  NOT_FOUND = "NOT_FOUND",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR",
  SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE",
  GATEWAY_TIMEOUT = "GATEWAY_TIMEOUT",
  VERIFY_PASSKEY_REGISTRATION_ERROR = "VERIFY_PASSKEY_REGISTRATION_ERROR",
  NO_PASSKEY_REGISTRATION_OPTIONS = "NO_PASSKEY_REGISTRATION_OPTIONS",
  NO_PASSKEY_AUTHENTICATION_OPTIONS = "NO_PASSKEY_AUTHENTICATION_OPTIONS",
  PASSKEY_ALREADY_REGISTERED = "PASSKEY_ALREADY_REGISTERED",
  PASSKEY_NOT_FOUND = "PASSKEY_NOT_FOUND",
  INVALID_PASSKEY_AUTHENTICATION_RESPONSE = "INVALID_PASSKEY_AUTHENTICATION_RESPONSE",
  VERIFY_PASSKEY_AUTHENTICATION_ERROR = "VERIFY_PASSKEY_AUTHENTICATION_ERROR",
  WORK_ORDER_ALREADY_EXISTS = "WORK_ORDER_ALREADY_EXISTS",
  RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED",
  API_VERSION_DEPRECATED = "API_VERSION_DEPRECATED",
  // Add more error types as needed
}

export const ApiErrorResponseSchema = z.object({
  type: z.nativeEnum(ErrorType),
  message: z.string(),
  details: z.record(z.string(), z.any()).optional(),
  stack: z.string().optional(),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export function getHttpStatus(errorType: ErrorType): number {
  switch (errorType) {
    case ErrorType.REFRESH_TOKEN_EXPIRED:
    case ErrorType.UNAUTHORIZED:
      return 401;
    case ErrorType.FORBIDDEN:
      return 403;
    case ErrorType.NOT_FOUND:
    case ErrorType.API_VERSION_DEPRECATED:
      return 404;
    case ErrorType.VALIDATION_ERROR:
    case ErrorType.WORK_ORDER_ALREADY_EXISTS:
      return 400;
    case ErrorType.RATE_LIMIT_EXCEEDED:
      return 429;
    case ErrorType.SERVICE_UNAVAILABLE:
      return 503;
    case ErrorType.GATEWAY_TIMEOUT:
      return 504;
    default:
      return 500;
  }
}

export class ApiError extends Error {
  type: ErrorType;
  details?: Record<string, any>;
  critical: boolean;

  constructor(
    type: ErrorType,
    message: string,
    details?: Record<string, any>,
    error?: any,
    critical: boolean = false,
  ) {
    super(message);
    this.type = type;
    this.details = details;
    this.name = "ApiError";
    this.stack = error instanceof Error ? error.stack : undefined;
    this.critical = critical;
  }

  log() {
    // log the error with the stack trace
    console.error("API ERROR: " + this.type + " - " + this.message);
    if (this.details) {
      console.error(this.details);
    }
    if (this.stack) {
      console.error(this.stack);
    }
  }

  toResponse(): ApiErrorResponse {
    return {
      type: this.type,
      message: this.message,
      details: this.details,
      stack: process.env.NODE_ENV === "development" ? this.stack : undefined,
    };
  }
}

// Error factory functions for common errors
export const APIErrors = {
  refreshTokenExpired: (details?: Record<string, any>, error?: any) =>
    new ApiError(
      ErrorType.REFRESH_TOKEN_EXPIRED,
      "Sesion expirada, por favor inicie sesion de nuevo",
      details,
      error,
    ),

  workOrderAlreadyExists: (details?: Record<string, any>, error?: any) =>
    new ApiError(
      ErrorType.WORK_ORDER_ALREADY_EXISTS,
      "La cotización ya tiene una orden de trabajo",
      details,
      error,
    ),

  noPasskeyAuthenticationOptions: (details?: Record<string, any>, error?: any) =>
    new ApiError(
      ErrorType.NO_PASSKEY_AUTHENTICATION_OPTIONS,
      "No se encontraron opciones de autenticación de passkey",
      details,
      error,
    ),

  invalidPasskeyAuthenticationResponse: (details?: Record<string, any>, error?: any) =>
    new ApiError(
      ErrorType.INVALID_PASSKEY_AUTHENTICATION_RESPONSE,
      "La respuesta de autenticación de passkey es inválida",
      details,
      error,
    ),

  passkeyNotFound: (details?: Record<string, any>, error?: any) =>
    new ApiError(ErrorType.PASSKEY_NOT_FOUND, "La passkey no se encontró", details, error),

  passkeyAlreadyRegistered: (details?: Record<string, any>, error?: any) =>
    new ApiError(ErrorType.PASSKEY_ALREADY_REGISTERED, "La passkey ya está registrada", details, error),

  invalidCredentials: (details?: Record<string, any>, error?: any) =>
    new ApiError(ErrorType.INVALID_CREDENTIALS, "Codigo o nombre de usuario incorrecto", details, error),

  unauthorized: (details?: Record<string, any>, error?: any) =>
    new ApiError(ErrorType.UNAUTHORIZED, "No tienes permisos para acceder a esta pagina", details, error),

  forbidden: (details?: Record<string, any>, error?: any) =>
    new ApiError(ErrorType.FORBIDDEN, "No tienes permisos para acceder a esta pagina", details, error),

  notFound: (details?: Record<string, any>, error?: any) =>
    new ApiError(ErrorType.NOT_FOUND, "No se encontró", details, error),

  validationError: (details?: Record<string, any>, error?: any) =>
    new ApiError(ErrorType.VALIDATION_ERROR, "Error de validación", details, error),

  internalServerError: (details?: Record<string, any>, error?: any) =>
    new ApiError(ErrorType.INTERNAL_SERVER_ERROR, "Error del servidor", details, error),

  serviceUnavailable: (details?: Record<string, any>, error?: any) =>
    new ApiError(ErrorType.SERVICE_UNAVAILABLE, "Servicio no disponible temporalmente", details, error),

  gatewayTimeout: (details?: Record<string, any>, error?: any) =>
    new ApiError(ErrorType.GATEWAY_TIMEOUT, "La solicitud tardó demasiado tiempo", details, error),

  noPasskeyRegistrationOptions: (details?: Record<string, any>, error?: any) =>
    new ApiError(
      ErrorType.NO_PASSKEY_REGISTRATION_OPTIONS,
      "No se encontraron opciones de registro de passkey",
      details,
      error,
    ),

  verifyPasskeyRegistrationError: (details?: Record<string, any>, error?: any) =>
    new ApiError(
      ErrorType.VERIFY_PASSKEY_REGISTRATION_ERROR,
      "Error al verificar la respuesta de registro de passkey",
      details,
      error,
    ),

  verifyPasskeyAuthenticationError: (details?: Record<string, any>, error?: any) =>
    new ApiError(
      ErrorType.VERIFY_PASSKEY_AUTHENTICATION_ERROR,
      "Error al verificar la respuesta de autenticación de passkey",
      details,
      error,
    ),

  rateLimitExceeded: (details?: Record<string, any>, error?: any) =>
    new ApiError(
      ErrorType.RATE_LIMIT_EXCEEDED,
      "Demasiados intentos. Por favor espera antes de intentar de nuevo.",
      details,
      error,
    ),

  apiVersionDeprecated: (details?: Record<string, any>, error?: any) =>
    new ApiError(
      ErrorType.API_VERSION_DEPRECATED,
      "Version de API obsoleta, por favor actualiza.",
      details,
      error,
    ),

  conflict: (details?: Record<string, any>, error?: any) =>
    new ApiError(ErrorType.VALIDATION_ERROR, details?.message ?? "Conflicto de datos", details, error),

  badRequest: (details?: Record<string, any>, error?: any) =>
    new ApiError(ErrorType.VALIDATION_ERROR, details?.message ?? "Solicitud inválida", details, error),

  fromResponse: (response: string): ApiError => {
    const parsedResponse = ApiErrorResponseSchema.parse(response);
    return new ApiError(
      parsedResponse.type,
      parsedResponse.message,
      parsedResponse.details,
      parsedResponse.stack,
    );
  },

  // Add more factory functions as needed
};
