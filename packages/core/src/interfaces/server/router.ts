import type { AnyRouteDefinition } from "./route";

// Base permissions that most resources will use
export const BasePermission = {
  READ: "read",
  CREATE: "create",
  UPDATE: "update",
  DELETE: "delete",
} as const;

export type RouterPermissions<T extends Record<string, string>> = T;

export class RouterDefinition<
  T extends Record<string, string>,
  Routes extends Record<string, AnyRouteDefinition>,
> {
  constructor(
    public routeName: string,
    public permissions: T,
    public routes: Routes,
  ) {}

  hasPermission(permission: keyof T, userPermissions: string[]): boolean {
    const permissionString = `${this.routeName}:${this.permissions[permission]}`;
    return userPermissions.includes(permissionString);
  }

  hasPermissions(permissions: (keyof T)[], userPermissions: string[]): boolean {
    return permissions.every((permission) => this.hasPermission(permission, userPermissions));
  }
}
