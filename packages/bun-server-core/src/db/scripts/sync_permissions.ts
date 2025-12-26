import type { Kysely } from "kysely";
import type { RouterDefinition } from "@donkeylabs/core/src/interfaces/server/router";

type APIRouters = Record<string, RouterDefinition<string, any>>;

/**
 * Syncs permissions from route definitions to the database.
 * @param db - Kysely database instance
 * @param routers - API routers object (e.g., your API definition)
 * @param log - Whether to log progress
 */
export async function syncPermissions<T>(
  db: Kysely<T>,
  routers: APIRouters,
  log: boolean = false
) {
  try {
    const routerList = Object.values(routers);
    if (log) console.log(`Syncing permissions for ${routerList.length} routers`);
    const permissions = new Set<string>();

    // Collect all permissions in format "routerName:permission"
    for (const router of routerList) {
      const routerName = router.routeName.toLowerCase();
      if (log) {
        console.log(`Checking permissions for ${routerName}`);
      }
      Object.values(router.permissions).forEach((permission) => {
        permissions.add(`${routerName}:${permission}`);
      });
    }

    // Get existing permissions
    // @ts-ignore
    const existingPermissions = await db.selectFrom("permission").select("name").execute();

    // @ts-ignore
    const existingSet = new Set(existingPermissions.map((p) => p.name));
    const newPermissions = Array.from(permissions).filter((p) => !existingSet.has(p));

    if (newPermissions.length === 0) {
      if (log) console.log("\n No new permissions to sync");
      return;
    }

    // @ts-ignore
    const inserted = await db
      // @ts-ignore
      .insertInto("permission")
      // @ts-ignore
      .values(newPermissions.map((name) => ({ name })))
      // @ts-ignore
      .returning("name")
      // @ts-ignore
      .execute();

    if (log) console.log(`Added ${inserted.length} new permissions:`);
    // @ts-ignore
    if (log) console.log(inserted.map((p) => p.name).join("\n"));
  } catch (error) {
    if (log) console.error("Error syncing permissions:", error);
    process.exit(1);
  }
}
