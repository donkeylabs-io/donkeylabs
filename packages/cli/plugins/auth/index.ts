/**
 * Auth Plugin
 *
 * JWT authentication with refresh tokens. Provides token creation/verification,
 * password hashing, and middleware for protected routes.
 */

import { createPlugin, createMiddleware, type ErrorFactory } from "@donkeylabs/server";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import type { DB } from "./schema";

declare module "@donkeylabs/server" {
  interface ErrorFactories {
    InvalidToken: ErrorFactory;
    TokenRevoked: ErrorFactory;
    InvalidCredentials: ErrorFactory;
    PasswordMismatch: ErrorFactory;
    AuthRequired: ErrorFactory;
  }
}

const scryptAsync = promisify(scrypt);

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface TokenPayload {
  sub: string; // userId
  email: string;
  roles?: string[];
  permissions?: string[];
}

export interface DecodedToken extends JWTPayload {
  sub: string;
  email: string;
  roles?: string[];
  permissions?: string[];
}

export interface AuthService {
  createToken(payload: TokenPayload): Promise<AuthTokens>;
  verifyToken(token: string): Promise<DecodedToken | null>;
  refreshAccessToken(refreshToken: string): Promise<AuthTokens | null>;
  revokeRefreshToken(refreshToken: string): Promise<void>;
  hashPassword(password: string): Promise<string>;
  comparePassword(password: string, hash: string): Promise<boolean>;
}

interface AuthMiddlewareContext {
  user?: DecodedToken;
}

export const authPlugin = createPlugin
  .withSchema<DB>()
  .define({
    name: "auth",
    version: "1.0.0",
    dependencies: ["users"],

    events: {
      "auth.token.created": z.object({
        userId: z.string(),
        tokenType: z.string(),
      }),
      "auth.token.revoked": z.object({
        userId: z.string(),
        tokenId: z.string(),
      }),
      "auth.password.changed": z.object({
        userId: z.string(),
      }),
    },

    customErrors: {
      InvalidToken: {
        status: 401,
        code: "INVALID_TOKEN",
        message: "Invalid or expired token",
      },
      TokenRevoked: {
        status: 401,
        code: "TOKEN_REVOKED",
        message: "Token has been revoked",
      },
      InvalidCredentials: {
        status: 401,
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password",
      },
      PasswordMismatch: {
        status: 400,
        code: "PASSWORD_MISMATCH",
        message: "Passwords do not match",
      },
      AuthRequired: {
        status: 401,
        code: "AUTH_REQUIRED",
        message: "Authentication required",
      },
    },

    service: async (ctx) => {
      const db = ctx.db;
      const logger = ctx.core.logger.child({ plugin: "auth" });
      const config = ctx.config.plugins?.auth || {};
      const secret = new TextEncoder().encode(
        config.jwtSecret || process.env.JWT_SECRET || "default-secret-change-in-production"
      );
      const accessTokenExpiry = config.accessTokenExpiry || "15m";
      const refreshTokenExpiryDays = config.refreshTokenExpiryDays || 7;

      function generateRefreshToken(): string {
        return randomBytes(32).toString("hex");
      }

      function generateTokenId(): string {
        return `tok_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      }

      // Define service methods
      const service: AuthService = {
        async createToken(payload: TokenPayload): Promise<AuthTokens> {
          const now = new Date();
          const expiresIn = 900; // 15 minutes in seconds

          // Create access token
          const accessToken = await new SignJWT({
            sub: payload.sub,
            email: payload.email,
            roles: payload.roles || [],
            permissions: payload.permissions || [],
          })
            .setProtectedHeader({ alg: "HS256" })
            .setIssuedAt()
            .setExpirationTime(accessTokenExpiry)
            .sign(secret);

          // Create refresh token
          const refreshToken = generateRefreshToken();
          const refreshTokenExpiry = new Date(
            now.getTime() + refreshTokenExpiryDays * 24 * 60 * 60 * 1000
          );

          // Store refresh token
          await db
            .insertInto("refresh_tokens")
            .values({
              id: generateTokenId(),
              user_id: payload.sub,
              token_hash: refreshToken,
              expires_at: refreshTokenExpiry.toISOString(),
              created_at: now.toISOString(),
              revoked: 0,
            })
            .execute();

          ctx.core.events.emit("auth.token.created", {
            userId: payload.sub,
            tokenType: "refresh",
          });

          logger.info({ userId: payload.sub }, "Token created");

          return {
            accessToken,
            refreshToken,
            expiresIn,
          };
        },

        async verifyToken(token: string): Promise<DecodedToken | null> {
          try {
            const { payload } = await jwtVerify(token, secret);
            return payload as DecodedToken;
          } catch (error) {
            return null;
          }
        },

        async refreshAccessToken(refreshToken: string): Promise<AuthTokens | null> {
          // Find refresh token
          const tokenRecord = await db
            .selectFrom("refresh_tokens")
            .selectAll()
            .where("token_hash", "=", refreshToken)
            .where("revoked", "=", 0)
            .executeTakeFirst();

          if (!tokenRecord) {
            return null;
          }

          // Check if expired
          if (new Date(tokenRecord.expires_at) < new Date()) {
            return null;
          }

          // Get user
          const user = await ctx.plugins.users.getById(tokenRecord.user_id);
          if (!user) {
            return null;
          }

          // Revoke old refresh token
          await db
            .updateTable("refresh_tokens")
            .set({ revoked: 1 })
            .where("id", "=", tokenRecord.id)
            .execute();

          // Create new tokens
          const tokens = await service.createToken({
            sub: user.id,
            email: user.email,
          });

          ctx.core.events.emit("auth.token.revoked", {
            userId: tokenRecord.user_id,
            tokenId: tokenRecord.id,
          });

          logger.info({ userId: user.id }, "Token refreshed");

          return tokens;
        },

        async revokeRefreshToken(refreshToken: string): Promise<void> {
          const result = await db
            .updateTable("refresh_tokens")
            .set({ revoked: 1 })
            .where("token_hash", "=", refreshToken)
            .returningAll()
            .executeTakeFirst();

          if (result) {
            ctx.core.events.emit("auth.token.revoked", {
              userId: result.user_id,
              tokenId: result.id,
            });
            logger.info({ userId: result.user_id }, "Refresh token revoked");
          }
        },

        async hashPassword(password: string): Promise<string> {
          const salt = randomBytes(16).toString("hex");
          const buf = (await scryptAsync(password, salt, 64)) as Buffer;
          return `${buf.toString("hex")}.${salt}`;
        },

        async comparePassword(password: string, hash: string): Promise<boolean> {
          const [hashedPassword, salt] = hash.split(".");
          const buf = (await scryptAsync(password, salt, 64)) as Buffer;
          return timingSafeEqual(Buffer.from(hashedPassword, "hex"), buf);
        },
      };

      return service;
    },

    middleware: (ctx, service) => ({
      authRequired: createMiddleware(
        async (req, reqCtx, next) => {
          const authHeader = req.headers.get("Authorization");
          if (!authHeader?.startsWith("Bearer ")) {
            throw ctx.core.errors.AuthRequired();
          }

          const token = authHeader.slice(7);
          const decoded = await service.verifyToken(token);

          if (!decoded) {
            throw ctx.core.errors.InvalidToken();
          }

          // Attach user to context
          (reqCtx as AuthMiddlewareContext).user = decoded;

          return next();
        }
      ),

      optionalAuth: createMiddleware(
        async (req, reqCtx, next) => {
          const authHeader = req.headers.get("Authorization");
          if (authHeader?.startsWith("Bearer ")) {
            const token = authHeader.slice(7);
            const decoded = await service.verifyToken(token);
            if (decoded) {
              (reqCtx as AuthMiddlewareContext).user = decoded;
            }
          }
          return next();
        }
      ),
    }),
  });

export type { DB } from "./schema";
export type { AuthMiddlewareContext };
