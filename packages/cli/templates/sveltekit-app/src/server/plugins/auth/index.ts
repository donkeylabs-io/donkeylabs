/**
 * Auth Plugin - User authentication with sessions
 *
 * Provides:
 * - User registration and login
 * - Password hashing with bcrypt
 * - Session-based authentication
 * - Auth middleware for protected routes
 */

import { createPlugin, createMiddleware } from "@donkeylabs/server";
import type { ColumnType } from "kysely";

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

interface AuthSchema {
  users: UsersTable;
  sessions: SessionsTable;
}

// =============================================================================
// TYPES
// =============================================================================

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
}

// =============================================================================
// PLUGIN DEFINITION
// =============================================================================

export const authPlugin = createPlugin
  .withSchema<AuthSchema>()
  .define({
    name: "auth",

    // Custom errors for auth failures
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
      SessionExpired: {
        status: 401,
        code: "SESSION_EXPIRED",
        message: "Your session has expired. Please log in again.",
      },
    },

    service: async (ctx) => {
      const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

      return {
        /**
         * Register a new user
         */
        register: async (data: {
          email: string;
          password: string;
          name?: string;
        }): Promise<{ user: AuthUser; sessionId: string }> => {
          const { email, password, name } = data;

          // Check if email already exists
          const existing = await ctx.db
            .selectFrom("users")
            .where("email", "=", email.toLowerCase())
            .selectAll()
            .executeTakeFirst();

          if (existing) {
            throw ctx.errors.EmailAlreadyExists();
          }

          // Hash password
          const passwordHash = await Bun.password.hash(password, {
            algorithm: "bcrypt",
            cost: 10,
          });

          const userId = crypto.randomUUID();
          const now = new Date().toISOString();

          // Create user
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

          // Create session
          const sessionId = crypto.randomUUID();
          const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

          await ctx.db
            .insertInto("sessions")
            .values({
              id: sessionId,
              user_id: userId,
              expires_at: expiresAt.toISOString(),
              created_at: now,
            })
            .execute();

          ctx.core.logger.info("User registered", { userId, email });

          return {
            user: { id: userId, email: email.toLowerCase(), name: name || null },
            sessionId,
          };
        },

        /**
         * Login with email and password
         */
        login: async (data: {
          email: string;
          password: string;
        }): Promise<{ user: AuthUser; sessionId: string }> => {
          const { email, password } = data;

          // Find user
          const user = await ctx.db
            .selectFrom("users")
            .where("email", "=", email.toLowerCase())
            .selectAll()
            .executeTakeFirst();

          if (!user) {
            throw ctx.errors.InvalidCredentials();
          }

          // Verify password
          const valid = await Bun.password.verify(password, user.password_hash);
          if (!valid) {
            throw ctx.errors.InvalidCredentials();
          }

          // Create session
          const sessionId = crypto.randomUUID();
          const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

          await ctx.db
            .insertInto("sessions")
            .values({
              id: sessionId,
              user_id: user.id,
              expires_at: expiresAt.toISOString(),
              created_at: new Date().toISOString(),
            })
            .execute();

          ctx.core.logger.info("User logged in", { userId: user.id });

          return {
            user: { id: user.id, email: user.email, name: user.name },
            sessionId,
          };
        },

        /**
         * Logout - invalidate session
         */
        logout: async (sessionId: string): Promise<void> => {
          await ctx.db
            .deleteFrom("sessions")
            .where("id", "=", sessionId)
            .execute();
        },

        /**
         * Validate session and get user
         */
        validateSession: async (sessionId: string): Promise<AuthUser | null> => {
          const session = await ctx.db
            .selectFrom("sessions")
            .where("id", "=", sessionId)
            .selectAll()
            .executeTakeFirst();

          if (!session) {
            return null;
          }

          // Check if expired
          if (new Date(session.expires_at) < new Date()) {
            // Clean up expired session
            await ctx.db
              .deleteFrom("sessions")
              .where("id", "=", sessionId)
              .execute();
            return null;
          }

          // Get user
          const user = await ctx.db
            .selectFrom("users")
            .where("id", "=", session.user_id)
            .selectAll()
            .executeTakeFirst();

          if (!user) {
            return null;
          }

          return {
            id: user.id,
            email: user.email,
            name: user.name,
          };
        },

        /**
         * Get user by ID
         */
        getUserById: async (userId: string): Promise<AuthUser | null> => {
          const user = await ctx.db
            .selectFrom("users")
            .where("id", "=", userId)
            .selectAll()
            .executeTakeFirst();

          if (!user) {
            return null;
          }

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
            // Check if email is taken by another user
            const existing = await ctx.db
              .selectFrom("users")
              .where("email", "=", data.email.toLowerCase())
              .where("id", "!=", userId)
              .selectAll()
              .executeTakeFirst();

            if (existing) {
              throw ctx.errors.EmailAlreadyExists();
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
         * Delete all expired sessions (cleanup job)
         */
        cleanupExpiredSessions: async (): Promise<number> => {
          const result = await ctx.db
            .deleteFrom("sessions")
            .where("expires_at", "<", new Date().toISOString())
            .executeTakeFirst();

          const count = Number(result.numDeletedRows);
          if (count > 0) {
            ctx.core.logger.info("Cleaned up expired sessions", { count });
          }
          return count;
        },
      };
    },

    /**
     * Auth middleware - validates session from cookie/header
     */
    middleware: (ctx, service) => ({
      /**
       * Require authentication middleware
       * Sets ctx.user if valid session found
       * Returns 401 if required and no valid session
       */
      auth: createMiddleware<{ required?: boolean }>(
        async (req, reqCtx, next, config) => {
          // Get session ID from cookie or Authorization header
          const cookies = req.headers.get("cookie") || "";
          const cookieMatch = cookies.match(/session=([^;]+)/);
          const headerToken = req.headers.get("authorization")?.replace("Bearer ", "");

          const sessionId = cookieMatch?.[1] || headerToken;

          if (sessionId) {
            const user = await service.validateSession(sessionId);
            if (user) {
              // Set user on request context
              (reqCtx as any).user = user;
              (reqCtx as any).sessionId = sessionId;
            }
          }

          // If auth is required and no user, return 401
          if (config?.required && !(reqCtx as any).user) {
            return Response.json(
              { error: "Unauthorized", code: "UNAUTHORIZED" },
              { status: 401 }
            );
          }

          return next();
        }
      ),
    }),

    /**
     * Initialize cleanup cron job
     */
    init: async (ctx, service) => {
      // Clean up expired sessions daily at 3am
      ctx.core.cron.schedule(
        "0 3 * * *",
        async () => {
          await service.cleanupExpiredSessions();
        },
        { name: "auth-session-cleanup" }
      );

      ctx.core.logger.info("Auth plugin initialized");
    },
  });
