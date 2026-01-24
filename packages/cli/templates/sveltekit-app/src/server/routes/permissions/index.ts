/**
 * Permissions Routes - Client-side permission checking
 *
 * These routes allow the frontend to check permissions for UI locking.
 */

import { createRouter, defineRoute } from "@donkeylabs/server";
import { z } from "zod";

const permissions = createRouter("permissions");

/**
 * Get current user's permission context for a tenant
 * Returns roles and all static permissions
 */
permissions.route("context").typed(
  defineRoute({
    input: z.object({
      tenantId: z.string(),
    }),
    output: z.object({
      tenantId: z.string(),
      roles: z.array(z.object({
        id: z.string(),
        name: z.string(),
      })),
      permissions: z.array(z.string()),
    }),
    handle: async (input, ctx) => {
      if (!ctx.user?.id) {
        throw ctx.errors.Unauthorized("Authentication required");
      }

      return (ctx.plugins as any).permissions.getClientContext(ctx.user.id, input.tenantId);
    },
  })
);

/**
 * Check if user has specific static permissions
 * Returns a map of permission -> boolean
 */
permissions.route("check").typed(
  defineRoute({
    input: z.object({
      tenantId: z.string(),
      permissions: z.array(z.string()),
    }),
    output: z.record(z.string(), z.boolean()),
    handle: async (input, ctx) => {
      if (!ctx.user?.id) {
        throw ctx.errors.Unauthorized("Authentication required");
      }

      const results: Record<string, boolean> = {};

      for (const permission of input.permissions) {
        results[permission] = await (ctx.plugins as any).permissions.hasPermission(
          ctx.user.id,
          input.tenantId,
          permission
        );
      }

      return results;
    },
  })
);

/**
 * Check if user can access specific resources
 * Returns a map of "resourceType:resourceId:action" -> boolean
 */
permissions.route("canAccess").typed(
  defineRoute({
    input: z.object({
      tenantId: z.string(),
      checks: z.array(z.object({
        resourceType: z.string(),
        resourceId: z.string(),
        action: z.enum(["create", "read", "write", "delete", "admin"]),
        ownerId: z.string().optional(), // For owner check
      })),
    }),
    output: z.record(z.string(), z.boolean()),
    handle: async (input, ctx) => {
      if (!ctx.user?.id) {
        throw ctx.errors.Unauthorized("Authentication required");
      }

      const results: Record<string, boolean> = {};

      for (const check of input.checks) {
        const key = `${check.resourceType}:${check.resourceId}:${check.action}`;
        results[key] = await (ctx.plugins as any).permissions.canAccess(
          ctx.user.id,
          input.tenantId,
          check.resourceType,
          check.resourceId,
          check.action,
          check.ownerId
        );
      }

      return results;
    },
  })
);

/**
 * Get all grants for a specific resource
 * Useful for showing "shared with" UI
 */
permissions.route("grants").typed(
  defineRoute({
    input: z.object({
      tenantId: z.string(),
      resourceType: z.string(),
      resourceId: z.string(),
    }),
    output: z.array(z.object({
      resourceType: z.string(),
      resourceId: z.string(),
      granteeType: z.enum(["user", "role"]),
      granteeId: z.string(),
      permissions: z.array(z.enum(["create", "read", "write", "delete", "admin"])),
    })),
    handle: async (input, ctx) => {
      if (!ctx.user?.id) {
        throw ctx.errors.Unauthorized("Authentication required");
      }

      // Check if user can admin this resource (to see grants)
      const canAdmin = await (ctx.plugins as any).permissions.canAccess(
        ctx.user.id,
        input.tenantId,
        input.resourceType,
        input.resourceId,
        "admin"
      );

      if (!canAdmin) {
        throw ctx.errors.Forbidden("Cannot view grants for this resource");
      }

      return (ctx.plugins as any).permissions.getResourceGrants(
        input.tenantId,
        input.resourceType,
        input.resourceId
      );
    },
  })
);

/**
 * Grant access to a resource
 */
permissions.route("grant").typed(
  defineRoute({
    input: z.object({
      tenantId: z.string(),
      resourceType: z.string(),
      resourceId: z.string(),
      granteeType: z.enum(["user", "role"]),
      granteeId: z.string(),
      permissions: z.array(z.enum(["create", "read", "write", "delete", "admin"])),
    }),
    output: z.object({ success: z.boolean() }),
    handle: async (input, ctx) => {
      if (!ctx.user?.id) {
        throw ctx.errors.Unauthorized("Authentication required");
      }

      // Check if user can admin this resource
      const canAdmin = await (ctx.plugins as any).permissions.canAccess(
        ctx.user.id,
        input.tenantId,
        input.resourceType,
        input.resourceId,
        "admin"
      );

      if (!canAdmin) {
        throw ctx.errors.Forbidden("Cannot grant access to this resource");
      }

      await (ctx.plugins as any).permissions.grantAccess({
        tenantId: input.tenantId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        granteeType: input.granteeType,
        granteeId: input.granteeId,
        permissions: input.permissions,
        grantedBy: ctx.user.id,
      });

      return { success: true };
    },
  })
);

/**
 * Revoke access to a resource
 */
permissions.route("revoke").typed(
  defineRoute({
    input: z.object({
      tenantId: z.string(),
      resourceType: z.string(),
      resourceId: z.string(),
      granteeType: z.enum(["user", "role"]),
      granteeId: z.string(),
      permissions: z.array(z.enum(["create", "read", "write", "delete", "admin"])).optional(),
    }),
    output: z.object({ success: z.boolean() }),
    handle: async (input, ctx) => {
      if (!ctx.user?.id) {
        throw ctx.errors.Unauthorized("Authentication required");
      }

      // Check if user can admin this resource
      const canAdmin = await (ctx.plugins as any).permissions.canAccess(
        ctx.user.id,
        input.tenantId,
        input.resourceType,
        input.resourceId,
        "admin"
      );

      if (!canAdmin) {
        throw ctx.errors.Forbidden("Cannot revoke access to this resource");
      }

      await (ctx.plugins as any).permissions.revokeAccess({
        tenantId: input.tenantId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        granteeType: input.granteeType,
        granteeId: input.granteeId,
        permissions: input.permissions,
      });

      return { success: true };
    },
  })
);

export { permissions as permissionsRouter };
