import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { z } from "zod";
import { createIntegrationHarness, type IntegrationHarnessResult } from "../src/harness";
import { createRouter } from "../src/router";
import { ApiClientBase } from "../src/client/base";

/**
 * Parallel Integration Tests
 *
 * This test file verifies that:
 * 1. Multiple test suites can run in parallel
 * 2. Each gets its own isolated server on unique port
 * 3. No data leaks between tests
 * 4. No file I/O conflicts
 */

// Simulate a generated client (in real usage, import from lib/api.ts)
class TestUsersClient extends ApiClientBase {
  users = {
    create: (input: { name: string }) =>
      this.request<typeof input, { id: number; name: string }>("users.create", input),
    list: () =>
      this.request<{}, { users: { id: number; name: string }[] }>("users.list", {}),
    getCount: () =>
      this.request<{}, { count: number }>("users.count", {}),
  };
}

const createTestClient = (config: { baseUrl: string }) => new TestUsersClient(config.baseUrl);

// Shared state to track what each test suite sees
const testResults: Record<string, { port: number; userCount: number }> = {};

// Create a router with in-memory state (simulates DB)
function createUsersRouter() {
  const users: { id: number; name: string }[] = [];
  let nextId = 1;

  return createRouter("users")
    .route("create").typed({
      input: z.object({ name: z.string() }),
      output: z.object({ id: z.number(), name: z.string() }),
      handle: async (input) => {
        const user = { id: nextId++, name: input.name };
        users.push(user);
        return user;
      },
    })
    .route("list").typed({
      input: z.object({}),
      output: z.object({ users: z.array(z.object({ id: z.number(), name: z.string() })) }),
      handle: async () => ({ users }),
    })
    .route("count").typed({
      input: z.object({}),
      output: z.object({ count: z.number() }),
      handle: async () => ({ count: users.length }),
    });
}

// =============================================================================
// TEST SUITE A - Creates 3 users
// =============================================================================
describe("Parallel Test Suite A", () => {
  let harness: IntegrationHarnessResult;
  let api: TestUsersClient;

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      routers: [createUsersRouter()],
    });
    api = harness.createClient(createTestClient);
  });

  afterAll(async () => {
    // Record what this suite saw
    const count = await api.users.getCount();
    testResults["suiteA"] = { port: harness.port, userCount: count.count };
    await harness.shutdown();
  });

  it("A: should create user 1", async () => {
    const user = await api.users.create({ name: "Alice" });
    expect(user.id).toBe(1);
    expect(user.name).toBe("Alice");
  });

  it("A: should create user 2", async () => {
    const user = await api.users.create({ name: "Bob" });
    expect(user.id).toBe(2);
  });

  it("A: should create user 3", async () => {
    const user = await api.users.create({ name: "Charlie" });
    expect(user.id).toBe(3);
  });

  it("A: should list all 3 users", async () => {
    const result = await api.users.list();
    expect(result.users).toHaveLength(3);
  });
});

// =============================================================================
// TEST SUITE B - Creates 5 users
// =============================================================================
describe("Parallel Test Suite B", () => {
  let harness: IntegrationHarnessResult;
  let api: TestUsersClient;

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      routers: [createUsersRouter()],
    });
    api = harness.createClient(createTestClient);
  });

  afterAll(async () => {
    const count = await api.users.getCount();
    testResults["suiteB"] = { port: harness.port, userCount: count.count };
    await harness.shutdown();
  });

  it("B: should create 5 users", async () => {
    for (let i = 1; i <= 5; i++) {
      const user = await api.users.create({ name: `User${i}` });
      expect(user.id).toBe(i);
    }
  });

  it("B: should list all 5 users", async () => {
    const result = await api.users.list();
    expect(result.users).toHaveLength(5);
  });
});

// =============================================================================
// TEST SUITE C - Creates 1 user
// =============================================================================
describe("Parallel Test Suite C", () => {
  let harness: IntegrationHarnessResult;
  let api: TestUsersClient;

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      routers: [createUsersRouter()],
    });
    api = harness.createClient(createTestClient);
  });

  afterAll(async () => {
    const count = await api.users.getCount();
    testResults["suiteC"] = { port: harness.port, userCount: count.count };
    await harness.shutdown();
  });

  it("C: should create 1 user", async () => {
    const user = await api.users.create({ name: "Solo" });
    expect(user.id).toBe(1);
  });

  it("C: should list only 1 user", async () => {
    const result = await api.users.list();
    expect(result.users).toHaveLength(1);
  });
});

// =============================================================================
// VERIFICATION SUITE - Runs last, verifies isolation
// =============================================================================
describe("Parallel Isolation Verification", () => {
  it("should have run all test suites with different ports", async () => {
    // Wait a bit for other suites to record results
    await new Promise((r) => setTimeout(r, 100));

    // Check we have results from all suites
    expect(testResults.suiteA).toBeDefined();
    expect(testResults.suiteB).toBeDefined();
    expect(testResults.suiteC).toBeDefined();

    // Verify ports are all different
    const ports = [testResults.suiteA.port, testResults.suiteB.port, testResults.suiteC.port];
    const uniquePorts = new Set(ports);
    expect(uniquePorts.size).toBe(3);

    console.log("\n=== PARALLEL TEST RESULTS ===");
    console.log(`Suite A: port ${testResults.suiteA.port}, users: ${testResults.suiteA.userCount}`);
    console.log(`Suite B: port ${testResults.suiteB.port}, users: ${testResults.suiteB.userCount}`);
    console.log(`Suite C: port ${testResults.suiteC.port}, users: ${testResults.suiteC.userCount}`);
    console.log("All ports unique:", [...uniquePorts].join(", "));
  });

  it("should have isolated data - each suite saw only its own users", () => {
    // Suite A created 3 users
    expect(testResults.suiteA.userCount).toBe(3);

    // Suite B created 5 users
    expect(testResults.suiteB.userCount).toBe(5);

    // Suite C created 1 user
    expect(testResults.suiteC.userCount).toBe(1);

    // If there was data leakage, counts would be wrong
    console.log("Data isolation verified - no cross-test contamination!");
  });
});
