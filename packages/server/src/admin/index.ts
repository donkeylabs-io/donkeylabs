/**
 * Admin Dashboard Module
 *
 * Built-in admin UI for monitoring jobs, processes, workflows,
 * audit logs, SSE/WebSocket clients, and server stats.
 *
 * Security: Admin is dev-only by default - automatically enabled when
 * NODE_ENV !== 'production' and disabled in production unless explicitly
 * enabled with an `authorize` function.
 */

import type { ServerContext } from "../router";
import { createAdminRouter } from "./routes";

export interface AdminConfig {
  /**
   * Enable admin dashboard.
   * @default true in dev, false in production
   */
  enabled?: boolean;

  /**
   * Route prefix for admin routes.
   * @default "admin"
   */
  prefix?: string;

  /**
   * Authorization function for admin access.
   * Required for production use. Return true to allow access.
   *
   * @example
   * ```ts
   * authorize: (ctx) => {
   *   const user = ctx.plugins.auth.getUser(ctx);
   *   return user?.role === 'admin';
   * }
   * ```
   */
  authorize?: (ctx: ServerContext) => boolean;
}

/**
 * Determine if admin should be enabled based on config and environment
 */
export function isAdminEnabled(config?: AdminConfig): boolean {
  const isDev = process.env.NODE_ENV !== "production";

  // If explicitly set, use that
  if (config?.enabled !== undefined) {
    return config.enabled;
  }

  // Default: enabled in dev, disabled in production
  return isDev;
}

/**
 * Create the admin router with proper configuration
 */
export function createAdmin(config?: AdminConfig) {
  const prefix = config?.prefix ?? "admin";

  if (!isAdminEnabled(config)) {
    return null;
  }

  // Warn if enabled in production without authorize function
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && !config?.authorize) {
    console.warn(
      "[Admin] WARNING: Admin dashboard enabled in production without authorization. " +
        "This is a security risk. Add an 'authorize' function to your admin config."
    );
  }

  return createAdminRouter({
    prefix,
    authorize: config?.authorize,
  });
}

export { createAdminRouter } from "./routes";
export { adminStyles } from "./styles";
export * from "./dashboard";
