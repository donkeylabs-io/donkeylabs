
import { createRouter } from "@donkeylabs/server";
import { z } from "zod";
import { PingHandler } from "./handlers/ping";

export const healthRouter = createRouter("health")
  .route("ping").typed({
    input: z.object({
      name: z.string(),
      cool: z.number(),
      echo: z.string().optional(),
    }),
    output: z.object({
      status: z.literal("ok"),
      timestamp: z.string(),
      echo: z.string().optional(),
    }),
    handle: PingHandler,
  });
