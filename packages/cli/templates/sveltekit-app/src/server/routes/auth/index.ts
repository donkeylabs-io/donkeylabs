/**
 * Auth Router - Authentication endpoints
 *
 * Provides:
 * - auth.register - Create new account
 * - auth.login - Login and get session
 * - auth.logout - Invalidate session (requires auth)
 * - auth.me - Get current user (optional auth)
 * - auth.updateProfile - Update profile (requires auth)
 */

import { createRouter } from "@donkeylabs/server";
import { z } from "zod";
import {
  registerSchema,
  loginSchema,
  updateProfileSchema,
  authResponseSchema,
  userSchema,
  logoutResponseSchema,
} from "./auth.schemas";
import { RegisterHandler } from "./handlers/register.handler";
import { LoginHandler } from "./handlers/login.handler";
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

  // Optional auth - returns user if logged in, null otherwise
  .middleware.auth({ required: false })
  .route("me").typed({
    input: z.object({}),
    output: userSchema.nullable(),
    handle: MeHandler,
  })

  // Protected routes - require authentication
  .middleware.auth({ required: true })
  .route("logout").typed({
    input: z.object({}),
    output: logoutResponseSchema,
    handle: LogoutHandler,
  })

  .route("updateProfile").typed({
    input: updateProfileSchema,
    output: userSchema,
    handle: UpdateProfileHandler,
  });
