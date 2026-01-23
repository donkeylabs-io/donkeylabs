
import { describe, it, expect } from "bun:test";
import { AppServer } from "../src/server";
import { createRouter } from "../src/router";
import { z } from "zod";

describe("Client Generator - Output Type Handling", () => {
  it("should generate void type when output schema is missing", () => {
    const server = new AppServer({
      config: { env: "test" },
      db: {} as any,
    });

    const routes = [
      {
        name: "users.delete",
        prefix: "users",
        routeName: "delete",
        handler: "typed" as const,
        inputSource: "{ id: string }",
        outputSource: undefined, // No output schema
      },
    ];

    const code = (server as any).generateClientCode(routes);

    // Should generate void for missing output
    expect(code).toContain("export type Output = Expand<void>;");
    expect(code).toContain("Promise<Routes.Users.Delete.Output>");
  });

  it("should generate proper type when output schema is provided", () => {
    const server = new AppServer({
      config: { env: "test" },
      db: {} as any,
    });

    const routes = [
      {
        name: "users.get",
        prefix: "users",
        routeName: "get",
        handler: "typed" as const,
        inputSource: "{ id: string }",
        outputSource: "{ id: string; name: string; email: string }",
      },
    ];

    const code = (server as any).generateClientCode(routes);

    // Should generate the actual type
    expect(code).toContain("export type Output = Expand<{ id: string; name: string; email: string }>;");
  });

  it("should handle mixed routes with and without output schemas", () => {
    const server = new AppServer({
      config: { env: "test" },
      db: {} as any,
    });

    const routes = [
      {
        name: "users.list",
        prefix: "users",
        routeName: "list",
        handler: "typed" as const,
        inputSource: "{ page: number }",
        outputSource: "{ users: Array<{ id: string }> }",
      },
      {
        name: "users.delete",
        prefix: "users",
        routeName: "delete",
        handler: "typed" as const,
        inputSource: "{ id: string }",
        outputSource: undefined, // No output - should be void
      },
      {
        name: "users.create",
        prefix: "users",
        routeName: "create",
        handler: "typed" as const,
        inputSource: "{ name: string }",
        outputSource: "{ id: string; name: string }",
      },
    ];

    const code = (server as any).generateClientCode(routes);

    // List has output type
    expect(code).toContain("export namespace List {");
    expect(code).toContain("export type Output = Expand<{ users: Array<{ id: string }> }>;");

    // Delete has void
    expect(code).toContain("export namespace Delete {");
    expect(code).toMatch(/Delete[\s\S]*?export type Output = Expand<void>;/);

    // Create has output type
    expect(code).toContain("export namespace Create {");
    expect(code).toContain("export type Output = Expand<{ id: string; name: string }>;");
  });

  it("should use Record<string, never> for missing input schema", () => {
    const server = new AppServer({
      config: { env: "test" },
      db: {} as any,
    });

    const routes = [
      {
        name: "health.ping",
        prefix: "health",
        routeName: "ping",
        handler: "typed" as const,
        inputSource: undefined, // No input schema
        outputSource: "{ status: string }",
      },
    ];

    const code = (server as any).generateClientCode(routes);

    // Should use Record<string, never> for empty input
    expect(code).toContain("export type Input = Expand<Record<string, never>>;");
    expect(code).toContain("export type Output = Expand<{ status: string }>;");
  });

  it("should skip raw handlers in type generation", () => {
    const server = new AppServer({
      config: { env: "test" },
      db: {} as any,
    });

    const routes = [
      {
        name: "files.download",
        prefix: "files",
        routeName: "download",
        handler: "raw" as const, // Raw handler
        inputSource: undefined,
        outputSource: undefined,
      },
      {
        name: "files.list",
        prefix: "files",
        routeName: "list",
        handler: "typed" as const,
        inputSource: "{}",
        outputSource: "{ files: string[] }",
      },
    ];

    const code = (server as any).generateClientCode(routes);

    // Raw handler should not have Input/Output types
    expect(code).not.toContain("export namespace Download {");
    // But should have raw method
    expect(code).toContain("download: (init?: RequestInit): Promise<Response>");

    // Typed handler should have types
    expect(code).toContain("export namespace List {");
    expect(code).toContain("export type Output = Expand<{ files: string[] }>;");
  });

  it("should generate SSE handler methods with typed events", () => {
    const server = new AppServer({
      config: { env: "test" },
      db: {} as any,
    });

    const routes = [
      {
        name: "notifications.subscribe",
        prefix: "notifications",
        routeName: "subscribe",
        handler: "sse" as const,
        inputSource: "{ userId: string }",
        eventsSource: {
          "notification": "{ message: string; id: string }",
          "announcement": "{ title: string; urgent: boolean }",
        },
      },
    ];

    const code = (server as any).generateClientCode(routes);

    // SSE handler should have Input and Events types
    expect(code).toContain("export namespace Subscribe {");
    expect(code).toContain("export type Input = Expand<{ userId: string }>;");
    expect(code).toContain("export type Events = Expand<{");
    expect(code).toContain('"notification": { message: string; id: string };');
    expect(code).toContain('"announcement": { title: string; urgent: boolean };');

    // SSE handler should generate connectToSSERoute method
    expect(code).toContain("subscribe: (input: Routes.Notifications.Subscribe.Input");
    expect(code).toContain("SSESubscription<Routes.Notifications.Subscribe.Events>");
    expect(code).toContain('this.connectToSSERoute("notifications.subscribe", input, options)');

    // SSE imports should be included
    expect(code).toContain("type SSESubscription");
  });

  it("should generate SSE handler with empty events when no events defined", () => {
    const server = new AppServer({
      config: { env: "test" },
      db: {} as any,
    });

    const routes = [
      {
        name: "events.stream",
        prefix: "events",
        routeName: "stream",
        handler: "sse" as const,
        inputSource: "{ channel: string }",
        eventsSource: undefined, // No events defined
      },
    ];

    const code = (server as any).generateClientCode(routes);

    // Should still generate SSE method
    expect(code).toContain("export namespace Stream {");
    expect(code).toContain("export type Events = Expand<Record<string, unknown>>;");
    expect(code).toContain('this.connectToSSERoute("events.stream", input, options)');
  });
});

describe("Recursive Client Generator", () => {
  it("should generate deeply nested client structure", async () => {
    // Mock server with minimal dependencies
    const server = new AppServer({
        config: { env: "test" },
        db: {} as any // Mock DB
    });

    // Manually constructing the routes
    const routes = [
        {
            name: "api.v1.users.get",
            prefix: "api",
            routeName: "get",
            handler: "typed" as const,
            inputSource: "{ id: string }",
            outputSource: "{ name: string }"
        },
        {
            name: "health.ping",
            prefix: "health",
            routeName: "ping",
            handler: "typed" as const,
            inputSource: "{}",
            outputSource: "{}"
        }
    ];

    // Access private method
    const code = (server as any).generateClientCode(routes);
    
    // VERIFY TYPES
    // Check for nested structure by parts
    expect(code).toContain("export namespace Routes");
    expect(code).toContain("export namespace Api");
    expect(code).toContain("export namespace V1");
    expect(code).toContain("export namespace Users"); 
    expect(code).toContain("export namespace Get");
    expect(code).toContain("export type Input = Expand<{ id: string }>");

    // VERIFY CLIENT METHODS
    // Correct nesting syntax (colon for nested properties)
    // api = { v1: { users: { get: ... } } }
    expect(code).toContain("api = {");
    expect(code).toContain("v1: {");
    expect(code).toContain("users: {");
    expect(code).toContain('get: (input: Routes.Api.V1.Users.Get.Input): Promise<Routes.Api.V1.Users.Get.Output> => this.request("api.v1.users.get", input)');
    expect(code).toContain('get: (input: Routes.Api.V1.Users.Get.Input): Promise<Routes.Api.V1.Users.Get.Output> => this.request("api.v1.users.get", input)');
    
    // Verify health ping (sibling root)
    expect(code).toContain("health = {");
    expect(code).toContain('ping: (input: Routes.Health.Ping.Input): Promise<Routes.Health.Ping.Output> => this.request("health.ping", input)');
    
    // Verify NO flattening of "api" prefix even if present
    // expect(code).not.toContain("this.request(\"v1.users.get\""); 
    // Wait, request path should be FULL path "api.v1.users.get".
    // My expectation above checks that.
  });
});
