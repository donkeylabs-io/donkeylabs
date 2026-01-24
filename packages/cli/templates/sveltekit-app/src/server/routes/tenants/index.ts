/**
 * Tenants Routes - Multi-tenant management
 */

import { createRouter, defineRoute } from "@donkeylabs/server";
import { z } from "zod";

const tenants = createRouter("tenants");

/**
 * Get all tenants the current user is a member of
 */
tenants.route("mine").typed(
  defineRoute({
    input: z.object({}),
    output: z.array(z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      settings: z.record(z.string(), z.unknown()).nullable(),
    })),
    handle: async (input, ctx) => {
      if (!ctx.user?.id) {
        throw ctx.errors.Unauthorized("Authentication required");
      }

      return (ctx.plugins as any).permissions.getUserTenants(ctx.user.id);
    },
  })
);

/**
 * Create a new tenant (user becomes owner/admin)
 */
tenants.route("create").typed(
  defineRoute({
    input: z.object({
      name: z.string().min(1).max(100),
      slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
      settings: z.record(z.string(), z.unknown()).optional(),
    }),
    output: z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      settings: z.record(z.string(), z.unknown()).nullable(),
    }),
    handle: async (input, ctx) => {
      if (!ctx.user?.id) {
        throw ctx.errors.Unauthorized("Authentication required");
      }

      // Check if slug is taken
      const existing = await (ctx.plugins as any).permissions.getTenantBySlug(input.slug);
      if (existing) {
        throw ctx.errors.BadRequest("Tenant slug already taken");
      }

      return (ctx.plugins as any).permissions.createTenant({
        name: input.name,
        slug: input.slug,
        ownerId: ctx.user.id,
        settings: input.settings,
      });
    },
  })
);

/**
 * Get tenant by ID
 */
tenants.route("get").typed(
  defineRoute({
    input: z.object({
      tenantId: z.string(),
    }),
    output: z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      settings: z.record(z.string(), z.unknown()).nullable(),
    }).nullable(),
    handle: async (input, ctx) => {
      if (!ctx.user?.id) {
        throw ctx.errors.Unauthorized("Authentication required");
      }

      // Verify membership
      const isMember = await (ctx.plugins as any).permissions.isTenantMember(ctx.user.id, input.tenantId);
      if (!isMember) {
        throw ctx.errors.Forbidden("Not a member of this tenant");
      }

      return (ctx.plugins as any).permissions.getTenant(input.tenantId);
    },
  })
);

/**
 * Get tenant roles
 */
tenants.route("roles").typed(
  defineRoute({
    input: z.object({
      tenantId: z.string(),
    }),
    output: z.array(z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      permissions: z.array(z.string()),
      inheritsFrom: z.string().nullable(),
      isDefault: z.boolean(),
    })),
    handle: async (input, ctx) => {
      if (!ctx.user?.id) {
        throw ctx.errors.Unauthorized("Authentication required");
      }

      // Verify membership
      const isMember = await (ctx.plugins as any).permissions.isTenantMember(ctx.user.id, input.tenantId);
      if (!isMember) {
        throw ctx.errors.Forbidden("Not a member of this tenant");
      }

      const roles = await (ctx.plugins as any).permissions.getTenantRoles(input.tenantId);
      return roles.map((r: any) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        permissions: r.permissions,
        inheritsFrom: r.inheritsFrom,
        isDefault: r.isDefault,
      }));
    },
  })
);

/**
 * Create a role in a tenant
 */
tenants.route("createRole").typed(
  defineRoute({
    input: z.object({
      tenantId: z.string(),
      name: z.string().min(1).max(50),
      description: z.string().max(200).optional(),
      permissions: z.array(z.string()),
      inheritsFrom: z.string().optional(),
      isDefault: z.boolean().optional(),
    }),
    output: z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      permissions: z.array(z.string()),
      inheritsFrom: z.string().nullable(),
      isDefault: z.boolean(),
    }),
    handle: async (input, ctx) => {
      if (!ctx.user?.id) {
        throw ctx.errors.Unauthorized("Authentication required");
      }

      // Check admin permission
      const hasAdmin = await (ctx.plugins as any).permissions.hasPermission(
        ctx.user.id,
        input.tenantId,
        "roles.manage"
      );
      if (!hasAdmin) {
        throw ctx.errors.Forbidden("Cannot manage roles");
      }

      const role = await (ctx.plugins as any).permissions.createRole({
        tenantId: input.tenantId,
        name: input.name,
        description: input.description,
        permissions: input.permissions,
        inheritsFrom: input.inheritsFrom,
        isDefault: input.isDefault,
      });

      return {
        id: role.id,
        name: role.name,
        description: role.description,
        permissions: role.permissions,
        inheritsFrom: role.inheritsFrom,
        isDefault: role.isDefault,
      };
    },
  })
);

/**
 * Invite user to tenant (add as member)
 */
tenants.route("addMember").typed(
  defineRoute({
    input: z.object({
      tenantId: z.string(),
      userId: z.string(),
    }),
    output: z.object({ success: z.boolean() }),
    handle: async (input, ctx) => {
      if (!ctx.user?.id) {
        throw ctx.errors.Unauthorized("Authentication required");
      }

      // Check permission
      const canInvite = await (ctx.plugins as any).permissions.hasPermission(
        ctx.user.id,
        input.tenantId,
        "members.invite"
      );
      if (!canInvite) {
        throw ctx.errors.Forbidden("Cannot invite members");
      }

      await (ctx.plugins as any).permissions.addTenantMember(
        input.tenantId,
        input.userId,
        ctx.user.id
      );

      return { success: true };
    },
  })
);

/**
 * Remove user from tenant
 */
tenants.route("removeMember").typed(
  defineRoute({
    input: z.object({
      tenantId: z.string(),
      userId: z.string(),
    }),
    output: z.object({ success: z.boolean() }),
    handle: async (input, ctx) => {
      if (!ctx.user?.id) {
        throw ctx.errors.Unauthorized("Authentication required");
      }

      // Check permission
      const canRemove = await (ctx.plugins as any).permissions.hasPermission(
        ctx.user.id,
        input.tenantId,
        "members.remove"
      );
      if (!canRemove) {
        throw ctx.errors.Forbidden("Cannot remove members");
      }

      await (ctx.plugins as any).permissions.removeTenantMember(input.tenantId, input.userId);

      return { success: true };
    },
  })
);

/**
 * Assign role to user
 */
tenants.route("assignRole").typed(
  defineRoute({
    input: z.object({
      tenantId: z.string(),
      userId: z.string(),
      roleId: z.string(),
    }),
    output: z.object({ success: z.boolean() }),
    handle: async (input, ctx) => {
      if (!ctx.user?.id) {
        throw ctx.errors.Unauthorized("Authentication required");
      }

      // Check permission
      const canManage = await (ctx.plugins as any).permissions.hasPermission(
        ctx.user.id,
        input.tenantId,
        "roles.assign"
      );
      if (!canManage) {
        throw ctx.errors.Forbidden("Cannot assign roles");
      }

      await (ctx.plugins as any).permissions.assignRole(
        input.userId,
        input.roleId,
        input.tenantId,
        ctx.user.id
      );

      return { success: true };
    },
  })
);

/**
 * Revoke role from user
 */
tenants.route("revokeRole").typed(
  defineRoute({
    input: z.object({
      tenantId: z.string(),
      userId: z.string(),
      roleId: z.string(),
    }),
    output: z.object({ success: z.boolean() }),
    handle: async (input, ctx) => {
      if (!ctx.user?.id) {
        throw ctx.errors.Unauthorized("Authentication required");
      }

      // Check permission
      const canManage = await (ctx.plugins as any).permissions.hasPermission(
        ctx.user.id,
        input.tenantId,
        "roles.assign"
      );
      if (!canManage) {
        throw ctx.errors.Forbidden("Cannot revoke roles");
      }

      await (ctx.plugins as any).permissions.revokeRole(
        input.userId,
        input.roleId,
        input.tenantId
      );

      return { success: true };
    },
  })
);

export { tenants as tenantsRouter };
