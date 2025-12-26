import jwt from "jsonwebtoken";
import { APIErrors, type TokenPayload } from "@donkeylabs/core";
import { logger } from "@donkeylabs/audit-logs";
import { LOG } from "../log";

export function createAuthToken(
  secretKey: string,
  payload: {
    userId: number;
    permissions: string[];
  },
): string {
  try {
    const token = jwt.sign(payload, secretKey, { expiresIn: "10m" });
    LOG.tag("JWT").debug("Auth token created", { userId: payload.userId, permissionCount: payload.permissions.length });
    return token;
  } catch (error) {
    logger.auth.error("Unable to create auth token", error);
    throw APIErrors.internalServerError({}, error);
  }
}

export function createAuthTokenGeneric<T extends object>(
  secretKey: string,
  payload: T,
  expiresIn: "30d" | "10m" = "30d",
): string {
  try {
    return jwt.sign(payload, secretKey, { expiresIn });
  } catch (error) {
    logger.auth.error("Unable to create auth token", error);
    throw APIErrors.internalServerError({}, error);
  }
}

export function verifyAuthToken(secretKey: string, token: string): TokenPayload {
  try {
    const payload = jwt.verify(token, secretKey) as TokenPayload;
    LOG.tag("JWT").debug("Token verified", { userId: payload.userId });
    return payload;
  } catch (error) {
    // Differentiate between token error types for better debugging
    if (error instanceof jwt.TokenExpiredError) {
      LOG.tag("JWT").warn("Token expired", { expiredAt: error.expiredAt });
    } else if (error instanceof jwt.JsonWebTokenError) {
      LOG.tag("JWT").warn("Invalid token", { reason: error.message });
    } else {
      logger.auth.error("Unable to verify auth token", error);
    }
    throw APIErrors.unauthorized({}, error);
  }
}

export function verifyAuthTokenGeneric<T>(secretKey: string, token: string): T {
  try {
    return jwt.verify(token, secretKey) as T;
  } catch (error) {
    logger.auth.error("Unable to verify auth token", error);
    throw APIErrors.unauthorized({}, error);
  }
}
