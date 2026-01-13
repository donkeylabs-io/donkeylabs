import { db } from "./db";
import { AppServer } from "@donkeylabs/server";
import { healthRouter } from "./routes/health";
import { statsPlugin } from "./plugins/stats";
import { z } from "zod";

const server = new AppServer({
  port: Number(process.env.PORT) || 3000,
  db,
  config: { env: process.env.NODE_ENV || "development" },
});

// Register plugins
server.registerPlugin(statsPlugin);

// Register routes with middleware applied at router level

const api = server.router("api")
.middleware
.timing()

const hello = api.router("hello")
hello.route("test").typed({
  input: z.string(),
  output: z.string(),
  handle: (input, ctx) => {
    // ctx.plugins.stats should now be typed correctly
    const stats = ctx.plugins.stats;
    return input;
  }
}).route("ping").typed({
  input: z.string(),
  output: z.string(),
  handle: (input, ctx) => {
    return input;
  }
})
.route("pong").typed({
  input: z.string(),
  output: z.string(),
  handle: (input, ctx) => {
    return input;
  }
})

api.router(healthRouter)

await server.start();
