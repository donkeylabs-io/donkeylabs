/**
 * Auth Router - Authentication endpoints
 *
 * Provides:
 * - auth.register - Create new account
 * - auth.login - Login and get tokens
 * - auth.refresh - Refresh access token (refresh-token strategy only)
 * - auth.logout - Invalidate session/token
 * - auth.me - Get current user
 * - auth.updateProfile - Update profile
 */

import { createRouter } from "@donkeylabs/server";
import { z } from "zod";
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  updateProfileSchema,
  authResponseSchema,
  refreshResponseSchema,
  userSchema,
  logoutResponseSchema,
} from "./auth.schemas";
import { RegisterHandler } from "./handlers/register.handler";
import { LoginHandler } from "./handlers/login.handler";
import { RefreshHandler } from "./handlers/refresh.handler";
import { LogoutHandler } from "./handlers/logout.handler";
import { MeHandler } from "./handlers/me.handler";
import { UpdateProfileHandler } from "./handlers/update-profile.handler";

export const authRouter = createRouter("auth")

  // Public routes
  .route("register").typed({
    input: registerSchema,
    output: authResponseSchema,
    handle: RegisterHandler,
  })

  .route("login").typed({
    input: loginSchema,
    output: authResponseSchema,
    handle: LoginHandler,
  })

  // Refresh token (for refresh-token strategy)
  .route("refresh").typed({
    input: refreshSchema,
    output: refreshResponseSchema,
    handle: RefreshHandler,
  })

  // Get current user (returns null if not authenticated)
  .route("me").typed({
    input: z.object({}),
    output: userSchema.nullable(),
    handle: MeHandler,
  })

  // Logout (invalidate session/token)
  .route("logout").typed({
    input: z.object({}),
    output: logoutResponseSchema,
    handle: LogoutHandler,
  })

  // Update profile
  .route("updateProfile").typed({
    input: updateProfileSchema,
    output: userSchema,
    handle: UpdateProfileHandler,
  });
