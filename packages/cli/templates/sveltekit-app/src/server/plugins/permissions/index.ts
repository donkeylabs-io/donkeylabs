/**
 * Permissions Plugin - Multi-tenant RBAC with resource-level grants
 *
 * Features:
 * - Multi-tenant isolation
 * - Role-based access control (RBAC) with inheritance
 * - Resource-level grants (user or role can access specific resources)
 * - Owner-based access (resource creators have full access)
 * - Middleware for route protection
 * - Client-side permission checking for UI
 */

import { createPlugin, createMiddleware } from "@donkeylabs/server";
import type { ColumnType } from "kysely";

// =============================================================================
// CONFIGURATION TYPES
// =============================================================================

export type ResourceAction = "create" | "read" | "write" | "delete" | "admin";

export interface PermissionsConfig<
  TPermissions extends Record<string, readonly string[]> = Record<string, readonly string[]>
> {
  /**
   * Define available permissions for autocomplete
   * @example { documents: ["create", "read", "write"], users: ["invite", "manage"] }
   */
  permissions: TPermissions;

  /**
   * Default roles created for new tenants
   */
  defaultRoles?: Array<{
    name: string;
    permissions: string[];
    isDefault?: boolean; // Auto-assign to new members
  }>;

  /**
   * How to resolve tenant context
   * @default "header"
   */
  tenantResolver?: "header" | "subdomain" | "path";

  /**
   * Header name for tenant ID
   * @default "x-tenant-id"
   */
  tenantHeader?: string;
}

// =============================================================================
// DATABASE SCHEMA
// =============================================================================

interface TenantsTable {
  id: string;
  name: string;
  slug: string;
  settings: string | null; // JSON
  created_at: ColumnType<string, string | undefined, never>;
  updated_at: string;
}

interface TenantMembersTable {
  id: string;
  tenant_id: string;
  user_id: string;
  created_at: ColumnType<string, string | undefined, never>;
}

interface RolesTable {
  id: string;
  tenant_id: string | null; // null = global role
  name: string;
  description: string | null;
  permissions: string; // JSON array
  inherits_from: string | null; // role_id
  is_default: number; // 0 or 1 - auto-assign to new members
  created_at: ColumnType<string, string | undefined, never>;
  updated_at: string;
}

interface UserRolesTable {
  id: string;
  user_id: string;
  role_id: string;
  tenant_id: string;
  assigned_by: string | null;
  created_at: ColumnType<string, string | undefined, never>;
}

interface ResourceGrantsTable {
  id: string;
  tenant_id: string;
  resource_type: string;
  resource_id: string;
  grantee_type: "user" | "role";
  grantee_id: string;
  permissions: string; // JSON array of actions
  granted_by: string | null;
  created_at: ColumnType<string, string | undefined, never>;
}

interface PermissionsSchema {
  tenants: TenantsTable;
  tenant_members: TenantMembersTable;
  roles: RolesTable;
  user_roles: UserRolesTable;
  resource_grants: ResourceGrantsTable;
}

// =============================================================================
// TYPES
// =============================================================================

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  settings: Record<string, unknown> | null;
}

export interface Role {
  id: string;
  tenantId: string | null;
  name: string;
  description: string | null;
  permissions: string[];
  inheritsFrom: string | null;
  isDefault: boolean;
}

export interface ResourceGrant {
  resourceType: string;
  resourceId: string;
  granteeType: "user" | "role";
  granteeId: string;
  permissions: ResourceAction[];
}

export interface PermissionContext {
  userId: string;
  tenantId: string;
  roles: Role[];
  permissions: Set<string>;
}

// =============================================================================
// PLUGIN DEFINITION
// =============================================================================

export const permissionsPlugin = <
  TPermissions extends Record<string, readonly string[]>
>(config: PermissionsConfig<TPermissions>) => {
  // Generate permission type union for validation
  type PermissionKey = {
    [K in keyof TPermissions]: `${K & string}.${TPermissions[K][number]}`;
  }[keyof TPermissions];

  const factory = createPlugin
    .withSchema<PermissionsSchema>()
    .withConfig<PermissionsConfig<TPermissions>>()
    .define({
      name: "permissions",

      customErrors: {
        TenantNotFound: {
          status: 404,
          code: "TENANT_NOT_FOUND",
          message: "Tenant not found",
        },
        TenantRequired: {
          status: 400,
          code: "TENANT_REQUIRED",
          message: "Tenant context is required",
        },
        NotTenantMember: {
          status: 403,
          code: "NOT_TENANT_MEMBER",
          message: "User is not a member of this tenant",
        },
        PermissionDenied: {
          status: 403,
          code: "PERMISSION_DENIED",
          message: "Permission denied",
        },
        RoleNotFound: {
          status: 404,
          code: "ROLE_NOT_FOUND",
          message: "Role not found",
        },
        ResourceAccessDenied: {
          status: 403,
          code: "RESOURCE_ACCESS_DENIED",
          message: "Access to this resource is denied",
        },
      },

      service: async (ctx) => {
        const tenantHeader = config.tenantHeader || "x-tenant-id";

        // =====================================================================
        // TENANT METHODS
        // =====================================================================

        async function createTenant(data: {
          name: string;
          slug: string;
          ownerId: string;
          settings?: Record<string, unknown>;
        }): Promise<Tenant> {
          const id = crypto.randomUUID();
          const now = new Date().toISOString();

          await ctx.db
            .insertInto("tenants")
            .values({
              id,
              name: data.name,
              slug: data.slug.toLowerCase(),
              settings: data.settings ? JSON.stringify(data.settings) : null,
              created_at: now,
              updated_at: now,
            })
            .execute();

          // Add owner as member
          await ctx.db
            .insertInto("tenant_members")
            .values({
              id: crypto.randomUUID(),
              tenant_id: id,
              user_id: data.ownerId,
              created_at: now,
            })
            .execute();

          // Create default roles if configured
          if (config.defaultRoles) {
            for (const roleDef of config.defaultRoles) {
              const roleId = crypto.randomUUID();
              await ctx.db
                .insertInto("roles")
                .values({
                  id: roleId,
                  tenant_id: id,
                  name: roleDef.name,
                  description: null,
                  permissions: JSON.stringify(roleDef.permissions),
                  inherits_from: null,
                  is_default: roleDef.isDefault ? 1 : 0,
                  created_at: now,
                  updated_at: now,
                })
                .execute();

              // Assign default role to owner
              if (roleDef.isDefault || roleDef.name.toLowerCase() === "admin") {
                await ctx.db
                  .insertInto("user_roles")
                  .values({
                    id: crypto.randomUUID(),
                    user_id: data.ownerId,
                    role_id: roleId,
                    tenant_id: id,
                    assigned_by: data.ownerId,
                    created_at: now,
                  })
                  .execute();
              }
            }
          }

          return {
            id,
            name: data.name,
            slug: data.slug,
            settings: data.settings || null,
          };
        }

        async function getTenant(tenantId: string): Promise<Tenant | null> {
          const row = await ctx.db
            .selectFrom("tenants")
            .where("id", "=", tenantId)
            .selectAll()
            .executeTakeFirst();

          if (!row) return null;

          return {
            id: row.id,
            name: row.name,
            slug: row.slug,
            settings: row.settings ? JSON.parse(row.settings) : null,
          };
        }

        async function getTenantBySlug(slug: string): Promise<Tenant | null> {
          const row = await ctx.db
            .selectFrom("tenants")
            .where("slug", "=", slug.toLowerCase())
            .selectAll()
            .executeTakeFirst();

          if (!row) return null;

          return {
            id: row.id,
            name: row.name,
            slug: row.slug,
            settings: row.settings ? JSON.parse(row.settings) : null,
          };
        }

        async function isTenantMember(userId: string, tenantId: string): Promise<boolean> {
          const member = await ctx.db
            .selectFrom("tenant_members")
            .where("user_id", "=", userId)
            .where("tenant_id", "=", tenantId)
            .selectAll()
            .executeTakeFirst();

          return !!member;
        }

        async function addTenantMember(
          tenantId: string,
          userId: string,
          addedBy?: string
        ): Promise<void> {
          const now = new Date().toISOString();

          await ctx.db
            .insertInto("tenant_members")
            .values({
              id: crypto.randomUUID(),
              tenant_id: tenantId,
              user_id: userId,
              created_at: now,
            })
            .execute();

          // Assign default roles
          const defaultRoles = await ctx.db
            .selectFrom("roles")
            .where("tenant_id", "=", tenantId)
            .where("is_default", "=", 1)
            .selectAll()
            .execute();

          for (const role of defaultRoles) {
            await ctx.db
              .insertInto("user_roles")
              .values({
                id: crypto.randomUUID(),
                user_id: userId,
                role_id: role.id,
                tenant_id: tenantId,
                assigned_by: addedBy || null,
                created_at: now,
              })
              .execute();
          }
        }

        async function removeTenantMember(tenantId: string, userId: string): Promise<void> {
          await ctx.db
            .deleteFrom("tenant_members")
            .where("tenant_id", "=", tenantId)
            .where("user_id", "=", userId)
            .execute();

          await ctx.db
            .deleteFrom("user_roles")
            .where("tenant_id", "=", tenantId)
            .where("user_id", "=", userId)
            .execute();

          await ctx.db
            .deleteFrom("resource_grants")
            .where("tenant_id", "=", tenantId)
            .where("grantee_type", "=", "user")
            .where("grantee_id", "=", userId)
            .execute();
        }

        async function getUserTenants(userId: string): Promise<Tenant[]> {
          const rows = await ctx.db
            .selectFrom("tenant_members")
            .innerJoin("tenants", "tenants.id", "tenant_members.tenant_id")
            .where("tenant_members.user_id", "=", userId)
            .select([
              "tenants.id",
              "tenants.name",
              "tenants.slug",
              "tenants.settings",
            ])
            .execute();

          return rows.map((row) => ({
            id: row.id,
            name: row.name,
            slug: row.slug,
            settings: row.settings ? JSON.parse(row.settings) : null,
          }));
        }

        // =====================================================================
        // ROLE METHODS
        // =====================================================================

        async function createRole(data: {
          tenantId: string;
          name: string;
          description?: string;
          permissions: string[];
          inheritsFrom?: string;
          isDefault?: boolean;
        }): Promise<Role> {
          const id = crypto.randomUUID();
          const now = new Date().toISOString();

          await ctx.db
            .insertInto("roles")
            .values({
              id,
              tenant_id: data.tenantId,
              name: data.name,
              description: data.description || null,
              permissions: JSON.stringify(data.permissions),
              inherits_from: data.inheritsFrom || null,
              is_default: data.isDefault ? 1 : 0,
              created_at: now,
              updated_at: now,
            })
            .execute();

          return {
            id,
            tenantId: data.tenantId,
            name: data.name,
            description: data.description || null,
            permissions: data.permissions,
            inheritsFrom: data.inheritsFrom || null,
            isDefault: data.isDefault || false,
          };
        }

        async function getRole(roleId: string): Promise<Role | null> {
          const row = await ctx.db
            .selectFrom("roles")
            .where("id", "=", roleId)
            .selectAll()
            .executeTakeFirst();

          if (!row) return null;

          return {
            id: row.id,
            tenantId: row.tenant_id,
            name: row.name,
            description: row.description,
            permissions: JSON.parse(row.permissions),
            inheritsFrom: row.inherits_from,
            isDefault: row.is_default === 1,
          };
        }

        async function getTenantRoles(tenantId: string): Promise<Role[]> {
          const rows = await ctx.db
            .selectFrom("roles")
            .where((eb) =>
              eb.or([
                eb("tenant_id", "=", tenantId),
                eb("tenant_id", "is", null), // Global roles
              ])
            )
            .selectAll()
            .execute();

          return rows.map((row) => ({
            id: row.id,
            tenantId: row.tenant_id,
            name: row.name,
            description: row.description,
            permissions: JSON.parse(row.permissions),
            inheritsFrom: row.inherits_from,
            isDefault: row.is_default === 1,
          }));
        }

        async function assignRole(
          userId: string,
          roleId: string,
          tenantId: string,
          assignedBy?: string
        ): Promise<void> {
          const existing = await ctx.db
            .selectFrom("user_roles")
            .where("user_id", "=", userId)
            .where("role_id", "=", roleId)
            .where("tenant_id", "=", tenantId)
            .selectAll()
            .executeTakeFirst();

          if (existing) return;

          await ctx.db
            .insertInto("user_roles")
            .values({
              id: crypto.randomUUID(),
              user_id: userId,
              role_id: roleId,
              tenant_id: tenantId,
              assigned_by: assignedBy || null,
              created_at: new Date().toISOString(),
            })
            .execute();
        }

        async function revokeRole(
          userId: string,
          roleId: string,
          tenantId: string
        ): Promise<void> {
          await ctx.db
            .deleteFrom("user_roles")
            .where("user_id", "=", userId)
            .where("role_id", "=", roleId)
            .where("tenant_id", "=", tenantId)
            .execute();
        }

        async function getUserRoles(userId: string, tenantId: string): Promise<Role[]> {
          const rows = await ctx.db
            .selectFrom("user_roles")
            .innerJoin("roles", "roles.id", "user_roles.role_id")
            .where("user_roles.user_id", "=", userId)
            .where("user_roles.tenant_id", "=", tenantId)
            .select([
              "roles.id",
              "roles.tenant_id",
              "roles.name",
              "roles.description",
              "roles.permissions",
              "roles.inherits_from",
              "roles.is_default",
            ])
            .execute();

          return rows.map((row) => ({
            id: row.id,
            tenantId: row.tenant_id,
            name: row.name,
            description: row.description,
            permissions: JSON.parse(row.permissions),
            inheritsFrom: row.inherits_from,
            isDefault: row.is_default === 1,
          }));
        }

        // =====================================================================
        // PERMISSION RESOLUTION
        // =====================================================================

        /**
         * Get all permissions for a role, including inherited ones
         */
        async function resolveRolePermissions(
          roleId: string,
          visited: Set<string> = new Set()
        ): Promise<Set<string>> {
          if (visited.has(roleId)) return new Set(); // Prevent cycles
          visited.add(roleId);

          const role = await getRole(roleId);
          if (!role) return new Set();

          const permissions = new Set(role.permissions);

          // Add inherited permissions
          if (role.inheritsFrom) {
            const inherited = await resolveRolePermissions(role.inheritsFrom, visited);
            for (const perm of inherited) {
              permissions.add(perm);
            }
          }

          return permissions;
        }

        /**
         * Get all static permissions for a user in a tenant
         */
        async function getUserPermissions(
          userId: string,
          tenantId: string
        ): Promise<Set<string>> {
          const roles = await getUserRoles(userId, tenantId);
          const permissions = new Set<string>();

          for (const role of roles) {
            const rolePerms = await resolveRolePermissions(role.id);
            for (const perm of rolePerms) {
              permissions.add(perm);
            }
          }

          return permissions;
        }

        /**
         * Check if user has a static permission
         */
        async function hasPermission(
          userId: string,
          tenantId: string,
          permission: string
        ): Promise<boolean> {
          const permissions = await getUserPermissions(userId, tenantId);

          // Check exact match
          if (permissions.has(permission)) return true;

          // Check wildcard (e.g., "documents.*" or "*")
          if (permissions.has("*")) return true;

          const [resource] = permission.split(".");
          if (permissions.has(`${resource}.*`)) return true;

          return false;
        }

        /**
         * Require a static permission, throw if denied
         */
        async function requirePermission(
          userId: string,
          tenantId: string,
          permission: string
        ): Promise<void> {
          const has = await hasPermission(userId, tenantId, permission);
          if (!has) {
            throw ctx.core.errors.Forbidden(`Missing permission: ${permission}`);
          }
        }

        // =====================================================================
        // RESOURCE GRANTS
        // =====================================================================

        /**
         * Grant access to a resource
         */
        async function grantAccess(data: {
          tenantId: string;
          resourceType: string;
          resourceId: string;
          granteeType: "user" | "role";
          granteeId: string;
          permissions: ResourceAction[];
          grantedBy?: string;
        }): Promise<void> {
          // Check if grant already exists
          const existing = await ctx.db
            .selectFrom("resource_grants")
            .where("tenant_id", "=", data.tenantId)
            .where("resource_type", "=", data.resourceType)
            .where("resource_id", "=", data.resourceId)
            .where("grantee_type", "=", data.granteeType)
            .where("grantee_id", "=", data.granteeId)
            .selectAll()
            .executeTakeFirst();

          if (existing) {
            // Update permissions
            const existingPerms: ResourceAction[] = JSON.parse(existing.permissions);
            const merged = [...new Set([...existingPerms, ...data.permissions])];

            await ctx.db
              .updateTable("resource_grants")
              .set({ permissions: JSON.stringify(merged) })
              .where("id", "=", existing.id)
              .execute();
          } else {
            await ctx.db
              .insertInto("resource_grants")
              .values({
                id: crypto.randomUUID(),
                tenant_id: data.tenantId,
                resource_type: data.resourceType,
                resource_id: data.resourceId,
                grantee_type: data.granteeType,
                grantee_id: data.granteeId,
                permissions: JSON.stringify(data.permissions),
                granted_by: data.grantedBy || null,
                created_at: new Date().toISOString(),
              })
              .execute();
          }
        }

        /**
         * Revoke access to a resource
         */
        async function revokeAccess(data: {
          tenantId: string;
          resourceType: string;
          resourceId: string;
          granteeType: "user" | "role";
          granteeId: string;
          permissions?: ResourceAction[]; // If not provided, revokes all
        }): Promise<void> {
          if (!data.permissions) {
            await ctx.db
              .deleteFrom("resource_grants")
              .where("tenant_id", "=", data.tenantId)
              .where("resource_type", "=", data.resourceType)
              .where("resource_id", "=", data.resourceId)
              .where("grantee_type", "=", data.granteeType)
              .where("grantee_id", "=", data.granteeId)
              .execute();
          } else {
            const existing = await ctx.db
              .selectFrom("resource_grants")
              .where("tenant_id", "=", data.tenantId)
              .where("resource_type", "=", data.resourceType)
              .where("resource_id", "=", data.resourceId)
              .where("grantee_type", "=", data.granteeType)
              .where("grantee_id", "=", data.granteeId)
              .selectAll()
              .executeTakeFirst();

            if (existing) {
              const existingPerms: ResourceAction[] = JSON.parse(existing.permissions);
              const remaining = existingPerms.filter((p) => !data.permissions!.includes(p));

              if (remaining.length === 0) {
                await ctx.db
                  .deleteFrom("resource_grants")
                  .where("id", "=", existing.id)
                  .execute();
              } else {
                await ctx.db
                  .updateTable("resource_grants")
                  .set({ permissions: JSON.stringify(remaining) })
                  .where("id", "=", existing.id)
                  .execute();
              }
            }
          }
        }

        /**
         * Check if user can access a resource
         */
        async function canAccess(
          userId: string,
          tenantId: string,
          resourceType: string,
          resourceId: string,
          action: ResourceAction,
          ownerId?: string // If provided, owner check is performed
        ): Promise<boolean> {
          // 1. Owner check - owners have full access
          if (ownerId && ownerId === userId) {
            return true;
          }

          // 2. Admin permission check
          const hasAdmin = await hasPermission(userId, tenantId, `${resourceType}.admin`);
          if (hasAdmin) return true;

          // 3. Direct user grant
          const userGrant = await ctx.db
            .selectFrom("resource_grants")
            .where("tenant_id", "=", tenantId)
            .where("resource_type", "=", resourceType)
            .where("resource_id", "=", resourceId)
            .where("grantee_type", "=", "user")
            .where("grantee_id", "=", userId)
            .selectAll()
            .executeTakeFirst();

          if (userGrant) {
            const perms: ResourceAction[] = JSON.parse(userGrant.permissions);
            if (perms.includes(action) || perms.includes("admin")) {
              return true;
            }
          }

          // 4. Role grant
          const userRoles = await getUserRoles(userId, tenantId);
          for (const role of userRoles) {
            const roleGrant = await ctx.db
              .selectFrom("resource_grants")
              .where("tenant_id", "=", tenantId)
              .where("resource_type", "=", resourceType)
              .where("resource_id", "=", resourceId)
              .where("grantee_type", "=", "role")
              .where("grantee_id", "=", role.id)
              .selectAll()
              .executeTakeFirst();

            if (roleGrant) {
              const perms: ResourceAction[] = JSON.parse(roleGrant.permissions);
              if (perms.includes(action) || perms.includes("admin")) {
                return true;
              }
            }
          }

          return false;
        }

        /**
         * Require access to a resource, throw if denied
         */
        async function requireAccess(
          userId: string,
          tenantId: string,
          resourceType: string,
          resourceId: string,
          action: ResourceAction,
          ownerId?: string
        ): Promise<void> {
          const can = await canAccess(userId, tenantId, resourceType, resourceId, action, ownerId);
          if (!can) {
            throw ctx.core.errors.Forbidden(
              `Cannot ${action} ${resourceType}:${resourceId}`
            );
          }
        }

        /**
         * Get all grants for a resource
         */
        async function getResourceGrants(
          tenantId: string,
          resourceType: string,
          resourceId: string
        ): Promise<ResourceGrant[]> {
          const rows = await ctx.db
            .selectFrom("resource_grants")
            .where("tenant_id", "=", tenantId)
            .where("resource_type", "=", resourceType)
            .where("resource_id", "=", resourceId)
            .selectAll()
            .execute();

          return rows.map((row) => ({
            resourceType: row.resource_type,
            resourceId: row.resource_id,
            granteeType: row.grantee_type as "user" | "role",
            granteeId: row.grantee_id,
            permissions: JSON.parse(row.permissions),
          }));
        }

        // =====================================================================
        // CONTEXT BUILDER
        // =====================================================================

        /**
         * Build permission context for a user in a tenant
         * Useful for passing to client
         */
        async function buildContext(
          userId: string,
          tenantId: string
        ): Promise<PermissionContext> {
          const roles = await getUserRoles(userId, tenantId);
          const permissions = await getUserPermissions(userId, tenantId);

          return {
            userId,
            tenantId,
            roles,
            permissions,
          };
        }

        /**
         * Serialize context for client (permissions as array)
         */
        async function getClientContext(
          userId: string,
          tenantId: string
        ): Promise<{
          tenantId: string;
          roles: Array<{ id: string; name: string }>;
          permissions: string[];
        }> {
          const context = await buildContext(userId, tenantId);
          return {
            tenantId: context.tenantId,
            roles: context.roles.map((r) => ({ id: r.id, name: r.name })),
            permissions: Array.from(context.permissions),
          };
        }

        // =====================================================================
        // RETURN SERVICE
        // =====================================================================

        return {
          // Tenant methods
          createTenant,
          getTenant,
          getTenantBySlug,
          isTenantMember,
          addTenantMember,
          removeTenantMember,
          getUserTenants,

          // Role methods
          createRole,
          getRole,
          getTenantRoles,
          assignRole,
          revokeRole,
          getUserRoles,

          // Permission methods
          hasPermission,
          requirePermission,
          getUserPermissions,

          // Resource grant methods
          grantAccess,
          revokeAccess,
          canAccess,
          requireAccess,
          getResourceGrants,

          // Context
          buildContext,
          getClientContext,

          // Config access
          getPermissionDefinitions: () => config.permissions,
          getTenantHeader: () => tenantHeader,
        };
      },

      middleware: (ctx, service) => ({
        /**
         * Tenant middleware - resolves and validates tenant context
         */
        tenant: createMiddleware<{ required?: boolean }>(
          async (req, reqCtx, next, options) => {
            const tenantHeader = service.getTenantHeader();
            const tenantId = req.headers.get(tenantHeader);

            if (!tenantId) {
              if (options?.required !== false) {
                return Response.json(
                  { error: "Tenant context required", code: "TENANT_REQUIRED" },
                  { status: 400 }
                );
              }
              return next();
            }

            const tenant = await service.getTenant(tenantId);
            if (!tenant) {
              return Response.json(
                { error: "Tenant not found", code: "TENANT_NOT_FOUND" },
                { status: 404 }
              );
            }

            // Check membership if user is authenticated
            if (reqCtx.user?.id) {
              const isMember = await service.isTenantMember(reqCtx.user.id, tenantId);
              if (!isMember) {
                return Response.json(
                  { error: "Not a tenant member", code: "NOT_TENANT_MEMBER" },
                  { status: 403 }
                );
              }
            }

            (reqCtx as any).tenant = tenant;
            (reqCtx as any).tenantId = tenant.id;
            return next();
          }
        ),

        /**
         * Permission middleware - checks static permissions
         */
        permissions: createMiddleware<{ require: string | string[] }>(
          async (req, reqCtx, next, options) => {
            if (!reqCtx.user?.id) {
              return Response.json(
                { error: "Authentication required", code: "UNAUTHORIZED" },
                { status: 401 }
              );
            }

            if (!(reqCtx as any).tenantId) {
              return Response.json(
                { error: "Tenant context required", code: "TENANT_REQUIRED" },
                { status: 400 }
              );
            }

            const required = Array.isArray(options.require)
              ? options.require
              : [options.require];

            for (const permission of required) {
              const has = await service.hasPermission(
                reqCtx.user.id,
                (reqCtx as any).tenantId,
                permission
              );
              if (!has) {
                return Response.json(
                  {
                    error: `Missing permission: ${permission}`,
                    code: "PERMISSION_DENIED",
                  },
                  { status: 403 }
                );
              }
            }

            return next();
          }
        ),
      }),

      init: async (ctx, service) => {
        ctx.core.logger.info("Permissions plugin initialized", {
          permissions: Object.keys(config.permissions),
          defaultRoles: config.defaultRoles?.map((r) => r.name) || [],
        });
      },
    });

  // Call factory with config to get the actual Plugin
  return factory(config);
};
