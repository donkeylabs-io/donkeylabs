/**
 * Permissions Plugin Tests
 *
 * Tests for multi-tenant RBAC:
 * - Tenant management
 * - Role management
 * - Permission checking
 * - Resource grants
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestHarness } from "@donkeylabs/server";
import { permissionsPlugin } from "./index";
import type { Kysely } from "kysely";

// Test permission config
const testPermissions = {
  documents: ["create", "read", "write", "delete", "admin"],
  members: ["invite", "remove", "list"],
  roles: ["create", "assign", "manage"],
} as const;

// Helper to create test harness with permissions plugin
async function createPermissionsTestHarness() {
  const harness = await createTestHarness(permissionsPlugin({
    permissions: testPermissions,
    defaultRoles: [
      { name: "Admin", permissions: ["*"], isDefault: false },
      { name: "Member", permissions: ["documents.read", "documents.write", "members.list"], isDefault: true },
      { name: "Viewer", permissions: ["documents.read", "members.list"], isDefault: false },
    ],
  }));
  return { ...harness, permissions: harness.manager.getServices().permissions };
}

// Helper to create a test user in the database
async function createTestUser(db: Kysely<any>, email: string): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .insertInto("users")
    .values({
      id,
      email,
      password_hash: "test",
      name: "Test User",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .onConflict((oc: any) => oc.doNothing())
    .execute()
    .catch(() => {
      // Table might not exist if auth plugin not registered
    });
  return id;
}

// ==========================================
// Tenant Management Tests
// ==========================================
describe("Permissions Plugin - Tenants", () => {
  let harness: Awaited<ReturnType<typeof createPermissionsTestHarness>>;

  beforeEach(async () => {
    harness = await createPermissionsTestHarness();
  });

  afterEach(async () => {
    await harness.db.destroy();
  });

  it("should create a tenant", async () => {
    const userId = crypto.randomUUID();
    const tenant = await harness.permissions.createTenant({
      name: "Test Org",
      slug: "test-org",
      ownerId: userId,
    });

    expect(tenant).toBeDefined();
    expect(tenant.name).toBe("Test Org");
    expect(tenant.slug).toBe("test-org");
    expect(tenant.id).toBeDefined();
  });

  it("should get tenant by ID", async () => {
    const userId = crypto.randomUUID();
    const created = await harness.permissions.createTenant({
      name: "Test Org",
      slug: "test-org",
      ownerId: userId,
    });

    const tenant = await harness.permissions.getTenant(created.id);
    expect(tenant).toBeDefined();
    expect(tenant?.name).toBe("Test Org");
  });

  it("should get tenant by slug", async () => {
    const userId = crypto.randomUUID();
    await harness.permissions.createTenant({
      name: "Test Org",
      slug: "test-org",
      ownerId: userId,
    });

    const tenant = await harness.permissions.getTenantBySlug("test-org");
    expect(tenant).toBeDefined();
    expect(tenant?.slug).toBe("test-org");
  });

  it("should return null for non-existent tenant", async () => {
    const tenant = await harness.permissions.getTenant("non-existent");
    expect(tenant).toBeNull();
  });

  it("should add owner as admin member on creation", async () => {
    const userId = crypto.randomUUID();
    const tenant = await harness.permissions.createTenant({
      name: "Test Org",
      slug: "test-org",
      ownerId: userId,
    });

    const isMember = await harness.permissions.isTenantMember(userId, tenant.id);
    expect(isMember).toBe(true);
  });

  it("should get user tenants", async () => {
    const userId = crypto.randomUUID();
    await harness.permissions.createTenant({
      name: "Org 1",
      slug: "org-1",
      ownerId: userId,
    });
    await harness.permissions.createTenant({
      name: "Org 2",
      slug: "org-2",
      ownerId: userId,
    });

    const tenants = await harness.permissions.getUserTenants(userId);
    expect(tenants.length).toBe(2);
  });
});

// ==========================================
// Membership Tests
// ==========================================
describe("Permissions Plugin - Membership", () => {
  let harness: Awaited<ReturnType<typeof createPermissionsTestHarness>>;
  let tenantId: string;
  let ownerId: string;

  beforeEach(async () => {
    harness = await createPermissionsTestHarness();
    ownerId = crypto.randomUUID();
    const tenant = await harness.permissions.createTenant({
      name: "Test Org",
      slug: "test-org",
      ownerId,
    });
    tenantId = tenant.id;
  });

  afterEach(async () => {
    await harness.db.destroy();
  });

  it("should add member to tenant", async () => {
    const newUserId = crypto.randomUUID();
    await harness.permissions.addTenantMember(tenantId, newUserId, ownerId);

    const isMember = await harness.permissions.isTenantMember(newUserId, tenantId);
    expect(isMember).toBe(true);
  });

  it("should remove member from tenant", async () => {
    const newUserId = crypto.randomUUID();
    await harness.permissions.addTenantMember(tenantId, newUserId, ownerId);
    await harness.permissions.removeTenantMember(tenantId, newUserId);

    const isMember = await harness.permissions.isTenantMember(newUserId, tenantId);
    expect(isMember).toBe(false);
  });

  it("should not report non-member as member", async () => {
    const randomUserId = crypto.randomUUID();
    const isMember = await harness.permissions.isTenantMember(randomUserId, tenantId);
    expect(isMember).toBe(false);
  });
});

// ==========================================
// Role Tests
// ==========================================
describe("Permissions Plugin - Roles", () => {
  let harness: Awaited<ReturnType<typeof createPermissionsTestHarness>>;
  let tenantId: string;
  let ownerId: string;

  beforeEach(async () => {
    harness = await createPermissionsTestHarness();
    ownerId = crypto.randomUUID();
    const tenant = await harness.permissions.createTenant({
      name: "Test Org",
      slug: "test-org",
      ownerId,
    });
    tenantId = tenant.id;
  });

  afterEach(async () => {
    await harness.db.destroy();
  });

  it("should create a role", async () => {
    const role = await harness.permissions.createRole({
      tenantId,
      name: "Editor",
      permissions: ["documents.read", "documents.write"],
    });

    expect(role).toBeDefined();
    expect(role.name).toBe("Editor");
    expect(role.permissions).toContain("documents.read");
    expect(role.permissions).toContain("documents.write");
  });

  it("should get role by ID", async () => {
    const created = await harness.permissions.createRole({
      tenantId,
      name: "Editor",
      permissions: ["documents.read"],
    });

    const role = await harness.permissions.getRole(created.id);
    expect(role).toBeDefined();
    expect(role?.name).toBe("Editor");
  });

  it("should get tenant roles", async () => {
    await harness.permissions.createRole({
      tenantId,
      name: "Editor",
      permissions: ["documents.read"],
    });
    await harness.permissions.createRole({
      tenantId,
      name: "Reviewer",
      permissions: ["documents.read"],
    });

    const roles = await harness.permissions.getTenantRoles(tenantId);
    // Should include default Admin role + custom roles
    expect(roles.length).toBeGreaterThanOrEqual(2);
  });

  it("should assign role to user", async () => {
    const userId = crypto.randomUUID();
    await harness.permissions.addTenantMember(tenantId, userId, ownerId);

    const role = await harness.permissions.createRole({
      tenantId,
      name: "Editor",
      permissions: ["documents.write"],
    });

    await harness.permissions.assignRole(userId, role.id, tenantId, ownerId);

    const userRoles = await harness.permissions.getUserRoles(userId, tenantId);
    expect(userRoles.some((r: { name: string }) => r.name === "Editor")).toBe(true);
  });

  it("should revoke role from user", async () => {
    const userId = crypto.randomUUID();
    await harness.permissions.addTenantMember(tenantId, userId, ownerId);

    const role = await harness.permissions.createRole({
      tenantId,
      name: "Editor",
      permissions: ["documents.write"],
    });

    await harness.permissions.assignRole(userId, role.id, tenantId, ownerId);
    await harness.permissions.revokeRole(userId, role.id, tenantId);

    const userRoles = await harness.permissions.getUserRoles(userId, tenantId);
    expect(userRoles.some((r: { name: string }) => r.name === "Editor")).toBe(false);
  });
});

// ==========================================
// Permission Checking Tests
// ==========================================
describe("Permissions Plugin - Permission Checks", () => {
  let harness: Awaited<ReturnType<typeof createPermissionsTestHarness>>;
  let tenantId: string;
  let ownerId: string;

  beforeEach(async () => {
    harness = await createPermissionsTestHarness();
    ownerId = crypto.randomUUID();
    const tenant = await harness.permissions.createTenant({
      name: "Test Org",
      slug: "test-org",
      ownerId,
    });
    tenantId = tenant.id;
  });

  afterEach(async () => {
    await harness.db.destroy();
  });

  it("should check permission from role", async () => {
    const userId = crypto.randomUUID();
    await harness.permissions.addTenantMember(tenantId, userId, ownerId);

    const role = await harness.permissions.createRole({
      tenantId,
      name: "Editor",
      permissions: ["documents.read", "documents.write"],
    });

    await harness.permissions.assignRole(userId, role.id, tenantId, ownerId);

    const canRead = await harness.permissions.hasPermission(userId, tenantId, "documents.read");
    const canWrite = await harness.permissions.hasPermission(userId, tenantId, "documents.write");
    const canDelete = await harness.permissions.hasPermission(userId, tenantId, "documents.delete");

    expect(canRead).toBe(true);
    expect(canWrite).toBe(true);
    expect(canDelete).toBe(false);
  });

  it("should handle wildcard permissions", async () => {
    // Owner should have admin role with wildcard
    const hasAll = await harness.permissions.hasPermission(ownerId, tenantId, "documents.delete");
    expect(hasAll).toBe(true);
  });

  it("should get user permissions", async () => {
    const userId = crypto.randomUUID();
    await harness.permissions.addTenantMember(tenantId, userId, ownerId);

    const role = await harness.permissions.createRole({
      tenantId,
      name: "Editor",
      permissions: ["documents.read", "documents.write"],
    });

    await harness.permissions.assignRole(userId, role.id, tenantId, ownerId);

    const permissions = await harness.permissions.getUserPermissions(userId, tenantId);
    expect(permissions).toContain("documents.read");
    expect(permissions).toContain("documents.write");
  });

  it("should reject permission for non-member", async () => {
    const randomUserId = crypto.randomUUID();
    const hasPermission = await harness.permissions.hasPermission(
      randomUserId,
      tenantId,
      "documents.read"
    );
    expect(hasPermission).toBe(false);
  });
});

// ==========================================
// Resource Grant Tests
// ==========================================
describe("Permissions Plugin - Resource Grants", () => {
  let harness: Awaited<ReturnType<typeof createPermissionsTestHarness>>;
  let tenantId: string;
  let ownerId: string;

  beforeEach(async () => {
    harness = await createPermissionsTestHarness();
    ownerId = crypto.randomUUID();
    const tenant = await harness.permissions.createTenant({
      name: "Test Org",
      slug: "test-org",
      ownerId,
    });
    tenantId = tenant.id;
  });

  afterEach(async () => {
    await harness.db.destroy();
  });

  it("should grant access to specific resource", async () => {
    const userId = crypto.randomUUID();
    await harness.permissions.addTenantMember(tenantId, userId, ownerId);

    await harness.permissions.grantAccess({
      granteeId: userId,
      granteeType: "user",
      tenantId,
      resourceType: "document",
      resourceId: "doc-123",
      permissions: ["read"],
      grantedBy: ownerId,
    });

    const canAccess = await harness.permissions.canAccess(
      userId,
      tenantId,
      "document",
      "doc-123",
      "read"
    );

    expect(canAccess).toBe(true);
  });

  it("should reject access without grant", async () => {
    const userId = crypto.randomUUID();
    await harness.permissions.addTenantMember(tenantId, userId, ownerId);

    const canAccess = await harness.permissions.canAccess(
      userId,
      tenantId,
      "document",
      "doc-123",
      "read"
    );

    expect(canAccess).toBe(false);
  });

  it("should allow owner access", async () => {
    const userId = crypto.randomUUID();
    await harness.permissions.addTenantMember(tenantId, userId, ownerId);

    // Check access with owner - should be allowed
    const canAccess = await harness.permissions.canAccess(
      userId,
      tenantId,
      "document",
      "doc-123",
      "read",
      userId // ownerId matches userId
    );

    expect(canAccess).toBe(true);
  });

  it("should revoke access", async () => {
    const userId = crypto.randomUUID();
    await harness.permissions.addTenantMember(tenantId, userId, ownerId);

    await harness.permissions.grantAccess({
      granteeId: userId,
      granteeType: "user",
      tenantId,
      resourceType: "document",
      resourceId: "doc-123",
      permissions: ["read"],
      grantedBy: ownerId,
    });

    await harness.permissions.revokeAccess({
      granteeId: userId,
      granteeType: "user",
      tenantId,
      resourceType: "document",
      resourceId: "doc-123",
    });

    const canAccess = await harness.permissions.canAccess(
      userId,
      tenantId,
      "document",
      "doc-123",
      "read"
    );

    expect(canAccess).toBe(false);
  });

  it("should get resource grants", async () => {
    const userId = crypto.randomUUID();
    await harness.permissions.addTenantMember(tenantId, userId, ownerId);

    await harness.permissions.grantAccess({
      granteeId: userId,
      granteeType: "user",
      tenantId,
      resourceType: "document",
      resourceId: "doc-123",
      permissions: ["read", "write"],
      grantedBy: ownerId,
    });

    const grants = await harness.permissions.getResourceGrants(
      tenantId,
      "document",
      "doc-123"
    );

    // One grant record with multiple permissions
    expect(grants.length).toBe(1);
    expect(grants[0].permissions).toContain("read");
    expect(grants[0].permissions).toContain("write");
  });
});

// ==========================================
// Context Building Tests
// ==========================================
describe("Permissions Plugin - Context Building", () => {
  let harness: Awaited<ReturnType<typeof createPermissionsTestHarness>>;
  let tenantId: string;
  let ownerId: string;

  beforeEach(async () => {
    harness = await createPermissionsTestHarness();
    ownerId = crypto.randomUUID();
    const tenant = await harness.permissions.createTenant({
      name: "Test Org",
      slug: "test-org",
      ownerId,
    });
    tenantId = tenant.id;
  });

  afterEach(async () => {
    await harness.db.destroy();
  });

  it("should build permission context", async () => {
    const context = await harness.permissions.buildContext(ownerId, tenantId);

    expect(context).toBeDefined();
    expect(context.userId).toBe(ownerId);
    expect(context.tenantId).toBe(tenantId);
    expect(context.roles.length).toBeGreaterThan(0);
    expect(context.permissions.size).toBeGreaterThan(0);
  });

  it("should get client context (serializable)", async () => {
    const context = await harness.permissions.getClientContext(ownerId, tenantId);

    expect(context).toBeDefined();
    expect(context.tenantId).toBe(tenantId);
    expect(Array.isArray(context.roles)).toBe(true);
    expect(Array.isArray(context.permissions)).toBe(true);
  });
});

// ==========================================
// Configuration Tests
// ==========================================
describe("Permissions Plugin - Configuration", () => {
  it("should expose permission definitions", async () => {
    const harness = await createPermissionsTestHarness();
    const definitions = harness.permissions.getPermissionDefinitions();

    expect(definitions).toBeDefined();
    expect(definitions.documents).toBeDefined();
    expect(definitions.members).toBeDefined();
    await harness.db.destroy();
  });
});
