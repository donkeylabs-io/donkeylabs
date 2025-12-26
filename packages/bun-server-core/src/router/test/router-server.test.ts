import { afterAll, describe, expect, it } from "bun:test";
import { z } from "zod";
import { SimpleCache } from "../../cache";
import { RouterDefinition } from "@donkeylabs/core/src/interfaces/server/router";
import { RouteDefinition } from "@donkeylabs/core";
import { MagikRouter } from "../index";
import { Server } from "../../server";
import { TestServerPort } from "../../test";

process.env.STAGE = process.env.STAGE || "test";

const cachePromise = SimpleCache.newSimpleInstance({ dbFile: undefined });

describe("Server and MagikRouter integration", () => {
  let server: Server<{ cache: SimpleCache }> | undefined;

  afterAll(async () => {
    if (server) {
      await server.shutdown();
    }
    const cache = await cachePromise;
    await cache.clear();
  });

  it("routes requests and enforces rate limits", async () => {
    const cache = await cachePromise;

    const testPermissions = { READ: "read" } as const;
    const routes = {
      echo: new RouteDefinition({
        path: "/echo",
        method: "post",
        requestSchema: z.object({ message: z.string() }),
        responseSchema: z.object({
          message: z.string(),
          permissions: z.array(z.string()),
        }),
        permissions: [testPermissions.READ],
        rateLimit: {
          window: "30s",
          maxAttempts: 1,
          keyStrategy: "ip",
        },
      }),
    };

    const routerDefinition = new RouterDefinition("test", testPermissions, routes);

    const dependencies = { cache };
    server = new Server(dependencies);

    server.registerRouter(() => {
      const router = new MagikRouter(routerDefinition, cache);
      router.handle("echo", async (input, context) => {
        const rateStatus = await context.rateLimiter.check(context.req);
        if (!rateStatus.allowed) {
          context.res.status(429).json({ blocked: true, resetTime: rateStatus.resetTime });
          return;
        }

        context.res.json({
          message: input.message,
          permissions: context.permissions,
        });
      });
      return router;
    });

    const port = TestServerPort.next();
    server.listen(port);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const baseUrl = `http://localhost:${port}`;

    const successResponse = await fetch(`${baseUrl}/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(successResponse.status).toBe(200);
    const payload = await successResponse.json();
    expect(payload).toEqual({
      message: "hello",
      permissions: ["test:read"],
    });

    const rateLimited = await fetch(`${baseUrl}/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "again" }),
    });
    expect(rateLimited.status).toBe(429);
    const ratePayload = await rateLimited.json();
    expect(ratePayload.blocked).toBeTrue();
    expect(typeof ratePayload.resetTime).toBe("number");

    await server.shutdown();
    server = undefined;
  });
});
