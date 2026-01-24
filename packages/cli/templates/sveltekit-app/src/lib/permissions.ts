/**
 * Permissions Helper for Svelte UI
 *
 * Provides reactive permission checking for UI locking.
 *
 * Usage in +page.server.ts:
 * ```ts
 * export const load = async ({ locals }) => {
 *   const api = createApi({ locals });
 *   const permissions = await api.permissions.context({ tenantId });
 *   return { permissions };
 * };
 * ```
 *
 * Usage in +page.svelte:
 * ```svelte
 * <script>
 *   import { createPermissions } from "$lib/permissions";
 *   let { data } = $props();
 *   const can = createPermissions(data.permissions);
 * </script>
 *
 * {#if can.has("documents.create")}
 *   <Button>Create Document</Button>
 * {/if}
 * ```
 */

import { createApi } from "./api";

export interface PermissionContext {
  tenantId: string;
  roles: Array<{ id: string; name: string }>;
  permissions: string[];
}

export interface PermissionsHelper {
  /** Check if user has a static permission */
  has: (permission: string) => boolean;

  /** Check if user has all of the specified permissions */
  hasAll: (...permissions: string[]) => boolean;

  /** Check if user has any of the specified permissions */
  hasAny: (...permissions: string[]) => boolean;

  /** Check if user has a specific role */
  hasRole: (roleName: string) => boolean;

  /** Get all permissions */
  all: () => string[];

  /** Get all roles */
  roles: () => Array<{ id: string; name: string }>;

  /** Get tenant ID */
  tenantId: () => string;

  /** Check resource access (async - makes API call) */
  canAccess: (
    resourceType: string,
    resourceId: string,
    action: "create" | "read" | "write" | "delete" | "admin",
    ownerId?: string
  ) => Promise<boolean>;

  /** Batch check resource access (async - makes single API call) */
  canAccessMany: (
    checks: Array<{
      resourceType: string;
      resourceId: string;
      action: "create" | "read" | "write" | "delete" | "admin";
      ownerId?: string;
    }>
  ) => Promise<Record<string, boolean>>;
}

/**
 * Create a permissions helper from context
 */
export function createPermissions(context: PermissionContext): PermissionsHelper {
  const permissionSet = new Set(context.permissions);
  const api = createApi();

  return {
    has(permission: string): boolean {
      // Exact match
      if (permissionSet.has(permission)) return true;

      // Wildcard match
      if (permissionSet.has("*")) return true;

      // Resource wildcard (e.g., "documents.*")
      const [resource] = permission.split(".");
      if (permissionSet.has(`${resource}.*`)) return true;

      return false;
    },

    hasAll(...permissions: string[]): boolean {
      return permissions.every((p) => this.has(p));
    },

    hasAny(...permissions: string[]): boolean {
      return permissions.some((p) => this.has(p));
    },

    hasRole(roleName: string): boolean {
      return context.roles.some(
        (r) => r.name.toLowerCase() === roleName.toLowerCase()
      );
    },

    all(): string[] {
      return context.permissions;
    },

    roles(): Array<{ id: string; name: string }> {
      return context.roles;
    },

    tenantId(): string {
      return context.tenantId;
    },

    async canAccess(
      resourceType: string,
      resourceId: string,
      action: "create" | "read" | "write" | "delete" | "admin",
      ownerId?: string
    ): Promise<boolean> {
      const result = await api.permissions.canAccess({
        tenantId: context.tenantId,
        checks: [{ resourceType, resourceId, action, ownerId }],
      });
      return result[`${resourceType}:${resourceId}:${action}`] ?? false;
    },

    async canAccessMany(
      checks: Array<{
        resourceType: string;
        resourceId: string;
        action: "create" | "read" | "write" | "delete" | "admin";
        ownerId?: string;
      }>
    ): Promise<Record<string, boolean>> {
      return api.permissions.canAccess({
        tenantId: context.tenantId,
        checks,
      });
    },
  };
}

/**
 * Svelte component helper - use in templates
 *
 * Usage:
 * ```svelte
 * <script>
 *   import { Can } from "$lib/permissions";
 *   let { data } = $props();
 * </script>
 *
 * <Can permission="documents.create" context={data.permissions}>
 *   <Button>Create</Button>
 * </Can>
 * ```
 */
export function canCheck(
  context: PermissionContext,
  permission: string
): boolean {
  const helper = createPermissions(context);
  return helper.has(permission);
}

/**
 * Type helper for defining permissions in your app
 *
 * Usage:
 * ```ts
 * const PERMISSIONS = definePermissions({
 *   documents: ["create", "read", "write", "delete", "admin"],
 *   users: ["invite", "remove", "manage"],
 *   billing: ["view", "manage"],
 * } as const);
 *
 * // Type: "documents.create" | "documents.read" | ...
 * type Permission = typeof PERMISSIONS[number];
 * ```
 */
export function definePermissions<
  T extends Record<string, readonly string[]>
>(permissions: T): Array<`${Extract<keyof T, string>}.${T[keyof T][number]}`> {
  const result: string[] = [];
  for (const [resource, actions] of Object.entries(permissions)) {
    for (const action of actions) {
      result.push(`${resource}.${action}`);
    }
  }
  return result as any;
}
