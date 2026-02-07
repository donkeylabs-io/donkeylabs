import { describe, it, expect } from "bun:test";
import { createPlugin, PluginBuilder, ConfiguredPluginBuilder } from "../src/core";

describe("PluginBuilder", () => {
  it("should create a simple plugin via define()", () => {
    const plugin = createPlugin.define({
      name: "simple" as any,
      service: () => ({ hello: "world" }),
    });

    expect(plugin).toBeDefined();
    expect(plugin.name).toBe("simple");
    expect(typeof plugin.service).toBe("function");
  });

  it("should chain withSchema().define()", () => {
    const plugin = createPlugin
      .withSchema<{ users: { id: string; name: string } }>()
      .define({
        name: "with-schema" as any,
        service: () => ({ ok: true }),
      });

    expect(plugin).toBeDefined();
    expect(plugin.name).toBe("with-schema");
  });
});

describe("ConfiguredPluginBuilder", () => {
  it("should create a plugin factory with withConfig().define()", () => {
    const factory = createPlugin
      .withConfig<{ apiKey: string }>()
      .define({
        name: "configured" as any,
        service: (ctx) => {
          return { key: (ctx as any)._boundConfig?.apiKey ?? "none" };
        },
      });

    expect(typeof factory).toBe("function");

    const plugin = factory({ apiKey: "test-key" });
    expect(plugin.name).toBe("configured");
    expect((plugin as any)._boundConfig).toEqual({ apiKey: "test-key" });
  });

  it("should chain withConfig().withSchema().define()", () => {
    const factory = createPlugin
      .withConfig<{ maxItems: number }>()
      .withSchema<{ items: { id: string } }>()
      .define({
        name: "full-chain" as any,
        service: () => ({ items: [] }),
      });

    expect(typeof factory).toBe("function");
    const plugin = factory({ maxItems: 100 });
    expect(plugin.name).toBe("full-chain");
    expect((plugin as any)._boundConfig).toEqual({ maxItems: 100 });
  });

  it("should support events in the plugin definition", () => {
    const plugin = createPlugin.define({
      name: "with-events" as any,
      events: {
        "user.created": { schema: {} as any },
      },
      service: () => ({}),
    });

    expect(plugin.events).toBeDefined();
    expect(plugin.events!["user.created"]).toBeDefined();
  });

  it("should support init hook", () => {
    let initCalled = false;

    const plugin = createPlugin.define({
      name: "with-init" as any,
      service: () => ({ ready: true }),
      init: () => {
        initCalled = true;
      },
    });

    expect(plugin.init).toBeDefined();
    expect(typeof plugin.init).toBe("function");
  });

  it("should support middleware function", () => {
    const plugin = createPlugin.define({
      name: "with-middleware" as any,
      service: () => ({ authenticated: true }),
      middleware: (_ctx, _service) => ({
        authRequired: () => {},
      }),
    });

    expect(plugin.middleware).toBeDefined();
    expect(typeof plugin.middleware).toBe("function");
  });

  it("should support customErrors", () => {
    const plugin = createPlugin.define({
      name: "with-errors" as any,
      customErrors: {
        PaymentFailed: { status: 402, code: "PAYMENT_FAILED", message: "Payment failed" },
      },
      service: () => ({}),
    });

    expect(plugin.customErrors).toBeDefined();
    expect(plugin.customErrors!.PaymentFailed).toBeDefined();
  });
});
