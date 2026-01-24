import { describe, it, expect, beforeEach } from "bun:test";
import { createEvents, type Events } from "../src/core/events";
import { defineEvents } from "../src/core";
import { z } from "zod";

// ==========================================
// defineEvents() Helper Tests
// ==========================================
describe("defineEvents Helper", () => {
  it("should return the same object passed to it", () => {
    const eventSchemas = {
      "user.created": z.object({ userId: z.string() }),
      "user.deleted": z.object({ userId: z.string() }),
    };

    const result = defineEvents(eventSchemas);

    expect(result).toBe(eventSchemas);
  });

  it("should preserve Zod schema types", () => {
    const events = defineEvents({
      "order.created": z.object({
        orderId: z.string(),
        total: z.number(),
      }),
    });

    // Validate schema works
    const validData = { orderId: "123", total: 99.99 };
    const result = events["order.created"].safeParse(validData);
    expect(result.success).toBe(true);

    // Invalid data should fail
    const invalidData = { orderId: 123, total: "invalid" };
    const invalidResult = events["order.created"].safeParse(invalidData);
    expect(invalidResult.success).toBe(false);
  });

  it("should work with complex nested schemas", () => {
    const events = defineEvents({
      "order.shipped": z.object({
        orderId: z.string(),
        shipment: z.object({
          carrier: z.string(),
          trackingNumber: z.string(),
          estimatedDelivery: z.string().optional(),
        }),
        items: z.array(z.object({
          sku: z.string(),
          quantity: z.number(),
        })),
      }),
    });

    const validData = {
      orderId: "order-123",
      shipment: {
        carrier: "UPS",
        trackingNumber: "1Z999AA10123456784",
      },
      items: [
        { sku: "ITEM-001", quantity: 2 },
        { sku: "ITEM-002", quantity: 1 },
      ],
    };

    const result = events["order.shipped"].safeParse(validData);
    expect(result.success).toBe(true);
  });

  it("should support multiple event definitions", () => {
    const events = defineEvents({
      "user.signup": z.object({ email: z.string().email() }),
      "user.verified": z.object({ userId: z.string() }),
      "user.deleted": z.object({ userId: z.string(), reason: z.string().optional() }),
      "order.created": z.object({ orderId: z.string() }),
      "order.cancelled": z.object({ orderId: z.string(), reason: z.string() }),
    });

    expect(Object.keys(events)).toHaveLength(5);
    expect(events["user.signup"]).toBeDefined();
    expect(events["order.cancelled"]).toBeDefined();
  });
});

// ==========================================
// Typed Events Service Tests
// ==========================================
describe("Typed Events Service", () => {
  let events: Events;

  beforeEach(() => {
    events = createEvents();
  });

  it("should emit and receive typed events", async () => {
    const received: { orderId: string; total: number }[] = [];

    events.on("order.created", (data: { orderId: string; total: number }) => {
      received.push(data);
    });

    await events.emit("order.created", { orderId: "123", total: 99.99 });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ orderId: "123", total: 99.99 });
  });

  it("should handle multiple typed event subscriptions", async () => {
    const orderEvents: any[] = [];
    const userEvents: any[] = [];

    events.on("order.created", (data) => orderEvents.push(data));
    events.on("user.signup", (data) => userEvents.push(data));

    await events.emit("order.created", { orderId: "1", total: 50 });
    await events.emit("user.signup", { userId: "u1", email: "test@test.com" });
    await events.emit("order.created", { orderId: "2", total: 100 });

    expect(orderEvents).toHaveLength(2);
    expect(userEvents).toHaveLength(1);
  });

  it("should support once() with typed events", async () => {
    const received: any[] = [];

    events.once("user.verified", (data: { userId: string }) => {
      received.push(data);
    });

    await events.emit("user.verified", { userId: "u1" });
    await events.emit("user.verified", { userId: "u2" });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ userId: "u1" });
  });

  it("should support unsubscribing from typed events", async () => {
    const received: any[] = [];

    const subscription = events.on("order.shipped", (data) => {
      received.push(data);
    });

    await events.emit("order.shipped", { orderId: "1", trackingNumber: "ABC" });
    subscription.unsubscribe();
    await events.emit("order.shipped", { orderId: "2", trackingNumber: "DEF" });

    expect(received).toHaveLength(1);
  });

  it("should still support pattern matching with wildcards", async () => {
    const received: any[] = [];

    events.on("order.*", (data) => {
      received.push(data);
    });

    await events.emit("order.created", { orderId: "1" });
    await events.emit("order.shipped", { orderId: "1" });
    await events.emit("order.delivered", { orderId: "1" });
    await events.emit("user.signup", { userId: "1" }); // Should not match

    expect(received).toHaveLength(3);
  });

  it("should maintain event history for typed events", async () => {
    await events.emit("order.created", { orderId: "1", total: 10 });
    await events.emit("order.created", { orderId: "2", total: 20 });
    await events.emit("order.created", { orderId: "3", total: 30 });

    const history = await events.getHistory("order.created");

    expect(history).toHaveLength(3);
    expect(history[0].data).toEqual({ orderId: "1", total: 10 });
    expect(history[2].data).toEqual({ orderId: "3", total: 30 });
  });

  it("should handle async handlers correctly", async () => {
    const results: string[] = [];

    events.on("async.event", async (data: { id: string }) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      results.push(data.id);
    });

    await events.emit("async.event", { id: "first" });
    await events.emit("async.event", { id: "second" });

    expect(results).toEqual(["first", "second"]);
  });

  it("should not block on handler errors", async () => {
    const results: string[] = [];

    events.on("error.event", () => {
      throw new Error("Handler error");
    });

    events.on("error.event", (data: { id: string }) => {
      results.push(data.id);
    });

    // Should not throw
    await events.emit("error.event", { id: "test" });

    // Second handler should still receive event
    expect(results).toEqual(["test"]);
  });
});
