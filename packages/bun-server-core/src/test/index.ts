import { Kysely, Migrator } from "kysely";

import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database as Sqlite } from "bun:sqlite";
import { APIClient } from "@donkeylabs/core";
import type { Server } from "../server";
import { buildMigrator } from "../db";
import { syncPermissions } from "../db/scripts";

// export class TestAuthHelper {
//   static newOTPCode(secret: string): string {
//     return generateOTPCode(secret);
//   }

//   static newOTPSecret(): string {
//     return generateSecret();
//   }
// }

// export type AdminUser = {
//   id: number;
//   name: string;
//   username: string;
//   permissions: { id: number; name: string }[];
//   secret: string;
//   accessToken: string;
// };

export class TestServerPort {
  static port: number = 9000;

  static next(): number {
    return this.port++;
  }
}

export const newTestAPIClient = (port: number) => {
  return new APIClient(`http://localhost:${port}`);
};

export const newTestServer = async <DB>(server: Server<DB>) => {
  const port = TestServerPort.next();
  server.listen(port);
  const apiClient = newTestAPIClient(port);
  return { server, apiClient };
};

export const newTestDatabase = async (migrationDir: string) => {
  const db = new TestDatabase(migrationDir);
  await db.setup();
  return db;
};

export class TestDatabase<DB> {
  db: Kysely<DB>;
  private migrator: Migrator;

  async cleanup(server?: Server<DB>) {
    await this.db.destroy();
    if (server) {
      await server.shutdown();
    }
  }

  constructor(migrationDir: string) {
    process.env.ENCRYPTION_KEY = "ec8520590001759bcc1357df3702dc9ee8304c57f4e7bb6f29fadf127df6dc100";
    process.env.JWT_SECRET_KEY = "someTestSecretKey";
    this.db = new Kysely<DB>({
      // math random to avoid collisions
      dialect: new BunSqliteDialect({
        database: new Sqlite(":memory:"),
      }),
    });
    // @ts-ignore
    this.migrator = buildMigrator<DB>(this.db, migrationDir);
  }

  async setup() {
    await this.migrator.migrateToLatest();
    await syncPermissions(this.db, false);
  }
}
