/**
 * Auth Plugin - Configurable authentication with multiple strategies
 *
 * Strategies:
 * - session: Stateful, database sessions (default)
 * - jwt: Stateless JWT tokens
 * - refresh-token: Access token + refresh token pattern
 *
 * Storage:
 * - cookie: HTTP-only cookies (recommended for web)
 * - header: Authorization header (for APIs/mobile)
 * - both: Support both methods
 */

import { createPlugin, createMiddleware } from "@donkeylabs/server";
import type { ColumnType } from "kysely";

// =============================================================================
// CONFIGURATION TYPES
// =============================================================================

export type AuthStrategy = "session" | "jwt" | "refresh-token";
export type TokenStorage = "cookie" | "header" | "both";

export interface AuthConfig {
  /**
   * Authentication strategy
   * - session: Stateful, stores sessions in database
   * - jwt: Stateless, token contains user info
   * - refresh-token: Short-lived access + long-lived refresh token
   * @default "session"
   */
  strategy?: AuthStrategy;

  /**
   * How tokens/sessions are transmitted
   * - cookie: HTTP-only cookies (secure for web apps)
   * - header: Authorization header (for APIs/mobile)
   * - both: Accept both methods
   * @default "both"
   */
  storage?: TokenStorage;

  /**
   * Cookie configuration (when storage includes cookies)
   */
  cookie?: {
    /** Cookie name prefix @default "auth" */
    name?: string;
    /** HTTP-only flag @default true */
    httpOnly?: boolean;
    /** Secure flag (HTTPS only) @default true in production */
    secure?: boolean;
    /** SameSite policy @default "lax" */
    sameSite?: "strict" | "lax" | "none";
    /** Cookie path @default "/" */
    path?: string;
    /** Cookie domain (optional) */
    domain?: string;
  };

  /**
   * JWT configuration (for jwt and refresh-token strategies)
   */
  jwt?: {
    /** Secret key for signing tokens (required for jwt/refresh-token) */
    secret: string;
    /** Access token expiry @default "15m" for refresh-token, "7d" for jwt */
    accessExpiry?: string;
    /** Refresh token expiry @default "30d" (refresh-token strategy only) */
    refreshExpiry?: string;
    /** Token issuer (optional) */
    issuer?: string;
  };

  /**
   * Session configuration (for session strategy)
   */
  session?: {
    /** Session duration @default "7d" */
    expiry?: string;
  };

  /**
   * Password hashing cost @default 10
   */
  bcryptCost?: number;
}

// =============================================================================
// DATABASE SCHEMA TYPES
// =============================================================================

interface UsersTable {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  created_at: ColumnType<string, string | undefined, never>;
  updated_at: string;
}

interface SessionsTable {
  id: string;
  user_id: string;
  expires_at: string;
  created_at: ColumnType<string, string | undefined, never>;
}

interface RefreshTokensTable {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: ColumnType<string, string | undefined, never>;
}

interface AuthSchema {
  users: UsersTable;
  sessions: SessionsTable;
  refresh_tokens: RefreshTokensTable;
}

// =============================================================================
// EXPORTED TYPES
// =============================================================================

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

export interface AuthResult {
  user: AuthUser;
  tokens: AuthTokens;
}

// =============================================================================
// HELPERS
// =============================================================================

function parseExpiry(expiry: string): number {
  const match = expiry.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 7 * 24 * 60 * 60 * 1000; // Default 7 days

  const value = parseInt(match[1]);
  const unit = match[2];

  switch (unit) {
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return 7 * 24 * 60 * 60 * 1000;
  }
}

interface JWTPayload {
  sub: string;
  email: string;
  name: string | null;
  iat: number;
  exp: number;
  iss?: string;
  type?: "access" | "refresh";
}

function base64UrlEncode(data: string): string {
  return btoa(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64UrlDecode(data: string): string {
  const padded = data + "=".repeat((4 - (data.length % 4)) % 4);
  return atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
}

async function signJWT(payload: JWTPayload, secret: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));

  const data = `${encodedHeader}.${encodedPayload}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const encodedSignature = base64UrlEncode(
    String.fromCharCode(...new Uint8Array(signature))
  );

  return `${data}.${encodedSignature}`;
}

async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    if (!encodedHeader || !encodedPayload || !encodedSignature) return null;

    const data = `${encodedHeader}.${encodedPayload}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const signature = Uint8Array.from(
      base64UrlDecode(encodedSignature),
      (c) => c.charCodeAt(0)
    );

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      encoder.encode(data)
    );

    if (!valid) return null;

    const payload: JWTPayload = JSON.parse(base64UrlDecode(encodedPayload));

    // Check expiry
    if (payload.exp * 1000 < Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

// =============================================================================
// PLUGIN DEFINITION
// =============================================================================

export const authPlugin = createPlugin
  .withSchema<AuthSchema>()
  .withConfig<AuthConfig>()
  .define({
    name: "auth",

    customErrors: {
      InvalidCredentials: {
        status: 401,
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password",
      },
      EmailAlreadyExists: {
        status: 409,
        code: "EMAIL_EXISTS",
        message: "An account with this email already exists",
      },
      InvalidToken: {
        status: 401,
        code: "INVALID_TOKEN",
        message: "Invalid or expired token",
      },
      RefreshTokenExpired: {
        status: 401,
        code: "REFRESH_TOKEN_EXPIRED",
        message: "Refresh token has expired. Please log in again.",
      },
    },

    service: async (ctx) => {
      const config = ctx.config || {};
      const strategy = config.strategy || "session";
      const storage = config.storage || "both";
      const bcryptCost = config.bcryptCost || 10;

      // Expiry defaults based on strategy
      const accessExpiryMs = parseExpiry(
        config.jwt?.accessExpiry ||
        (strategy === "refresh-token" ? "15m" : "7d")
      );
      const refreshExpiryMs = parseExpiry(config.jwt?.refreshExpiry || "30d");
      const sessionExpiryMs = parseExpiry(config.session?.expiry || "7d");

      const jwtSecret = config.jwt?.secret || "";

      // Validate config
      if ((strategy === "jwt" || strategy === "refresh-token") && !jwtSecret) {
        throw new Error("Auth plugin: jwt.secret is required for jwt/refresh-token strategy");
      }

      /**
       * Create tokens based on strategy
       */
      async function createTokens(user: AuthUser): Promise<AuthTokens> {
        const now = Math.floor(Date.now() / 1000);

        if (strategy === "jwt") {
          const payload: JWTPayload = {
            sub: user.id,
            email: user.email,
            name: user.name,
            iat: now,
            exp: now + Math.floor(accessExpiryMs / 1000),
            iss: config.jwt?.issuer,
          };

          const accessToken = await signJWT(payload, jwtSecret);
          return {
            accessToken,
            expiresIn: Math.floor(accessExpiryMs / 1000),
          };
        }

        if (strategy === "refresh-token") {
          // Access token (short-lived)
          const accessPayload: JWTPayload = {
            sub: user.id,
            email: user.email,
            name: user.name,
            iat: now,
            exp: now + Math.floor(accessExpiryMs / 1000),
            iss: config.jwt?.issuer,
            type: "access",
          };

          // Refresh token (long-lived, stored in DB)
          const refreshTokenId = crypto.randomUUID();
          const refreshPayload: JWTPayload = {
            sub: user.id,
            email: user.email,
            name: user.name,
            iat: now,
            exp: now + Math.floor(refreshExpiryMs / 1000),
            iss: config.jwt?.issuer,
            type: "refresh",
          };

          const accessToken = await signJWT(accessPayload, jwtSecret);
          const refreshToken = await signJWT(refreshPayload, jwtSecret);

          // Hash and store refresh token
          const tokenHash = await Bun.password.hash(refreshToken, {
            algorithm: "bcrypt",
            cost: 4, // Lower cost for refresh tokens (checked less often)
          });

          await ctx.db
            .insertInto("refresh_tokens")
            .values({
              id: refreshTokenId,
              user_id: user.id,
              token_hash: tokenHash,
              expires_at: new Date(Date.now() + refreshExpiryMs).toISOString(),
              created_at: new Date().toISOString(),
            })
            .execute();

          return {
            accessToken,
            refreshToken,
            expiresIn: Math.floor(accessExpiryMs / 1000),
          };
        }

        // Session strategy - create DB session
        const sessionId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + sessionExpiryMs);

        await ctx.db
          .insertInto("sessions")
          .values({
            id: sessionId,
            user_id: user.id,
            expires_at: expiresAt.toISOString(),
            created_at: new Date().toISOString(),
          })
          .execute();

        return {
          accessToken: sessionId,
          expiresIn: Math.floor(sessionExpiryMs / 1000),
        };
      }

      /**
       * Validate token and return user
       */
      async function validateToken(token: string): Promise<AuthUser | null> {
        if (strategy === "jwt" || strategy === "refresh-token") {
          const payload = await verifyJWT(token, jwtSecret);
          if (!payload) return null;

          // For refresh-token strategy, only accept access tokens in middleware
          if (strategy === "refresh-token" && payload.type !== "access") {
            return null;
          }

          return {
            id: payload.sub,
            email: payload.email,
            name: payload.name,
          };
        }

        // Session strategy - lookup in DB
        const session = await ctx.db
          .selectFrom("sessions")
          .where("id", "=", token)
          .selectAll()
          .executeTakeFirst();

        if (!session) return null;

        if (new Date(session.expires_at) < new Date()) {
          await ctx.db.deleteFrom("sessions").where("id", "=", token).execute();
          return null;
        }

        const user = await ctx.db
          .selectFrom("users")
          .where("id", "=", session.user_id)
          .selectAll()
          .executeTakeFirst();

        if (!user) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
        };
      }

      return {
        /** Get current strategy */
        getStrategy: () => strategy,

        /** Get storage type */
        getStorage: () => storage,

        /** Get cookie config */
        getCookieConfig: () => ({
          name: config.cookie?.name || "auth",
          httpOnly: config.cookie?.httpOnly ?? true,
          secure: config.cookie?.secure ?? process.env.NODE_ENV === "production",
          sameSite: config.cookie?.sameSite || "lax",
          path: config.cookie?.path || "/",
          domain: config.cookie?.domain,
        }),

        /**
         * Register a new user
         */
        register: async (data: {
          email: string;
          password: string;
          name?: string;
        }): Promise<AuthResult> => {
          const { email, password, name } = data;

          const existing = await ctx.db
            .selectFrom("users")
            .where("email", "=", email.toLowerCase())
            .selectAll()
            .executeTakeFirst();

          if (existing) {
            throw ctx.core.errors.BadRequest();
          }

          const passwordHash = await Bun.password.hash(password, {
            algorithm: "bcrypt",
            cost: bcryptCost,
          });

          const userId = crypto.randomUUID();
          const now = new Date().toISOString();

          await ctx.db
            .insertInto("users")
            .values({
              id: userId,
              email: email.toLowerCase(),
              password_hash: passwordHash,
              name: name || null,
              created_at: now,
              updated_at: now,
            })
            .execute();

          const user: AuthUser = {
            id: userId,
            email: email.toLowerCase(),
            name: name || null,
          };

          const tokens = await createTokens(user);

          ctx.core.logger.info("User registered", { userId, email, strategy });

          return { user, tokens };
        },

        /**
         * Login with email and password
         */
        login: async (data: {
          email: string;
          password: string;
        }): Promise<AuthResult> => {
          const { email, password } = data;

          const dbUser = await ctx.db
            .selectFrom("users")
            .where("email", "=", email.toLowerCase())
            .selectAll()
            .executeTakeFirst();

          if (!dbUser) {
            throw ctx.core.errors.Unauthorized();
          }

          const valid = await Bun.password.verify(password, dbUser.password_hash);
          if (!valid) {
            throw ctx.core.errors.Unauthorized();
          }

          const user: AuthUser = {
            id: dbUser.id,
            email: dbUser.email,
            name: dbUser.name,
          };

          const tokens = await createTokens(user);

          ctx.core.logger.info("User logged in", { userId: user.id, strategy });

          return { user, tokens };
        },

        /**
         * Refresh access token (refresh-token strategy only)
         */
        refresh: async (refreshToken: string): Promise<AuthTokens> => {
          if (strategy !== "refresh-token") {
            throw new Error("refresh() only available with refresh-token strategy");
          }

          const payload = await verifyJWT(refreshToken, jwtSecret);
          if (!payload || payload.type !== "refresh") {
            throw ctx.core.errors.Unauthorized();
          }

          // Verify refresh token exists in DB (not revoked)
          const stored = await ctx.db
            .selectFrom("refresh_tokens")
            .where("user_id", "=", payload.sub)
            .selectAll()
            .execute();

          let validToken = false;
          for (const t of stored) {
            if (await Bun.password.verify(refreshToken, t.token_hash)) {
              validToken = true;
              break;
            }
          }

          if (!validToken) {
            throw ctx.core.errors.Unauthorized();
          }

          // Get user
          const user = await ctx.db
            .selectFrom("users")
            .where("id", "=", payload.sub)
            .selectAll()
            .executeTakeFirst();

          if (!user) {
            throw ctx.core.errors.Unauthorized();
          }

          // Create new access token (keep same refresh token)
          const now = Math.floor(Date.now() / 1000);
          const accessPayload: JWTPayload = {
            sub: user.id,
            email: user.email,
            name: user.name,
            iat: now,
            exp: now + Math.floor(accessExpiryMs / 1000),
            iss: config.jwt?.issuer,
            type: "access",
          };

          const accessToken = await signJWT(accessPayload, jwtSecret);

          return {
            accessToken,
            expiresIn: Math.floor(accessExpiryMs / 1000),
          };
        },

        /**
         * Logout - invalidate session/refresh token
         */
        logout: async (token: string): Promise<void> => {
          if (strategy === "session") {
            await ctx.db.deleteFrom("sessions").where("id", "=", token).execute();
          } else if (strategy === "refresh-token") {
            // For refresh-token, we receive the refresh token to revoke
            const payload = await verifyJWT(token, jwtSecret);
            if (payload) {
              // Delete all refresh tokens for this user (logout everywhere)
              // Or could do selective deletion by matching hash
              await ctx.db
                .deleteFrom("refresh_tokens")
                .where("user_id", "=", payload.sub)
                .execute();
            }
          }
          // JWT strategy: tokens are stateless, nothing to invalidate
        },

        /**
         * Logout from all devices
         */
        logoutAll: async (userId: string): Promise<void> => {
          if (strategy === "session") {
            await ctx.db.deleteFrom("sessions").where("user_id", "=", userId).execute();
          } else if (strategy === "refresh-token") {
            await ctx.db.deleteFrom("refresh_tokens").where("user_id", "=", userId).execute();
          }
        },

        /**
         * Validate token/session and get user
         */
        validateToken,

        /**
         * Get user by ID
         */
        getUserById: async (userId: string): Promise<AuthUser | null> => {
          const user = await ctx.db
            .selectFrom("users")
            .where("id", "=", userId)
            .selectAll()
            .executeTakeFirst();

          if (!user) return null;

          return {
            id: user.id,
            email: user.email,
            name: user.name,
          };
        },

        /**
         * Update user profile
         */
        updateProfile: async (
          userId: string,
          data: { name?: string; email?: string }
        ): Promise<AuthUser> => {
          const updates: Record<string, string> = {
            updated_at: new Date().toISOString(),
          };

          if (data.name !== undefined) {
            updates.name = data.name;
          }

          if (data.email !== undefined) {
            const existing = await ctx.db
              .selectFrom("users")
              .where("email", "=", data.email.toLowerCase())
              .where("id", "!=", userId)
              .selectAll()
              .executeTakeFirst();

            if (existing) {
              throw ctx.core.errors.BadRequest();
            }

            updates.email = data.email.toLowerCase();
          }

          await ctx.db
            .updateTable("users")
            .set(updates)
            .where("id", "=", userId)
            .execute();

          const user = await ctx.db
            .selectFrom("users")
            .where("id", "=", userId)
            .selectAll()
            .executeTakeFirstOrThrow();

          return {
            id: user.id,
            email: user.email,
            name: user.name,
          };
        },

        /**
         * Cleanup expired sessions/tokens
         */
        cleanup: async (): Promise<number> => {
          const now = new Date().toISOString();
          let count = 0;

          if (strategy === "session") {
            const result = await ctx.db
              .deleteFrom("sessions")
              .where("expires_at", "<", now)
              .executeTakeFirst();
            count = Number(result.numDeletedRows);
          } else if (strategy === "refresh-token") {
            const result = await ctx.db
              .deleteFrom("refresh_tokens")
              .where("expires_at", "<", now)
              .executeTakeFirst();
            count = Number(result.numDeletedRows);
          }

          if (count > 0) {
            ctx.core.logger.info("Auth cleanup completed", { count, strategy });
          }
          return count;
        },
      };
    },

    middleware: (ctx, service) => ({
      /**
       * Auth middleware - validates token from cookie/header
       */
      auth: createMiddleware<{ required?: boolean }>(
        async (req, reqCtx, next, middlewareConfig) => {
          const storage = service.getStorage();
          const cookieConfig = service.getCookieConfig();

          let token: string | null = null;

          // Try cookie first (if enabled)
          if (storage === "cookie" || storage === "both") {
            const cookies = req.headers.get("cookie") || "";
            const cookieMatch = cookies.match(
              new RegExp(`${cookieConfig.name}=([^;]+)`)
            );
            token = cookieMatch?.[1] || null;
          }

          // Try header (if enabled and no cookie found)
          if (!token && (storage === "header" || storage === "both")) {
            const authHeader = req.headers.get("authorization");
            if (authHeader?.startsWith("Bearer ")) {
              token = authHeader.slice(7);
            }
          }

          if (token) {
            const user = await service.validateToken(token);
            if (user) {
              (reqCtx as any).user = user;
              (reqCtx as any).token = token;
            }
          }

          if (middlewareConfig?.required && !(reqCtx as any).user) {
            return Response.json(
              { error: "Unauthorized", code: "UNAUTHORIZED" },
              { status: 401 }
            );
          }

          return next();
        }
      ),
    }),

    init: async (ctx, service) => {
      const strategy = service.getStrategy();

      // Schedule cleanup based on strategy
      if (strategy === "session" || strategy === "refresh-token") {
        ctx.core.cron.schedule(
          "0 3 * * *", // Daily at 3am
          async () => {
            await service.cleanup();
          },
          { name: "auth-cleanup" }
        );
      }

      ctx.core.logger.info("Auth plugin initialized", {
        strategy,
        storage: service.getStorage(),
      });
    },
  });
