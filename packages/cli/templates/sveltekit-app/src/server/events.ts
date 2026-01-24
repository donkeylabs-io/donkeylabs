import { z } from "zod";
import { defineEvents } from "@donkeylabs/server";

/**
 * Server-level events.
 * These events are typed and available across the app.
 * Use ctx.core.events.emit("event.name", data) to emit.
 * Use ctx.core.events.on("event.name", handler) to subscribe.
 */
export const events = defineEvents({
  "order.created": z.object({
    orderId: z.string(),
    userId: z.string(),
    total: z.number(),
  }),
  "order.shipped": z.object({
    orderId: z.string(),
    trackingNumber: z.string(),
    shippedAt: z.string(),
  }),
  "user.signup": z.object({
    userId: z.string(),
    email: z.string(),
  }),
  "user.verified": z.object({
    userId: z.string(),
  }),
});
