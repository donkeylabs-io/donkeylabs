import { describe, it, expect, afterAll } from "bun:test";
import { z } from "zod";
import { createRouter, AppServer } from "../src";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";

describe("versioned routing", () => {
  let server: AppServer;
  let port: number;

  // Create a unique port for this test
  const testPort = 10000 + Math.floor(Math.random() * 50000);

  afterAll(async () => {
    if (server) await server.shutdown();
  });

  it("routes to correct version based on X-API-Version header", async () => {
    const db = new Kysely<any>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
    });

    const v1 = createRouter("api", { version: "1.0.0" });
    v1.route("greet").typed({
      input: z.object({ name: z.string() }),
      output: z.object({ message: z.string() }),
      handle: (input) => ({ message: `Hello ${input.name} (v1)` }),
    });

    const v2 = createRouter("api", { version: "2.0.0" });
    v2.route("greet").typed({
      input: z.object({ name: z.string() }),
      output: z.object({ message: z.string(), greeting: z.string() }),
      handle: (input) => ({
        message: `Hi ${input.name} (v2)`,
        greeting: "modern",
      }),
    });

    server = new AppServer({
      db,
      port: testPort,
      maxPortAttempts: 10,
      logger: { level: "error" },
    });
    server.use(v1).use(v2);

    await server.start();
    port = (server as any).port;

    // Request with v1
    const res1 = await fetch(`http://localhost:${port}/api.greet`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Version": "1",
      },
      body: JSON.stringify({ name: "World" }),
    });
    expect(res1.ok).toBe(true);
    const data1 = await res1.json() as any;
    expect(data1.message).toBe("Hello World (v1)");
    expect(res1.headers.get("X-API-Version")).toBe("1.0.0");

    // Request with v2
    const res2 = await fetch(`http://localhost:${port}/api.greet`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Version": "2",
      },
      body: JSON.stringify({ name: "World" }),
    });
    expect(res2.ok).toBe(true);
    const data2 = await res2.json() as any;
    expect(data2.message).toBe("Hi World (v2)");
    expect(data2.greeting).toBe("modern");
    expect(res2.headers.get("X-API-Version")).toBe("2.0.0");
  });

  it("defaults to latest version when no header is sent", async () => {
    // Reuse the server from above
    const res = await fetch(`http://localhost:${port}/api.greet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "World" }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    // Should get v2 (latest)
    expect(data.message).toBe("Hi World (v2)");
    expect(res.headers.get("X-API-Version")).toBe("2.0.0");
  });

  it("resolves minor version requests", async () => {
    const res = await fetch(`http://localhost:${port}/api.greet`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Version": "1.0",
      },
      body: JSON.stringify({ name: "World" }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.message).toBe("Hello World (v1)");
  });
});

describe("versioned routing - deprecation headers", () => {
  let server: AppServer;
  let port: number;

  afterAll(async () => {
    if (server) await server.shutdown();
  });

  it("includes deprecation headers for deprecated versions", async () => {
    const db = new Kysely<any>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
    });

    const v1 = createRouter("api", {
      version: "1.0.0",
      deprecated: {
        sunsetDate: "2025-12-31",
        message: "Use v2 instead",
        successor: "2.0.0",
      },
    });
    v1.route("status").typed({
      output: z.object({ ok: z.boolean() }),
      handle: () => ({ ok: true }),
    });

    const v2 = createRouter("api", { version: "2.0.0" });
    v2.route("status").typed({
      output: z.object({ ok: z.boolean() }),
      handle: () => ({ ok: true }),
    });

    const testPort2 = 10000 + Math.floor(Math.random() * 50000);
    server = new AppServer({
      db,
      port: testPort2,
      maxPortAttempts: 10,
      logger: { level: "error" },
    });
    server.use(v1).use(v2);
    await server.start();
    port = (server as any).port;

    // Request deprecated v1
    const res = await fetch(`http://localhost:${port}/api.status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Version": "1",
      },
      body: JSON.stringify({}),
    });
    expect(res.ok).toBe(true);
    expect(res.headers.get("Deprecation")).toBe("true");
    expect(res.headers.get("Sunset")).toBe("2025-12-31");
    expect(res.headers.get("X-Deprecation-Notice")).toBe("Use v2 instead");

    // Request non-deprecated v2
    const res2 = await fetch(`http://localhost:${port}/api.status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Version": "2",
      },
      body: JSON.stringify({}),
    });
    expect(res2.ok).toBe(true);
    expect(res2.headers.get("Deprecation")).toBeNull();
    expect(res2.headers.get("Sunset")).toBeNull();
  });
});

describe("versioned routing - backward compatibility", () => {
  let server: AppServer;

  afterAll(async () => {
    if (server) await server.shutdown();
  });

  it("unversioned routers work exactly as before", async () => {
    const db = new Kysely<any>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
    });

    const api = createRouter("api");
    api.route("ping").typed({
      output: z.object({ pong: z.boolean() }),
      handle: () => ({ pong: true }),
    });

    const testPort3 = 10000 + Math.floor(Math.random() * 50000);
    server = new AppServer({
      db,
      port: testPort3,
      maxPortAttempts: 10,
      logger: { level: "error" },
    });
    server.use(api);
    await server.start();
    const port = (server as any).port;

    const res = await fetch(`http://localhost:${port}/api.ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.pong).toBe(true);
    // No version header on unversioned routes
    expect(res.headers.get("X-API-Version")).toBeNull();
  });
});

describe("versioned routing - callRoute", () => {
  let server: AppServer;

  afterAll(async () => {
    if (server) await server.shutdown();
  });

  it("callRoute resolves correct version", async () => {
    const db = new Kysely<any>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
    });

    const v1 = createRouter("api", { version: "1.0.0" });
    v1.route("echo").typed({
      input: z.object({ text: z.string() }),
      output: z.object({ text: z.string(), version: z.number() }),
      handle: (input) => ({ text: input.text, version: 1 }),
    });

    const v2 = createRouter("api", { version: "2.0.0" });
    v2.route("echo").typed({
      input: z.object({ text: z.string() }),
      output: z.object({ text: z.string(), version: z.number() }),
      handle: (input) => ({ text: input.text, version: 2 }),
    });

    server = new AppServer({
      db,
      port: 10000 + Math.floor(Math.random() * 50000),
      maxPortAttempts: 10,
      logger: { level: "error" },
    });
    server.use(v1).use(v2);

    // Initialize without starting HTTP server (adapter mode)
    await server.initialize();

    // Call v1
    const r1 = await server.callRoute("api.echo", { text: "hello" }, "127.0.0.1", { version: "1" });
    expect(r1).toEqual({ text: "hello", version: 1 });

    // Call v2
    const r2 = await server.callRoute("api.echo", { text: "hello" }, "127.0.0.1", { version: "2" });
    expect(r2).toEqual({ text: "hello", version: 2 });

    // No version → latest (v2)
    const r3 = await server.callRoute("api.echo", { text: "hello" });
    expect(r3).toEqual({ text: "hello", version: 2 });
  });
});
