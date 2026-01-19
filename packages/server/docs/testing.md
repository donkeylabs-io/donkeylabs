# Testing

This guide covers testing plugins and routes using the built-in test harness.

## Table of Contents

- [Test Harness](#test-harness)
- [Unit Testing Plugins](#unit-testing-plugins)
- [Integration Testing](#integration-testing)
- [Testing Routes](#testing-routes)
- [Mocking Core Services](#mocking-core-services)
- [Test Organization](#test-organization)
- [Running Tests](#running-tests)

---

## Test Harness

The test harness creates a fully functional in-memory testing environment with real SQLite, migrations, and all core services.

```ts
import { createTestHarness } from "@donkeylabs/server/harness";
import { myPlugin } from "./plugins/myPlugin";

const { manager, db, core } = await createTestHarness(myPlugin);

// Access plugin services
const service = manager.getServices().myPlugin;

// Access database directly
const rows = await db.selectFrom("my_table").selectAll().execute();

// Access core services
core.logger.info("Test log");
core.cache.set("key", "value");
```

### With Dependencies

If your plugin depends on other plugins, pass them as the second argument:

```ts
import { createTestHarness } from "@donkeylabs/server/harness";
import { ordersPlugin } from "./plugins/orders";
import { usersPlugin } from "./plugins/users";

// ordersPlugin depends on usersPlugin
const { manager } = await createTestHarness(ordersPlugin, [usersPlugin]);

const orders = manager.getServices().orders;
const users = manager.getServices().users;
```

---

## Unit Testing Plugins

Unit tests verify individual plugin methods in isolation.

### Basic Plugin Test

```ts
// plugins/calculator/calculator.test.ts
import { describe, test, expect } from "bun:test";
import { createTestHarness } from "@donkeylabs/server/harness";
import { calculatorPlugin } from "./index";

describe("calculatorPlugin", () => {
  test("add() returns correct sum", async () => {
    const { manager } = await createTestHarness(calculatorPlugin);
    const calc = manager.getServices().calculator;

    expect(calc.add(2, 3)).toBe(5);
    expect(calc.add(-1, 1)).toBe(0);
  });

  test("divide() throws on zero", async () => {
    const { manager } = await createTestHarness(calculatorPlugin);
    const calc = manager.getServices().calculator;

    expect(() => calc.divide(10, 0)).toThrow("Cannot divide by zero");
  });
});
```

### Testing Database Operations

```ts
// plugins/users/users.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { createTestHarness } from "@donkeylabs/server/harness";
import { usersPlugin } from "./index";

describe("usersPlugin", () => {
  let users: ReturnType<typeof manager.getServices>["users"];
  let db: Awaited<ReturnType<typeof createTestHarness>>["db"];

  beforeEach(async () => {
    const harness = await createTestHarness(usersPlugin);
    users = harness.manager.getServices().users;
    db = harness.db;
  });

  test("create() inserts user into database", async () => {
    const user = await users.create({
      email: "test@example.com",
      name: "Test User",
    });

    expect(user.id).toBeDefined();
    expect(user.email).toBe("test@example.com");

    // Verify in database
    const dbUser = await db
      .selectFrom("users")
      .where("id", "=", user.id)
      .selectAll()
      .executeTakeFirst();

    expect(dbUser).toBeDefined();
    expect(dbUser?.email).toBe("test@example.com");
  });

  test("findByEmail() returns null for non-existent user", async () => {
    const user = await users.findByEmail("notfound@example.com");
    expect(user).toBeNull();
  });

  test("findByEmail() returns user when exists", async () => {
    await users.create({ email: "exists@example.com", name: "Exists" });

    const user = await users.findByEmail("exists@example.com");
    expect(user).not.toBeNull();
    expect(user?.name).toBe("Exists");
  });
});
```

---

## Integration Testing

Integration tests verify multiple plugins working together.

```ts
// tests/checkout.integ.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { createTestHarness } from "@donkeylabs/server/harness";
import { ordersPlugin } from "../plugins/orders";
import { usersPlugin } from "../plugins/users";
import { inventoryPlugin } from "../plugins/inventory";

describe("Checkout Integration", () => {
  let services: {
    orders: ReturnType<typeof manager.getServices>["orders"];
    users: ReturnType<typeof manager.getServices>["users"];
    inventory: ReturnType<typeof manager.getServices>["inventory"];
  };

  beforeEach(async () => {
    const { manager } = await createTestHarness(ordersPlugin, [
      usersPlugin,
      inventoryPlugin,
    ]);
    services = manager.getServices() as typeof services;
  });

  test("checkout reduces inventory and creates order", async () => {
    // Setup: Create user and add inventory
    const user = await services.users.create({
      email: "buyer@example.com",
      name: "Buyer",
    });
    await services.inventory.add("SKU-001", 10);

    // Action: Checkout
    const order = await services.orders.checkout({
      userId: user.id,
      items: [{ sku: "SKU-001", quantity: 2 }],
    });

    // Assert: Order created
    expect(order.status).toBe("completed");
    expect(order.items).toHaveLength(1);

    // Assert: Inventory reduced
    const stock = await services.inventory.getStock("SKU-001");
    expect(stock).toBe(8);
  });

  test("checkout fails when insufficient inventory", async () => {
    const user = await services.users.create({
      email: "buyer@example.com",
      name: "Buyer",
    });
    await services.inventory.add("SKU-002", 1);

    await expect(
      services.orders.checkout({
        userId: user.id,
        items: [{ sku: "SKU-002", quantity: 5 }],
      })
    ).rejects.toThrow("Insufficient inventory");
  });
});
```

---

## Testing Routes

For route testing, use Bun's built-in fetch or create a test server.

### Direct Handler Testing

```ts
// routes/users/users.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { createTestHarness } from "@donkeylabs/server/harness";
import { usersPlugin } from "../../plugins/users";
import { CreateUserHandler } from "./handlers/create-user";

describe("CreateUserHandler", () => {
  let ctx: Awaited<ReturnType<typeof createTestHarness>>["core"] & {
    plugins: ReturnType<typeof manager.getServices>;
  };

  beforeEach(async () => {
    const { manager, core } = await createTestHarness(usersPlugin);
    ctx = {
      ...core,
      plugins: manager.getServices(),
    };
  });

  test("creates user with valid input", async () => {
    const handler = new CreateUserHandler(ctx as any);
    const result = await handler.handle({
      email: "new@example.com",
      name: "New User",
    });

    expect(result.id).toBeDefined();
    expect(result.email).toBe("new@example.com");
  });
});
```

### Full HTTP Testing

```ts
// tests/api.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppServer } from "@donkeylabs/server";
import { usersPlugin } from "../plugins/users";
import { usersRouter } from "../routes/users";

describe("Users API", () => {
  let server: AppServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new AppServer({
      db: createTestDb(),
      port: 0, // Random available port
    });
    server.registerPlugin(usersPlugin);
    server.use(usersRouter);
    await server.start();
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  test("POST /users.create creates a user", async () => {
    const response = await fetch(`${baseUrl}/users.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "api@example.com",
        name: "API User",
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBeDefined();
    expect(data.email).toBe("api@example.com");
  });

  test("POST /users.create returns 400 for invalid email", async () => {
    const response = await fetch(`${baseUrl}/users.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "not-an-email",
        name: "Bad User",
      }),
    });

    expect(response.status).toBe(400);
  });
});
```

---

## Mocking Core Services

The test harness provides real implementations, but you can mock specific services:

```ts
import { describe, test, expect, mock } from "bun:test";
import { createTestHarness } from "@donkeylabs/server/harness";
import { notificationsPlugin } from "./index";

describe("notificationsPlugin with mocked email", () => {
  test("sendEmail() is called with correct args", async () => {
    const { manager, core } = await createTestHarness(notificationsPlugin);

    // Mock the email sending function
    const sendEmailMock = mock(() => Promise.resolve());
    const notifications = manager.getServices().notifications;
    notifications.sendEmail = sendEmailMock;

    await notifications.notifyUser("user-123", "Hello!");

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: expect.any(String),
        subject: expect.stringContaining("Hello"),
      })
    );
  });
});
```

---

## Test Organization

### Recommended Structure

```
src/
├── plugins/
│   └── users/
│       ├── index.ts
│       ├── schema.ts
│       ├── migrations/
│       └── tests/
│           ├── unit.test.ts      # Unit tests for service methods
│           └── integ.test.ts     # Integration tests with other plugins
├── routes/
│   └── users/
│       ├── index.ts
│       ├── handlers/
│       └── tests/
│           └── api.test.ts       # Route/API tests
└── tests/
    └── e2e/                      # End-to-end tests
        └── checkout.test.ts
```

### Naming Conventions

- `*.test.ts` - Unit tests (run with `bun test`)
- `*.integ.test.ts` - Integration tests
- `*.e2e.test.ts` - End-to-end tests

---

## Running Tests

```sh
# Run all tests
bun test

# Run tests for a specific plugin
bun test plugins/users

# Run tests matching a pattern
bun test --grep "create"

# Run tests in watch mode
bun test --watch

# Run with coverage
bun test --coverage
```

### Type Checking

Always run type checking before committing:

```sh
bun --bun tsc --noEmit
```

### CI Pipeline Example

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun --bun tsc --noEmit
      - run: bun test
```

---

## Best Practices

1. **Use fresh harness per test** - Create a new harness in `beforeEach` to ensure test isolation
2. **Test the public API** - Focus on testing service methods, not internal implementation
3. **Use realistic data** - Create test data that resembles production data
4. **Test edge cases** - Empty inputs, null values, boundary conditions
5. **Test error cases** - Verify proper error throwing and handling
6. **Keep tests fast** - In-memory SQLite is fast; avoid unnecessary delays
7. **Run type checks** - Always run `tsc --noEmit` before committing
