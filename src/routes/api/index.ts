import { createRouter } from "@donkeylabs/server";
import { z } from "zod";

export const apiRouter = createRouter("api")
  .route("users")
  .typed({
    output: z.object({
      users: z.array(z.unknown()),
    }),
    handle: async () => {
      return { users: [] };
    },
  })
  .route("health")
  .typed({
    output: z.object({
      status: z.literal("ok"),
    }),
    handle: async () => {
      return { status: "ok" as const };
    },
  });
