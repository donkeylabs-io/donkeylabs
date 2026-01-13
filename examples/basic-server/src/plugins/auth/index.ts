import { createPlugin, type Register } from "@donkeylabs/server";
import { createMiddleware } from "@donkeylabs/server";
import type { DB as AuthDatabaseSchema } from "./schema";

// Plugin configuration type
export interface AuthPluginConfig {
  privateKey: string;
  tokenExpiry?: number; // seconds, default 3600
  issuer?: string;
}

export interface AuthService {
  getCurrentUser(): { id: number; username: string; roles?: string[] } | null;
  login(username: string): void;
  getConfig(): { issuer: string; tokenExpiry: number };
}

// Middleware configuration type
export interface AuthRequiredConfig {
  roles?: string[];
  redirectTo?: string;
}

// Create the authRequired middleware
export const AuthRequiredMiddleware = createMiddleware<AuthRequiredConfig>(
  async (req, ctx, next, config) => {
    // Check if user is authenticated
    const user = ctx.plugins.auth.getCurrentUser();

    if (!user) {
      // Short-circuit: return early response
      return Response.json(
        { error: "Unauthorized", redirectTo: config?.redirectTo },
        { status: 401 }
      );
    }

    // Optional role check
    if (config?.roles && config.roles.length > 0) {
      const userRoles = user.roles || [];
      const hasRole = config.roles.some(r => userRoles.includes(r));
      if (!hasRole) {
        return Response.json(
          { error: "Forbidden", requiredRoles: config.roles },
          { status: 403 }
        );
      }
    }

    // Modify context with authenticated user
    ctx.user = user;

    // Continue to next middleware or handler
    return next();
  }
);

// Standardize Export for Registry Generator
export type Service = AuthService;

// Plugin definition
export const authPlugin = createPlugin
  .withSchema<AuthDatabaseSchema>()
  .withConfig<AuthPluginConfig>()
  .define({
    name: "auth",
    version: "1.0.0",
    middleware: {
      authRequired: AuthRequiredMiddleware,
    },
    service: (ctx) => {
      console.log("[AuthPlugin] Initializing...");

      // Access config with defaults
      const tokenExpiry = ctx.config.tokenExpiry ?? 3600;
      const issuer = ctx.config.issuer ?? "app";

      console.log(`[AuthPlugin] Using issuer: ${issuer}, token expiry: ${tokenExpiry}s`);

      return {
        getCurrentUser: () => ({ id: 1, username: "admin", roles: ["user", "admin"] }),
        login: (username: string) => console.log(`Logging in ${username}`),
        getConfig: () => ({ issuer, tokenExpiry }),
      };
    },
  });
