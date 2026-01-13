import { createPlugin } from "../../core";
import type { DB as CounterSchema } from "./schema";

export interface CounterService {
  increment(name: string): Promise<number>;
  decrement(name: string): Promise<number>;
  get(name: string): Promise<number>;
  getAll(): Promise<{ name: string; value: number }[]>;
}

export const counterPlugin = createPlugin
  .withSchema<CounterSchema>()
  .define({
    name: "counter",
    version: "1.0.0",

    service: async (ctx): Promise<CounterService> => {
      console.log("[CounterPlugin] Initializing...");

      return {
        async increment(name: string): Promise<number> {
          // Try to get existing counter
          const existing = await ctx.db
            .selectFrom("counters")
            .select(["id", "value"])
            .where("name", "=", name)
            .executeTakeFirst();

          if (existing) {
            const newValue = (existing.value ?? 0) + 1;
            await ctx.db
              .updateTable("counters")
              .set({ value: newValue })
              .where("id", "=", existing.id)
              .execute();
            return newValue;
          } else {
            await ctx.db
              .insertInto("counters")
              .values({ name, value: 1 })
              .execute();
            return 1;
          }
        },

        async decrement(name: string): Promise<number> {
          const existing = await ctx.db
            .selectFrom("counters")
            .select(["id", "value"])
            .where("name", "=", name)
            .executeTakeFirst();

          if (existing) {
            const newValue = Math.max(0, (existing.value ?? 0) - 1);
            await ctx.db
              .updateTable("counters")
              .set({ value: newValue })
              .where("id", "=", existing.id)
              .execute();
            return newValue;
          }
          return 0;
        },

        async get(name: string): Promise<number> {
          const counter = await ctx.db
            .selectFrom("counters")
            .select("value")
            .where("name", "=", name)
            .executeTakeFirst();
          return counter?.value ?? 0;
        },

        async getAll(): Promise<{ name: string; value: number }[]> {
          const counters = await ctx.db
            .selectFrom("counters")
            .select(["name", "value"])
            .execute();
          return counters.map(c => ({
            name: c.name,
            value: c.value ?? 0
          }));
        }
      };
    }
  });
