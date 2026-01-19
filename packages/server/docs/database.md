# Database (Kysely)

This framework uses [Kysely](https://kysely.dev/) as its type-safe SQL query builder. Kysely provides compile-time type checking for all your database queries.

## Table of Contents

- [Setup](#setup)
- [Basic Queries](#basic-queries)
- [CRUD Operations](#crud-operations)
- [Joins and Relations](#joins-and-relations)
- [Transactions](#transactions)
- [Raw SQL](#raw-sql)
- [Migrations](#migrations)
- [Schema Generation](#schema-generation)
- [Best Practices](#best-practices)

---

## Setup

### Database Connection

```ts
// index.ts
import { AppServer } from "@donkeylabs/server";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";

// SQLite (development)
const db = new Kysely<DB>({
  dialect: new BunSqliteDialect({
    database: new Database("app.db")
  }),
});

// PostgreSQL (production)
import { PostgresDialect } from "kysely";
import { Pool } from "pg";

const db = new Kysely<DB>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: process.env.DATABASE_URL }),
  }),
});

const server = new AppServer({ db, port: 3000 });
```

### Accessing the Database

The database is available in:

1. **Route handlers** via `ctx.db`
2. **Plugin services** via `ctx.db` (typed with plugin schema)
3. **Plugin context** via `ctx.core.db` (global database)

```ts
// In a route handler
router.route("users.list").typed({
  handle: async (_, ctx) => {
    const users = await ctx.db
      .selectFrom("users")
      .selectAll()
      .execute();
    return { users };
  },
});

// In a plugin service
service: async (ctx) => ({
  async getUsers() {
    return ctx.db
      .selectFrom("users")
      .selectAll()
      .execute();
  },
}),
```

---

## Basic Queries

### SELECT

```ts
// Select all columns
const users = await ctx.db
  .selectFrom("users")
  .selectAll()
  .execute();

// Select specific columns
const users = await ctx.db
  .selectFrom("users")
  .select(["id", "name", "email"])
  .execute();

// Select with alias
const users = await ctx.db
  .selectFrom("users")
  .select([
    "id",
    "name",
    ctx.db.fn.count<number>("id").as("total"),
  ])
  .execute();

// Get single record (returns undefined if not found)
const user = await ctx.db
  .selectFrom("users")
  .selectAll()
  .where("id", "=", userId)
  .executeTakeFirst();

// Get single record (throws if not found)
const user = await ctx.db
  .selectFrom("users")
  .selectAll()
  .where("id", "=", userId)
  .executeTakeFirstOrThrow();
```

### WHERE Clauses

```ts
// Simple equality
.where("status", "=", "active")

// Multiple conditions (AND)
.where("status", "=", "active")
.where("role", "=", "admin")

// OR conditions
.where((eb) =>
  eb.or([
    eb("status", "=", "active"),
    eb("status", "=", "pending"),
  ])
)

// IN clause
.where("status", "in", ["active", "pending"])

// LIKE (pattern matching)
.where("email", "like", "%@gmail.com")

// NULL checks
.where("deleted_at", "is", null)
.where("deleted_at", "is not", null)

// Comparison operators
.where("age", ">=", 18)
.where("created_at", ">", "2024-01-01")

// Complex conditions
.where((eb) =>
  eb.and([
    eb("status", "=", "active"),
    eb.or([
      eb("role", "=", "admin"),
      eb("role", "=", "moderator"),
    ]),
  ])
)
```

### ORDER BY and LIMIT

```ts
// Order by single column
.orderBy("created_at", "desc")

// Order by multiple columns
.orderBy("status", "asc")
.orderBy("created_at", "desc")

// Pagination
.limit(20)
.offset(40)  // Skip first 40 records (page 3)
```

---

## CRUD Operations

### CREATE (INSERT)

```ts
// Insert single record
const user = await ctx.db
  .insertInto("users")
  .values({
    email: "user@example.com",
    name: "John Doe",
    created_at: new Date().toISOString(),
  })
  .returningAll()
  .executeTakeFirstOrThrow();

// Insert without returning
await ctx.db
  .insertInto("users")
  .values({
    email: "user@example.com",
    name: "John Doe",
  })
  .execute();

// Insert multiple records
await ctx.db
  .insertInto("users")
  .values([
    { email: "user1@example.com", name: "User 1" },
    { email: "user2@example.com", name: "User 2" },
    { email: "user3@example.com", name: "User 3" },
  ])
  .execute();

// Insert with specific columns returned
const { id } = await ctx.db
  .insertInto("users")
  .values({ email: "user@example.com", name: "John" })
  .returning(["id"])
  .executeTakeFirstOrThrow();

// Insert or update (upsert) - PostgreSQL
await ctx.db
  .insertInto("users")
  .values({ email: "user@example.com", name: "John" })
  .onConflict((oc) =>
    oc.column("email").doUpdateSet({ name: "John Updated" })
  )
  .execute();

// Insert or ignore - SQLite
await ctx.db
  .insertInto("users")
  .values({ email: "user@example.com", name: "John" })
  .onConflict((oc) => oc.column("email").doNothing())
  .execute();
```

### READ (SELECT)

```ts
// List with pagination
async function listUsers(page: number, limit: number = 20) {
  const offset = (page - 1) * limit;

  const [users, countResult] = await Promise.all([
    ctx.db
      .selectFrom("users")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(limit)
      .offset(offset)
      .execute(),
    ctx.db
      .selectFrom("users")
      .select(ctx.db.fn.count<number>("id").as("count"))
      .executeTakeFirst(),
  ]);

  return {
    users,
    total: countResult?.count ?? 0,
    page,
    totalPages: Math.ceil((countResult?.count ?? 0) / limit),
  };
}

// Find by ID
async function findById(id: number) {
  return ctx.db
    .selectFrom("users")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
}

// Find by unique field
async function findByEmail(email: string) {
  return ctx.db
    .selectFrom("users")
    .selectAll()
    .where("email", "=", email)
    .executeTakeFirst();
}

// Search with filters
async function searchUsers(filters: {
  search?: string;
  status?: string;
  role?: string;
}) {
  let query = ctx.db.selectFrom("users").selectAll();

  if (filters.search) {
    query = query.where((eb) =>
      eb.or([
        eb("name", "like", `%${filters.search}%`),
        eb("email", "like", `%${filters.search}%`),
      ])
    );
  }

  if (filters.status) {
    query = query.where("status", "=", filters.status);
  }

  if (filters.role) {
    query = query.where("role", "=", filters.role);
  }

  return query.orderBy("created_at", "desc").execute();
}
```

### UPDATE

```ts
// Update single record
const user = await ctx.db
  .updateTable("users")
  .set({
    name: "Jane Doe",
    updated_at: new Date().toISOString(),
  })
  .where("id", "=", userId)
  .returningAll()
  .executeTakeFirstOrThrow();

// Update without returning
await ctx.db
  .updateTable("users")
  .set({ status: "inactive" })
  .where("id", "=", userId)
  .execute();

// Update multiple records
await ctx.db
  .updateTable("users")
  .set({ status: "inactive" })
  .where("last_login", "<", thirtyDaysAgo)
  .execute();

// Increment a value
await ctx.db
  .updateTable("posts")
  .set((eb) => ({
    view_count: eb("view_count", "+", 1),
  }))
  .where("id", "=", postId)
  .execute();

// Conditional update
await ctx.db
  .updateTable("orders")
  .set({ status: "shipped" })
  .where("status", "=", "processing")
  .where("created_at", "<", oneDayAgo)
  .execute();
```

### DELETE

```ts
// Delete single record
await ctx.db
  .deleteFrom("users")
  .where("id", "=", userId)
  .execute();

// Delete with returning (get deleted record)
const deleted = await ctx.db
  .deleteFrom("users")
  .where("id", "=", userId)
  .returningAll()
  .executeTakeFirst();

// Delete multiple records
await ctx.db
  .deleteFrom("sessions")
  .where("expires_at", "<", new Date().toISOString())
  .execute();

// Soft delete pattern
await ctx.db
  .updateTable("users")
  .set({ deleted_at: new Date().toISOString() })
  .where("id", "=", userId)
  .execute();
```

---

## Joins and Relations

### INNER JOIN

```ts
// Get posts with author info
const posts = await ctx.db
  .selectFrom("posts")
  .innerJoin("users", "users.id", "posts.author_id")
  .select([
    "posts.id",
    "posts.title",
    "posts.content",
    "users.name as author_name",
    "users.email as author_email",
  ])
  .execute();
```

### LEFT JOIN

```ts
// Get users with their posts (users without posts included)
const usersWithPosts = await ctx.db
  .selectFrom("users")
  .leftJoin("posts", "posts.author_id", "users.id")
  .select([
    "users.id",
    "users.name",
    "posts.id as post_id",
    "posts.title as post_title",
  ])
  .execute();
```

### Multiple Joins

```ts
// Get orders with customer and product info
const orders = await ctx.db
  .selectFrom("orders")
  .innerJoin("users", "users.id", "orders.customer_id")
  .innerJoin("order_items", "order_items.order_id", "orders.id")
  .innerJoin("products", "products.id", "order_items.product_id")
  .select([
    "orders.id as order_id",
    "orders.total",
    "users.name as customer_name",
    "products.name as product_name",
    "order_items.quantity",
  ])
  .execute();
```

### Subqueries

```ts
// Get users with post count
const users = await ctx.db
  .selectFrom("users")
  .select([
    "users.id",
    "users.name",
    (eb) =>
      eb
        .selectFrom("posts")
        .select(eb.fn.count<number>("id").as("count"))
        .where("posts.author_id", "=", eb.ref("users.id"))
        .as("post_count"),
  ])
  .execute();
```

---

## Transactions

```ts
// Basic transaction
const result = await ctx.db.transaction().execute(async (trx) => {
  // All queries use `trx` instead of `ctx.db`
  const user = await trx
    .insertInto("users")
    .values({ email: "user@example.com", name: "John" })
    .returningAll()
    .executeTakeFirstOrThrow();

  await trx
    .insertInto("user_profiles")
    .values({ user_id: user.id, bio: "Hello world" })
    .execute();

  return user;
});

// Transaction with rollback on error
async function transferFunds(fromId: number, toId: number, amount: number) {
  return ctx.db.transaction().execute(async (trx) => {
    // Deduct from sender
    const sender = await trx
      .updateTable("accounts")
      .set((eb) => ({ balance: eb("balance", "-", amount) }))
      .where("id", "=", fromId)
      .where("balance", ">=", amount)  // Ensure sufficient funds
      .returningAll()
      .executeTakeFirst();

    if (!sender) {
      throw new Error("Insufficient funds");
    }

    // Add to receiver
    await trx
      .updateTable("accounts")
      .set((eb) => ({ balance: eb("balance", "+", amount) }))
      .where("id", "=", toId)
      .execute();

    // Log the transfer
    await trx
      .insertInto("transfers")
      .values({
        from_id: fromId,
        to_id: toId,
        amount,
        created_at: new Date().toISOString(),
      })
      .execute();

    return { success: true };
  });
}
```

---

## Raw SQL

Use raw SQL sparingly, only when Kysely's query builder doesn't support your use case.

```ts
import { sql } from "kysely";

// Raw expression in SELECT
const users = await ctx.db
  .selectFrom("users")
  .select([
    "id",
    "name",
    sql<string>`UPPER(${sql.ref("email")})`.as("email_upper"),
  ])
  .execute();

// Raw WHERE condition
const users = await ctx.db
  .selectFrom("users")
  .selectAll()
  .where(sql`LOWER(email) = ${email.toLowerCase()}`)
  .execute();

// Full raw query (avoid if possible)
const result = await sql<{ count: number }>`
  SELECT COUNT(*) as count
  FROM users
  WHERE created_at > ${startDate}
`.execute(ctx.db);
```

---

## Migrations

### Creating Migrations

Migrations are TypeScript files in the plugin's `migrations/` folder:

```ts
// plugins/users/migrations/001_create_users.ts
import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("users")
    .ifNotExists()
    .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
    .addColumn("email", "text", (c) => c.notNull().unique())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("password_hash", "text")
    .addColumn("status", "text", (c) => c.defaultTo("active"))
    .addColumn("created_at", "text", (c) =>
      c.defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .addColumn("updated_at", "text")
    .execute();

  // Create index
  await db.schema
    .createIndex("idx_users_email")
    .on("users")
    .column("email")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("users").ifExists().execute();
}
```

### Common Schema Operations

```ts
// Add column
await db.schema
  .alterTable("users")
  .addColumn("phone", "text")
  .execute();

// Rename column (PostgreSQL)
await db.schema
  .alterTable("users")
  .renameColumn("name", "full_name")
  .execute();

// Drop column
await db.schema
  .alterTable("users")
  .dropColumn("legacy_field")
  .execute();

// Create index
await db.schema
  .createIndex("idx_posts_author")
  .on("posts")
  .column("author_id")
  .execute();

// Create unique index
await db.schema
  .createIndex("idx_users_email_unique")
  .on("users")
  .column("email")
  .unique()
  .execute();

// Create composite index
await db.schema
  .createIndex("idx_orders_customer_date")
  .on("orders")
  .columns(["customer_id", "created_at"])
  .execute();

// Foreign key
await db.schema
  .alterTable("posts")
  .addForeignKeyConstraint(
    "fk_posts_author",
    ["author_id"],
    "users",
    ["id"]
  )
  .onDelete("cascade")
  .execute();
```

---

## Schema Generation

After creating migrations, generate TypeScript types:

```sh
# Generate types for a plugin
bunx donkeylabs generate

# Or for a specific plugin
bun scripts/generate-types.ts <plugin-name>
```

This creates `schema.ts` with full type definitions:

```ts
// plugins/users/schema.ts (auto-generated)
export interface DB {
  users: {
    id: number;
    email: string;
    name: string;
    password_hash: string | null;
    status: string;
    created_at: string;
    updated_at: string | null;
  };
}
```

---

## Best Practices

### 1. Always Use Type-Safe Queries

```ts
// GOOD: Type-safe with autocomplete
const user = await ctx.db
  .selectFrom("users")
  .select(["id", "email", "name"])  // Autocomplete works!
  .where("id", "=", userId)
  .executeTakeFirst();

// BAD: Raw SQL loses type safety
const user = await sql`SELECT * FROM users WHERE id = ${userId}`.execute(ctx.db);
```

### 2. Keep Database Logic in Plugins

```ts
// GOOD: Database logic in plugin service
export const usersPlugin = createPlugin.withSchema<DB>().define({
  name: "users",
  service: async (ctx) => ({
    async findByEmail(email: string) {
      return ctx.db
        .selectFrom("users")
        .selectAll()
        .where("email", "=", email)
        .executeTakeFirst();
    },
  }),
});

// BAD: Database logic in route handler
router.route("user.get").typed({
  handle: async (input, ctx) => {
    // Move this to a plugin!
    return ctx.db.selectFrom("users").where("email", "=", input.email)...
  },
});
```

### 3. Use Transactions for Multi-Step Operations

```ts
// GOOD: Atomic operation
await ctx.db.transaction().execute(async (trx) => {
  await trx.insertInto("orders").values(order).execute();
  await trx.insertInto("order_items").values(items).execute();
  await trx.updateTable("inventory").set(...).execute();
});

// BAD: Non-atomic (can leave inconsistent state)
await ctx.db.insertInto("orders").values(order).execute();
await ctx.db.insertInto("order_items").values(items).execute();
await ctx.db.updateTable("inventory").set(...).execute();
```

### 4. Use Parameterized Queries (Automatic with Kysely)

Kysely automatically parameterizes all values, preventing SQL injection:

```ts
// Safe - Kysely parameterizes automatically
const user = await ctx.db
  .selectFrom("users")
  .where("email", "=", userInput)  // userInput is safely escaped
  .executeTakeFirst();

// Also safe
.where("email", "like", `%${searchTerm}%`)
```

### 5. Prefer `executeTakeFirst` Over Array Access

```ts
// GOOD: Clear intent, proper typing
const user = await ctx.db
  .selectFrom("users")
  .selectAll()
  .where("id", "=", id)
  .executeTakeFirst();  // Returns User | undefined

// BAD: Unnecessary array, less clear
const [user] = await ctx.db
  .selectFrom("users")
  .selectAll()
  .where("id", "=", id)
  .execute();
```

### 6. Use `executeTakeFirstOrThrow` When Record Must Exist

```ts
// When you expect the record to exist
const user = await ctx.db
  .selectFrom("users")
  .selectAll()
  .where("id", "=", id)
  .executeTakeFirstOrThrow();  // Throws if not found

// Handle gracefully when it might not exist
const user = await ctx.db
  .selectFrom("users")
  .selectAll()
  .where("id", "=", id)
  .executeTakeFirst();

if (!user) {
  throw new NotFoundError("User not found");
}
```

---

## Resources

- [Kysely Documentation](https://kysely.dev/)
- [Kysely API Reference](https://kysely-org.github.io/kysely-apidoc/)
- [Kysely GitHub](https://github.com/kysely-org/kysely)
