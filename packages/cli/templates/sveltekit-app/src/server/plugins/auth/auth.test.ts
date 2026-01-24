/**
 * Auth Plugin Tests
 *
 * Tests for authentication with multiple strategies:
 * - session: Stateful database sessions
 * - jwt: Stateless JWT tokens
 * - refresh-token: Access + refresh token pattern
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestHarness } from "@donkeylabs/server";
import { authPlugin } from "./index";

// Helper to create test harness with auth plugin
async function createAuthTestHarness(config: Parameters<typeof authPlugin>[0] = {}) {
  const harness = await createTestHarness(authPlugin(config));
  return { ...harness, auth: harness.manager.getServices().auth };
}

// ==========================================
// Session Strategy Tests
// ==========================================
describe("Auth Plugin - Session Strategy", () => {
  let harness: Awaited<ReturnType<typeof createAuthTestHarness>>;

  beforeEach(async () => {
    harness = await createAuthTestHarness({ strategy: "session" });
  });

  afterEach(async () => {
    await harness.db.destroy();
  });

  it("should register a new user", async () => {
    const result = await harness.auth.register({
      email: "test@example.com",
      password: "password123",
      name: "Test User",
    });

    expect(result.user).toBeDefined();
    expect(result.user.email).toBe("test@example.com");
    expect(result.user.name).toBe("Test User");
    expect(result.tokens.accessToken).toBeDefined();
    expect(result.tokens.expiresIn).toBeGreaterThan(0);
  });

  it("should prevent duplicate email registration", async () => {
    await harness.auth.register({
      email: "test@example.com",
      password: "password123",
    });

    await expect(
      harness.auth.register({
        email: "test@example.com",
        password: "differentpassword",
      })
    ).rejects.toThrow();
  });

  it("should login with correct credentials", async () => {
    await harness.auth.register({
      email: "test@example.com",
      password: "password123",
    });

    const result = await harness.auth.login({
      email: "test@example.com",
      password: "password123",
    });

    expect(result.user.email).toBe("test@example.com");
    expect(result.tokens.accessToken).toBeDefined();
  });

  it("should reject login with wrong password", async () => {
    await harness.auth.register({
      email: "test@example.com",
      password: "password123",
    });

    await expect(
      harness.auth.login({
        email: "test@example.com",
        password: "wrongpassword",
      })
    ).rejects.toThrow();
  });

  it("should reject login for non-existent user", async () => {
    await expect(
      harness.auth.login({
        email: "nonexistent@example.com",
        password: "password123",
      })
    ).rejects.toThrow();
  });

  it("should validate session token", async () => {
    const { tokens } = await harness.auth.register({
      email: "test@example.com",
      password: "password123",
    });

    const user = await harness.auth.validateToken(tokens.accessToken);
    expect(user).toBeDefined();
    expect(user?.email).toBe("test@example.com");
  });

  it("should invalidate session on logout", async () => {
    const { tokens } = await harness.auth.register({
      email: "test@example.com",
      password: "password123",
    });

    await harness.auth.logout(tokens.accessToken);

    const user = await harness.auth.validateToken(tokens.accessToken);
    expect(user).toBeNull();
  });

  it("should return null for invalid token", async () => {
    const user = await harness.auth.validateToken("invalid-token");
    expect(user).toBeNull();
  });

  it("should get user by ID", async () => {
    const { user: created } = await harness.auth.register({
      email: "test@example.com",
      password: "password123",
      name: "Test User",
    });

    const user = await harness.auth.getUserById(created.id);
    expect(user).toBeDefined();
    expect(user?.email).toBe("test@example.com");
  });

  it("should update user profile", async () => {
    const { user: created } = await harness.auth.register({
      email: "test@example.com",
      password: "password123",
      name: "Original Name",
    });

    const updated = await harness.auth.updateProfile(created.id, {
      name: "Updated Name",
    });

    expect(updated.name).toBe("Updated Name");
  });
});

// ==========================================
// JWT Strategy Tests
// ==========================================
describe("Auth Plugin - JWT Strategy", () => {
  let harness: Awaited<ReturnType<typeof createAuthTestHarness>>;

  beforeEach(async () => {
    harness = await createAuthTestHarness({
      strategy: "jwt",
      jwt: { secret: "test-secret-key-at-least-32-chars!" },
    });
  });

  afterEach(async () => {
    await harness.db.destroy();
  });

  it("should register and return JWT token", async () => {
    const result = await harness.auth.register({
      email: "test@example.com",
      password: "password123",
    });

    expect(result.tokens.accessToken).toBeDefined();
    // JWT tokens are longer and have 3 parts
    expect(result.tokens.accessToken.split(".").length).toBe(3);
    expect(result.tokens.refreshToken).toBeUndefined();
  });

  it("should validate JWT token", async () => {
    const { tokens } = await harness.auth.register({
      email: "test@example.com",
      password: "password123",
    });

    const user = await harness.auth.validateToken(tokens.accessToken);
    expect(user).toBeDefined();
    expect(user?.email).toBe("test@example.com");
  });

  it("should reject invalid JWT token", async () => {
    const user = await harness.auth.validateToken("invalid.jwt.token");
    expect(user).toBeNull();
  });

  it("should login and return JWT", async () => {
    await harness.auth.register({
      email: "test@example.com",
      password: "password123",
    });

    const result = await harness.auth.login({
      email: "test@example.com",
      password: "password123",
    });

    expect(result.tokens.accessToken.split(".").length).toBe(3);
  });
});

// ==========================================
// Refresh Token Strategy Tests
// ==========================================
describe("Auth Plugin - Refresh Token Strategy", () => {
  let harness: Awaited<ReturnType<typeof createAuthTestHarness>>;

  beforeEach(async () => {
    harness = await createAuthTestHarness({
      strategy: "refresh-token",
      jwt: { secret: "test-secret-key-at-least-32-chars!" },
    });
  });

  afterEach(async () => {
    await harness.db.destroy();
  });

  it("should return both access and refresh tokens", async () => {
    const result = await harness.auth.register({
      email: "test@example.com",
      password: "password123",
    });

    expect(result.tokens.accessToken).toBeDefined();
    expect(result.tokens.refreshToken).toBeDefined();
    expect(result.tokens.accessToken.split(".").length).toBe(3);
    expect(result.tokens.refreshToken!.split(".").length).toBe(3);
  });

  it("should validate access token", async () => {
    const { tokens } = await harness.auth.register({
      email: "test@example.com",
      password: "password123",
    });

    const user = await harness.auth.validateToken(tokens.accessToken);
    expect(user).toBeDefined();
    expect(user?.email).toBe("test@example.com");
  });

  it("should refresh tokens with refresh token", async () => {
    const { tokens: initial } = await harness.auth.register({
      email: "test@example.com",
      password: "password123",
    });

    // Small delay to ensure different token timestamps
    await new Promise(resolve => setTimeout(resolve, 10));

    const refreshed = await harness.auth.refresh(initial.refreshToken!);

    expect(refreshed.accessToken).toBeDefined();
    // Verify we got a new valid token (structure check)
    expect(refreshed.accessToken.split(".").length).toBe(3);
    expect(refreshed.expiresIn).toBeGreaterThan(0);
  });

  it("should reject invalid refresh token", async () => {
    await expect(
      harness.auth.refresh("invalid.refresh.token")
    ).rejects.toThrow();
  });

  it("should invalidate refresh token on logout", async () => {
    const { tokens } = await harness.auth.register({
      email: "test@example.com",
      password: "password123",
    });

    await harness.auth.logout(tokens.refreshToken!);

    await expect(
      harness.auth.refresh(tokens.refreshToken!)
    ).rejects.toThrow();
  });
});

// ==========================================
// Configuration Tests
// ==========================================
describe("Auth Plugin - Configuration", () => {
  it("should use session strategy by default", async () => {
    const harness = await createAuthTestHarness({});
    expect(harness.auth.getStrategy()).toBe("session");
    await harness.db.destroy();
  });

  it("should respect custom strategy", async () => {
    const harness = await createAuthTestHarness({
      strategy: "jwt",
      jwt: { secret: "test-secret-key-at-least-32-chars!" },
    });
    expect(harness.auth.getStrategy()).toBe("jwt");
    await harness.db.destroy();
  });

  it("should throw if JWT secret missing for jwt strategy", async () => {
    await expect(
      createAuthTestHarness({ strategy: "jwt" })
    ).rejects.toThrow(/jwt.secret/);
  });

  it("should throw if JWT secret missing for refresh-token strategy", async () => {
    await expect(
      createAuthTestHarness({ strategy: "refresh-token" })
    ).rejects.toThrow(/jwt.secret/);
  });

  it("should return cookie config", async () => {
    const harness = await createAuthTestHarness({
      cookie: { name: "myauth", httpOnly: true, secure: false },
    });
    const config = harness.auth.getCookieConfig();
    expect(config.name).toBe("myauth");
    expect(config.httpOnly).toBe(true);
    expect(config.secure).toBe(false);
    await harness.db.destroy();
  });
});

// ==========================================
// Edge Cases
// ==========================================
describe("Auth Plugin - Edge Cases", () => {
  let harness: Awaited<ReturnType<typeof createAuthTestHarness>>;

  beforeEach(async () => {
    harness = await createAuthTestHarness({ strategy: "session" });
  });

  afterEach(async () => {
    await harness.db.destroy();
  });

  it("should handle email case-insensitively", async () => {
    await harness.auth.register({
      email: "Test@Example.COM",
      password: "password123",
    });

    const result = await harness.auth.login({
      email: "test@example.com",
      password: "password123",
    });

    expect(result.user.email).toBe("test@example.com");
  });

  it("should handle registration without name", async () => {
    const result = await harness.auth.register({
      email: "test@example.com",
      password: "password123",
    });

    expect(result.user.name).toBeNull();
  });

  it("should return null for non-existent user ID", async () => {
    const user = await harness.auth.getUserById("non-existent-id");
    expect(user).toBeNull();
  });

});
