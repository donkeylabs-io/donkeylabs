import { createPlugin } from "../../core";
import type { DB as StatsSchema } from "./schema";

export interface StatsService {
  takeSnapshot(counterName: string): Promise<number>;
  getSnapshots(counterName: string): Promise<{ value: number; createdAt: string }[]>;
  getTotalIncrements(counterName: string): Promise<number>;
  summary(): Promise<{ totalCounters: number; totalSnapshots: number }>;
}

export const statsPlugin = createPlugin
  .withSchema<StatsSchema>()
  .define({
    name: "stats",
    version: "1.0.0",
    dependencies: ["counter"] as const,

    service: async (ctx): Promise<StatsService> => {
      console.log("[StatsPlugin] Initializing...");

      // Access counter service from dependencies
      const counterService = ctx.deps.counter;

      return {
        async takeSnapshot(counterName: string): Promise<number> {
          // Get current value from counter service
          const currentValue = await counterService.get(counterName);

          // Store snapshot in our own table
          await ctx.db
            .insertInto("snapshots")
            .values({
              counter_name: counterName,
              value_at_snapshot: currentValue
            })
            .execute();

          return currentValue;
        },

        async getSnapshots(counterName: string): Promise<{ value: number; createdAt: string }[]> {
          const snapshots = await ctx.db
            .selectFrom("snapshots")
            .select(["value_at_snapshot", "created_at"])
            .where("counter_name", "=", counterName)
            .orderBy("created_at", "desc")
            .execute();

          return snapshots.map(s => ({
            value: s.value_at_snapshot as number,
            createdAt: s.created_at as string
          }));
        },

        async getTotalIncrements(counterName: string): Promise<number> {
          // Uses counter service to get current value
          return counterService.get(counterName);
        },

        async summary(): Promise<{ totalCounters: number; totalSnapshots: number }> {
          // Get all counters from counter service
          const allCounters = await counterService.getAll();

          // Count snapshots from our table
          const snapshotCount = await ctx.db
            .selectFrom("snapshots")
            .select(ctx.db.fn.count("id").as("count"))
            .executeTakeFirst();

          return {
            totalCounters: allCounters.length,
            totalSnapshots: Number(snapshotCount?.count ?? 0)
          };
        }
      };
    }
  });
