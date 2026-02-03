import { createRouter, defineRoute } from "@donkeylabs/server";
import { z } from "zod";

export const apiRouter = createRouter("api", {
  // Plugins are available via ctx.plugins
});

// Health check - GET /api.health
apiRouter.route("health").typed(defineRoute({
  output: z.object({
    status: z.string(),
    timestamp: z.string(),
    uptime: z.number(),
  }),
  handle: async () => ({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }),
}));

// Users routes - requires users plugin
apiRouter.route("users.list").typed(defineRoute({
  output: z.array(z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
  })),
  handle: async (_, ctx) => {
    return ctx.plugins.users.list();
  },
}));
