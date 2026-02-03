// packages/server/src/testing/database.ts
/**
 * Database Testing Utilities
 *
 * Helper functions for setting up and managing test databases.
 *
 * Usage:
 *   const db = await createTestDatabase({ type: "sqlite" });
 *   await seedTestData(db, { users: [{ email: "test@example.com" }] });
 *   // Run tests...
 *   await db.destroy();
 */

import { Kysely, PostgresDialect, MysqlDialect } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import Database from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// pg and mysql2 are optional - dynamically imported when needed

export interface TestDatabaseOptions {
  /** Database type */
  type: "sqlite" | "postgres" | "mysql";
  
  /** Path to migrations (glob pattern) */
  migrations?: string;
  
  /** Run migrations automatically */
  runMigrations?: boolean;
  
  /** Isolated database (deleted after tests) */
  isolated?: boolean;
  
  /** Connection string (for postgres/mysql) */
  connectionString?: string;
}

/**
 * Create a test database instance
 */
export async function createTestDatabase(options: TestDatabaseOptions): Promise<Kysely<any>> {
  let db: Kysely<any>;
  let cleanupPath: string | null = null;
  
  switch (options.type) {
    case "sqlite": {
      let dbPath: string;
      
      if (options.isolated !== false) {
        // Create isolated temp database
        const tmpDir = mkdtempSync(join(tmpdir(), "donkeylabs-test-"));
        dbPath = join(tmpDir, "test.db");
        cleanupPath = tmpDir;
      } else {
        dbPath = options.connectionString || ":memory:";
      }
      
      db = new Kysely({
        dialect: new BunSqliteDialect({
          database: new Database(dbPath),
        }),
      });
      break;
    }
    
    case "postgres": {
      const connectionString = options.connectionString || process.env.TEST_DATABASE_URL;
      if (!connectionString) {
        throw new Error("TEST_DATABASE_URL not set for postgres");
      }

      // Dynamic import - pg is optional peer dependency
      // @ts-ignore - pg may not be installed
      const { Pool: PGPool } = await import("pg");

      db = new Kysely({
        dialect: new PostgresDialect({
          pool: new PGPool({
            connectionString,
            max: 5,
          }),
        }),
      });
      break;
    }

    case "mysql": {
      const connectionString = options.connectionString || process.env.TEST_DATABASE_URL;
      if (!connectionString) {
        throw new Error("TEST_DATABASE_URL not set for mysql");
      }

      // Dynamic import - mysql2 is optional peer dependency
      // @ts-ignore - mysql2 may not be installed
      const { createPool: createMySQLPool } = await import("mysql2");

      db = new Kysely({
        dialect: new MysqlDialect({
          pool: createMySQLPool({
            uri: connectionString,
            connectionLimit: 5,
          }),
        }),
      });
      break;
    }
    
    default:
      throw new Error(`Unsupported database type: ${options.type}`);
  }
  
  // Run migrations if requested
  if (options.runMigrations && options.migrations) {
    await runMigrations(db, options.migrations);
  }
  
  // Attach cleanup handler
  if (cleanupPath) {
    const originalDestroy = db.destroy.bind(db);
    db.destroy = async () => {
      await originalDestroy();
      if (cleanupPath) {
        rmSync(cleanupPath, { recursive: true, force: true });
      }
    };
  }
  
  return db;
}

/**
 * Reset test database (truncate all tables)
 */
export async function resetTestDatabase(db: Kysely<any>): Promise<void> {
  // Get all tables
  const tables = await db.introspection.getTables();
  
  // Truncate each table
  for (const table of tables) {
    await db.deleteFrom(table.name as any).execute();
  }
}

/**
 * Seed test data into database
 */
export async function seedTestData(
  db: Kysely<any>,
  data: Record<string, any[]>
): Promise<void> {
  for (const [table, rows] of Object.entries(data)) {
    if (rows.length === 0) continue;
    
    for (const row of rows) {
      await db.insertInto(table as any).values(row).execute();
    }
  }
}

/**
 * Run migrations on test database (not yet implemented)
 */
async function runMigrations(_db: Kysely<any>, migrationsPath: string): Promise<void> {
  // TODO: Implement migration runner integration
  // This would scan the migrations path and run pending migrations
  throw new Error(
    `Migration runner not yet implemented. ` +
    `Please run migrations manually or create tables directly in your tests. ` +
    `Attempted path: ${migrationsPath}`
  );
}
