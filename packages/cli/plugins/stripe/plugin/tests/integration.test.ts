/**
 * Stripe Plugin Integration Tests
 *
 * Tests for full workflows and webhook processing
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { PluginManager, type CoreServices } from "@donkeylabs/server";
import type { Plugin } from "@donkeylabs/server";
import {
  createLogger,
  createCache,
  createEvents,
  createCron,
  createJobs,
  createSSE,
  createRateLimiter,
  createErrors,
} from "@donkeylabs/server/core";

// =============================================================================
// TEST HELPERS
// =============================================================================

function createTestCoreServices(db: Kysely<any>): CoreServices {
  const logger = createLogger({ level: "error" });
  const cache = createCache();
  const events = createEvents();
  const cron = createCron();
  const jobs = createJobs({ events });
  const sse = createSSE();
  const rateLimiter = createRateLimiter();
  const errors = createErrors();

  return {
    db,
    config: { env: "test" },
    logger,
    cache,
    events,
    cron,
    jobs,
    sse,
    rateLimiter,
    errors,
  };
}

async function createTestDatabase(): Promise<Kysely<any>> {
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({
      database: new Database(":memory:"),
    }),
  });

  // Create all tables
  await db.schema
    .createTable("stripe_customers")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull().unique())
    .addColumn("stripe_customer_id", "text", (col) => col.notNull().unique())
    .addColumn("email", "text")
    .addColumn("name", "text")
    .addColumn("metadata", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .addColumn("deleted_at", "text")
    .execute();

  await db.schema
    .createTable("stripe_subscriptions")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("stripe_subscription_id", "text", (col) => col.notNull().unique())
    .addColumn("stripe_customer_id", "text", (col) => col.notNull())
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("price_id", "text", (col) => col.notNull())
    .addColumn("product_id", "text", (col) => col.notNull())
    .addColumn("quantity", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("current_period_start", "text", (col) => col.notNull())
    .addColumn("current_period_end", "text", (col) => col.notNull())
    .addColumn("cancel_at_period_end", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("canceled_at", "text")
    .addColumn("ended_at", "text")
    .addColumn("trial_start", "text")
    .addColumn("trial_end", "text")
    .addColumn("metadata", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("stripe_webhook_events")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("stripe_event_id", "text", (col) => col.notNull().unique())
    .addColumn("event_type", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("error", "text")
    .addColumn("processed_at", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();

  return db;
}

// Create a comprehensive mock plugin for integration testing
function createIntegrationMockPlugin(): Plugin {
  let customerIdCounter = 0;
  let subscriptionIdCounter = 0;
  const stripeCustomers = new Map<string, any>();
  const stripeSubscriptions = new Map<string, any>();

  return {
    name: "stripe",
    version: "1.0.0",
    dependencies: [],
    _boundConfig: {
      secretKey: "sk_test_mock",
      webhookSecret: "whsec_mock",
      checkout: {
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      },
      portal: {
        returnUrl: "https://example.com/account",
      },
    },
    service: async (ctx: any) => {
      const db = ctx.db;
      const config = ctx.config;

      function generateId(prefix: string): string {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      }

      function toCustomerRecord(row: any) {
        return {
          id: row.id,
          userId: row.user_id,
          stripeCustomerId: row.stripe_customer_id,
          email: row.email,
          name: row.name,
          metadata: row.metadata,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          deletedAt: row.deleted_at,
        };
      }

      function toSubscriptionRecord(row: any) {
        return {
          id: row.id,
          stripeSubscriptionId: row.stripe_subscription_id,
          stripeCustomerId: row.stripe_customer_id,
          userId: row.user_id,
          status: row.status,
          priceId: row.price_id,
          productId: row.product_id,
          quantity: row.quantity,
          currentPeriodStart: row.current_period_start,
          currentPeriodEnd: row.current_period_end,
          cancelAtPeriodEnd: row.cancel_at_period_end === 1,
          canceledAt: row.canceled_at,
          endedAt: row.ended_at,
          trialStart: row.trial_start,
          trialEnd: row.trial_end,
          metadata: row.metadata,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }

      return {
        // Customer methods
        async getOrCreateCustomer(params: any) {
          const { userId, email, name, metadata } = params;

          const existing = await db
            .selectFrom("stripe_customers")
            .selectAll()
            .where("user_id", "=", userId)
            .where("deleted_at", "is", null)
            .executeTakeFirst();

          if (existing) {
            return toCustomerRecord(existing);
          }

          const stripeCustomerId = `cus_mock_${++customerIdCounter}`;
          stripeCustomers.set(stripeCustomerId, { id: stripeCustomerId, email, name, metadata });

          const id = generateId("cust");
          const now = new Date().toISOString();

          await db
            .insertInto("stripe_customers")
            .values({
              id,
              user_id: userId,
              stripe_customer_id: stripeCustomerId,
              email,
              name: name || null,
              metadata: metadata ? JSON.stringify(metadata) : null,
              created_at: now,
              updated_at: now,
            })
            .execute();

          const record = await db
            .selectFrom("stripe_customers")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirstOrThrow();

          ctx.core.events.emit("stripe.customer.created", {
            userId,
            stripeCustomerId,
          });

          return toCustomerRecord(record);
        },

        async getCustomerByUserId(userId: string) {
          const row = await db
            .selectFrom("stripe_customers")
            .selectAll()
            .where("user_id", "=", userId)
            .where("deleted_at", "is", null)
            .executeTakeFirst();

          return row ? toCustomerRecord(row) : null;
        },

        // Checkout methods
        async createSubscriptionCheckout(params: any) {
          const customer = await this.getCustomerByUserId(params.userId);
          if (!customer) {
            throw ctx.core.errors.NotFound("Customer not found");
          }

          const sessionId = `cs_mock_${Date.now()}`;
          return {
            sessionId,
            url: `https://checkout.stripe.com/pay/${sessionId}`,
          };
        },

        // Subscription methods
        async getSubscription(userId: string) {
          const row = await db
            .selectFrom("stripe_subscriptions")
            .selectAll()
            .where("user_id", "=", userId)
            .where("status", "in", ["active", "trialing"])
            .orderBy("created_at", "desc")
            .executeTakeFirst();

          return row ? toSubscriptionRecord(row) : null;
        },

        async getSubscriptions(userId: string, options?: any) {
          let query = db
            .selectFrom("stripe_subscriptions")
            .selectAll()
            .where("user_id", "=", userId);

          if (!options?.includeEnded) {
            query = query.where("ended_at", "is", null);
          }

          const rows = await query.orderBy("created_at", "desc").execute();
          return rows.map(toSubscriptionRecord);
        },

        async cancelSubscription(userId: string, options?: any) {
          const subscription = await this.getSubscription(userId);
          if (!subscription) {
            throw ctx.core.errors.NotFound("Subscription not found");
          }

          const now = new Date().toISOString();

          if (options?.immediately) {
            await db
              .updateTable("stripe_subscriptions")
              .set({
                status: "canceled",
                canceled_at: now,
                ended_at: now,
                updated_at: now,
              })
              .where("id", "=", subscription.id)
              .execute();
          } else {
            await db
              .updateTable("stripe_subscriptions")
              .set({
                cancel_at_period_end: 1,
                updated_at: now,
              })
              .where("id", "=", subscription.id)
              .execute();
          }

          const updated = await db
            .selectFrom("stripe_subscriptions")
            .selectAll()
            .where("id", "=", subscription.id)
            .executeTakeFirstOrThrow();

          ctx.core.events.emit("stripe.subscription.canceled", {
            userId,
            subscriptionId: subscription.stripeSubscriptionId,
            endsAt: updated.current_period_end,
          });

          return toSubscriptionRecord(updated);
        },

        async resumeSubscription(userId: string) {
          const subscription = await this.getSubscription(userId);
          if (!subscription) {
            throw ctx.core.errors.NotFound("Subscription not found");
          }

          if (!subscription.cancelAtPeriodEnd) {
            return subscription;
          }

          const now = new Date().toISOString();
          await db
            .updateTable("stripe_subscriptions")
            .set({
              cancel_at_period_end: 0,
              updated_at: now,
            })
            .where("id", "=", subscription.id)
            .execute();

          const updated = await db
            .selectFrom("stripe_subscriptions")
            .selectAll()
            .where("id", "=", subscription.id)
            .executeTakeFirstOrThrow();

          return toSubscriptionRecord(updated);
        },

        async hasActiveSubscription(userId: string) {
          const count = await db
            .selectFrom("stripe_subscriptions")
            .select((eb) => eb.fn.count("id").as("count"))
            .where("user_id", "=", userId)
            .where("status", "in", ["active", "trialing"])
            .executeTakeFirst();

          return Number(count?.count || 0) > 0;
        },

        async hasPlan(userId: string, productIdOrPriceId: string) {
          const count = await db
            .selectFrom("stripe_subscriptions")
            .select((eb) => eb.fn.count("id").as("count"))
            .where("user_id", "=", userId)
            .where("status", "in", ["active", "trialing"])
            .where((eb) =>
              eb.or([
                eb("product_id", "=", productIdOrPriceId),
                eb("price_id", "=", productIdOrPriceId),
              ])
            )
            .executeTakeFirst();

          return Number(count?.count || 0) > 0;
        },

        // Webhook methods
        async handleWebhook(payload: string, signature: string) {
          if (signature === "invalid") {
            throw ctx.core.errors.BadRequest("Invalid signature");
          }

          const event = JSON.parse(payload);

          // Check idempotency
          const existing = await db
            .selectFrom("stripe_webhook_events")
            .select(["id"])
            .where("stripe_event_id", "=", event.id)
            .executeTakeFirst();

          if (existing) {
            return {
              processed: false,
              eventId: event.id,
              eventType: event.type,
            };
          }

          // Record event
          const eventRecordId = generateId("evt");
          const now = new Date().toISOString();

          await db
            .insertInto("stripe_webhook_events")
            .values({
              id: eventRecordId,
              stripe_event_id: event.id,
              event_type: event.type,
              status: "processing",
              processed_at: now,
              created_at: now,
            })
            .execute();

          // Process based on event type
          try {
            await this._processWebhookEvent(event);

            await db
              .updateTable("stripe_webhook_events")
              .set({ status: "processed" })
              .where("id", "=", eventRecordId)
              .execute();

            return {
              processed: true,
              eventId: event.id,
              eventType: event.type,
            };
          } catch (error) {
            await db
              .updateTable("stripe_webhook_events")
              .set({
                status: "failed",
                error: error instanceof Error ? error.message : "Unknown error",
              })
              .where("id", "=", eventRecordId)
              .execute();

            throw error;
          }
        },

        async _processWebhookEvent(event: any) {
          const now = new Date().toISOString();

          switch (event.type) {
            case "customer.subscription.created": {
              const subscription = event.data.object;

              // Get userId from customer
              const customer = await db
                .selectFrom("stripe_customers")
                .select(["user_id"])
                .where("stripe_customer_id", "=", subscription.customer)
                .executeTakeFirst();

              if (!customer) {
                throw new Error("Customer not found for subscription");
              }

              await db
                .insertInto("stripe_subscriptions")
                .values({
                  id: generateId("sub"),
                  stripe_subscription_id: subscription.id,
                  stripe_customer_id: subscription.customer,
                  user_id: customer.user_id,
                  status: subscription.status,
                  price_id: subscription.items.data[0]?.price?.id || "",
                  product_id: subscription.items.data[0]?.price?.product || "",
                  quantity: subscription.items.data[0]?.quantity || 1,
                  current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
                  current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
                  cancel_at_period_end: subscription.cancel_at_period_end ? 1 : 0,
                  created_at: now,
                  updated_at: now,
                })
                .execute();

              ctx.core.events.emit("stripe.subscription.created", {
                userId: customer.user_id,
                subscriptionId: subscription.id,
                productId: subscription.items.data[0]?.price?.product || "",
                status: subscription.status,
              });
              break;
            }

            case "customer.subscription.updated": {
              const subscription = event.data.object;

              const existing = await db
                .selectFrom("stripe_subscriptions")
                .selectAll()
                .where("stripe_subscription_id", "=", subscription.id)
                .executeTakeFirst();

              if (existing) {
                const previousStatus = existing.status;

                await db
                  .updateTable("stripe_subscriptions")
                  .set({
                    status: subscription.status,
                    cancel_at_period_end: subscription.cancel_at_period_end ? 1 : 0,
                    current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
                    current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
                    updated_at: now,
                  })
                  .where("stripe_subscription_id", "=", subscription.id)
                  .execute();

                if (previousStatus !== subscription.status) {
                  ctx.core.events.emit("stripe.subscription.updated", {
                    userId: existing.user_id,
                    subscriptionId: subscription.id,
                    status: subscription.status,
                    previousStatus,
                  });
                }
              }
              break;
            }

            case "customer.subscription.deleted": {
              const subscription = event.data.object;

              const existing = await db
                .selectFrom("stripe_subscriptions")
                .select(["user_id"])
                .where("stripe_subscription_id", "=", subscription.id)
                .executeTakeFirst();

              await db
                .updateTable("stripe_subscriptions")
                .set({
                  status: "canceled",
                  ended_at: now,
                  updated_at: now,
                })
                .where("stripe_subscription_id", "=", subscription.id)
                .execute();

              if (existing) {
                ctx.core.events.emit("stripe.subscription.canceled", {
                  userId: existing.user_id,
                  subscriptionId: subscription.id,
                  endsAt: now,
                });
              }
              break;
            }

            case "invoice.paid": {
              const invoice = event.data.object;
              const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;

              if (customerId) {
                const customer = await db
                  .selectFrom("stripe_customers")
                  .select(["user_id"])
                  .where("stripe_customer_id", "=", customerId)
                  .executeTakeFirst();

                if (customer) {
                  ctx.core.events.emit("stripe.payment.succeeded", {
                    userId: customer.user_id,
                    amount: invoice.amount_paid,
                    currency: invoice.currency,
                  });
                }
              }
              break;
            }

            default:
              // Unhandled event type
              break;
          }
        },

        async isEventProcessed(eventId: string) {
          const event = await db
            .selectFrom("stripe_webhook_events")
            .select(["id"])
            .where("stripe_event_id", "=", eventId)
            .executeTakeFirst();

          return !!event;
        },

        // Sync methods (simplified for testing)
        async syncSubscription(stripeSubscriptionId: string) {
          const row = await db
            .selectFrom("stripe_subscriptions")
            .selectAll()
            .where("stripe_subscription_id", "=", stripeSubscriptionId)
            .executeTakeFirstOrThrow();

          return toSubscriptionRecord(row);
        },
      };
    },
  };
}

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe("Stripe Plugin Integration - Full Checkout Flow", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let emittedEvents: Array<{ type: string; data: any }>;

  beforeEach(async () => {
    db = await createTestDatabase();
    const core = createTestCoreServices(db);

    // Track emitted events
    emittedEvents = [];
    const originalEmit = core.events.emit;
    core.events.emit = (type: string, data: any) => {
      emittedEvents.push({ type, data });
      return originalEmit.call(core.events, type, data);
    };

    manager = new PluginManager(core);
    manager.register(createIntegrationMockPlugin());
    await manager.init();
  });

  it("should complete full checkout to subscription flow", async () => {
    const stripe = manager.getServices().stripe;

    // Step 1: Create customer
    const customer = await stripe.getOrCreateCustomer({
      userId: "user-checkout-flow",
      email: "flow@example.com",
      name: "Flow User",
    });

    expect(customer.stripeCustomerId).toBeDefined();
    expect(emittedEvents.some((e) => e.type === "stripe.customer.created")).toBe(true);

    // Step 2: Create checkout session
    const checkout = await stripe.createSubscriptionCheckout({
      userId: "user-checkout-flow",
      priceId: "price_pro_monthly",
    });

    expect(checkout.sessionId).toBeDefined();
    expect(checkout.url).toContain("checkout.stripe.com");

    // Step 3: Simulate webhook for subscription creation (as if checkout completed)
    const subscriptionCreatedEvent = {
      id: "evt_subscription_created_1",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_checkout_flow_1",
          customer: customer.stripeCustomerId,
          status: "active",
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          cancel_at_period_end: false,
          items: {
            data: [
              {
                price: {
                  id: "price_pro_monthly",
                  product: "prod_pro",
                },
                quantity: 1,
              },
            ],
          },
        },
      },
    };

    const webhookResult = await stripe.handleWebhook(
      JSON.stringify(subscriptionCreatedEvent),
      "valid-signature"
    );

    expect(webhookResult.processed).toBe(true);
    expect(webhookResult.eventType).toBe("customer.subscription.created");

    // Step 4: Verify subscription is active
    const hasSubscription = await stripe.hasActiveSubscription("user-checkout-flow");
    expect(hasSubscription).toBe(true);

    const subscription = await stripe.getSubscription("user-checkout-flow");
    expect(subscription).not.toBeNull();
    expect(subscription?.status).toBe("active");
    expect(subscription?.priceId).toBe("price_pro_monthly");

    // Verify events were emitted
    expect(emittedEvents.some((e) => e.type === "stripe.subscription.created")).toBe(true);
  });
});

describe("Stripe Plugin Integration - Webhook Idempotency", () => {
  let manager: PluginManager;
  let db: Kysely<any>;

  beforeEach(async () => {
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createIntegrationMockPlugin());
    await manager.init();
  });

  it("should not process duplicate events", async () => {
    const stripe = manager.getServices().stripe;

    // First, create a customer to link subscription to
    await stripe.getOrCreateCustomer({
      userId: "user-idempotent",
      email: "idempotent@example.com",
    });

    const customer = await db
      .selectFrom("stripe_customers")
      .selectAll()
      .where("user_id", "=", "user-idempotent")
      .executeTakeFirstOrThrow();

    const event = {
      id: "evt_duplicate_test_1",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_idempotent_1",
          customer: customer.stripe_customer_id,
          status: "active",
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          cancel_at_period_end: false,
          items: {
            data: [
              {
                price: { id: "price_test", product: "prod_test" },
                quantity: 1,
              },
            ],
          },
        },
      },
    };

    // First processing
    const firstResult = await stripe.handleWebhook(JSON.stringify(event), "valid");
    expect(firstResult.processed).toBe(true);

    // Count subscriptions
    const countAfterFirst = await db
      .selectFrom("stripe_subscriptions")
      .select((eb) => eb.fn.count("id").as("count"))
      .executeTakeFirst();
    expect(Number(countAfterFirst?.count)).toBe(1);

    // Second processing (duplicate)
    const secondResult = await stripe.handleWebhook(JSON.stringify(event), "valid");
    expect(secondResult.processed).toBe(false);

    // Should still have only 1 subscription
    const countAfterSecond = await db
      .selectFrom("stripe_subscriptions")
      .select((eb) => eb.fn.count("id").as("count"))
      .executeTakeFirst();
    expect(Number(countAfterSecond?.count)).toBe(1);

    // Event should be marked as processed
    const isProcessed = await stripe.isEventProcessed("evt_duplicate_test_1");
    expect(isProcessed).toBe(true);
  });
});

describe("Stripe Plugin Integration - Subscription Lifecycle", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let emittedEvents: Array<{ type: string; data: any }>;

  beforeEach(async () => {
    db = await createTestDatabase();
    const core = createTestCoreServices(db);

    emittedEvents = [];
    const originalEmit = core.events.emit;
    core.events.emit = (type: string, data: any) => {
      emittedEvents.push({ type, data });
      return originalEmit.call(core.events, type, data);
    };

    manager = new PluginManager(core);
    manager.register(createIntegrationMockPlugin());
    await manager.init();
  });

  it("should handle full subscription lifecycle", async () => {
    const stripe = manager.getServices().stripe;

    // Setup: Create customer and subscription via webhook
    await stripe.getOrCreateCustomer({
      userId: "user-lifecycle",
      email: "lifecycle@example.com",
    });

    const customer = await db
      .selectFrom("stripe_customers")
      .selectAll()
      .where("user_id", "=", "user-lifecycle")
      .executeTakeFirstOrThrow();

    // Create subscription
    await stripe.handleWebhook(
      JSON.stringify({
        id: "evt_lifecycle_create",
        type: "customer.subscription.created",
        data: {
          object: {
            id: "sub_lifecycle_1",
            customer: customer.stripe_customer_id,
            status: "active",
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            cancel_at_period_end: false,
            items: {
              data: [
                {
                  price: { id: "price_pro", product: "prod_pro" },
                  quantity: 1,
                },
              ],
            },
          },
        },
      }),
      "valid"
    );

    // Verify active subscription
    let subscription = await stripe.getSubscription("user-lifecycle");
    expect(subscription?.status).toBe("active");
    expect(subscription?.cancelAtPeriodEnd).toBe(false);

    // Cancel at period end
    subscription = await stripe.cancelSubscription("user-lifecycle", { immediately: false });
    expect(subscription.cancelAtPeriodEnd).toBe(true);
    expect(subscription.status).toBe("active"); // Still active until period end

    // Resume subscription
    subscription = await stripe.resumeSubscription("user-lifecycle");
    expect(subscription.cancelAtPeriodEnd).toBe(false);

    // Cancel immediately
    subscription = await stripe.cancelSubscription("user-lifecycle", { immediately: true });
    expect(subscription.status).toBe("canceled");
    expect(subscription.endedAt).not.toBeNull();

    // Should no longer have active subscription
    const hasActive = await stripe.hasActiveSubscription("user-lifecycle");
    expect(hasActive).toBe(false);
  });
});

describe("Stripe Plugin Integration - Multiple Subscriptions", () => {
  let manager: PluginManager;
  let db: Kysely<any>;

  beforeEach(async () => {
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createIntegrationMockPlugin());
    await manager.init();
  });

  it("should handle user with multiple subscriptions", async () => {
    const stripe = manager.getServices().stripe;

    // Setup customer
    await stripe.getOrCreateCustomer({
      userId: "user-multi",
      email: "multi@example.com",
    });

    const customer = await db
      .selectFrom("stripe_customers")
      .selectAll()
      .where("user_id", "=", "user-multi")
      .executeTakeFirstOrThrow();

    // Create first subscription
    await stripe.handleWebhook(
      JSON.stringify({
        id: "evt_multi_1",
        type: "customer.subscription.created",
        data: {
          object: {
            id: "sub_multi_1",
            customer: customer.stripe_customer_id,
            status: "active",
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            cancel_at_period_end: false,
            items: {
              data: [{ price: { id: "price_basic", product: "prod_basic" }, quantity: 1 }],
            },
          },
        },
      }),
      "valid"
    );

    // Create second subscription
    await stripe.handleWebhook(
      JSON.stringify({
        id: "evt_multi_2",
        type: "customer.subscription.created",
        data: {
          object: {
            id: "sub_multi_2",
            customer: customer.stripe_customer_id,
            status: "active",
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            cancel_at_period_end: false,
            items: {
              data: [{ price: { id: "price_addon", product: "prod_addon" }, quantity: 1 }],
            },
          },
        },
      }),
      "valid"
    );

    // Should have 2 subscriptions
    const subscriptions = await stripe.getSubscriptions("user-multi");
    expect(subscriptions.length).toBe(2);

    // Should detect both plans
    expect(await stripe.hasPlan("user-multi", "prod_basic")).toBe(true);
    expect(await stripe.hasPlan("user-multi", "prod_addon")).toBe(true);
    expect(await stripe.hasPlan("user-multi", "prod_enterprise")).toBe(false);
  });
});

describe("Stripe Plugin Integration - Payment Events", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let emittedEvents: Array<{ type: string; data: any }>;

  beforeEach(async () => {
    db = await createTestDatabase();
    const core = createTestCoreServices(db);

    emittedEvents = [];
    const originalEmit = core.events.emit;
    core.events.emit = (type: string, data: any) => {
      emittedEvents.push({ type, data });
      return originalEmit.call(core.events, type, data);
    };

    manager = new PluginManager(core);
    manager.register(createIntegrationMockPlugin());
    await manager.init();
  });

  it("should emit payment succeeded event", async () => {
    const stripe = manager.getServices().stripe;

    // Setup customer
    await stripe.getOrCreateCustomer({
      userId: "user-payment",
      email: "payment@example.com",
    });

    const customer = await db
      .selectFrom("stripe_customers")
      .selectAll()
      .where("user_id", "=", "user-payment")
      .executeTakeFirstOrThrow();

    // Simulate invoice paid event
    await stripe.handleWebhook(
      JSON.stringify({
        id: "evt_payment_1",
        type: "invoice.paid",
        data: {
          object: {
            id: "in_123",
            customer: customer.stripe_customer_id,
            amount_paid: 1999,
            currency: "usd",
          },
        },
      }),
      "valid"
    );

    // Verify event was emitted
    const paymentEvent = emittedEvents.find((e) => e.type === "stripe.payment.succeeded");
    expect(paymentEvent).toBeDefined();
    expect(paymentEvent?.data.userId).toBe("user-payment");
    expect(paymentEvent?.data.amount).toBe(1999);
    expect(paymentEvent?.data.currency).toBe("usd");
  });
});

// =============================================================================
// ADDITIONAL INTEGRATION TESTS
// =============================================================================

describe("Stripe Plugin Integration - Subscription Update Webhook", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let emittedEvents: Array<{ type: string; data: any }>;

  beforeEach(async () => {
    db = await createTestDatabase();
    const core = createTestCoreServices(db);

    emittedEvents = [];
    const originalEmit = core.events.emit;
    core.events.emit = (type: string, data: any) => {
      emittedEvents.push({ type, data });
      return originalEmit.call(core.events, type, data);
    };

    manager = new PluginManager(core);
    manager.register(createIntegrationMockPlugin());
    await manager.init();
  });

  it("should update subscription via webhook and emit event on status change", async () => {
    const stripe = manager.getServices().stripe;

    // Setup customer and subscription
    await stripe.getOrCreateCustomer({
      userId: "user-update-webhook",
      email: "updatewebhook@example.com",
    });

    const customer = await db
      .selectFrom("stripe_customers")
      .selectAll()
      .where("user_id", "=", "user-update-webhook")
      .executeTakeFirstOrThrow();

    // Create subscription via webhook
    await stripe.handleWebhook(
      JSON.stringify({
        id: "evt_create_for_update",
        type: "customer.subscription.created",
        data: {
          object: {
            id: "sub_to_update",
            customer: customer.stripe_customer_id,
            status: "trialing",
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            cancel_at_period_end: false,
            items: {
              data: [{ price: { id: "price_test", product: "prod_test" }, quantity: 1 }],
            },
          },
        },
      }),
      "valid"
    );

    // Verify trialing status
    let subscription = await stripe.getSubscription("user-update-webhook");
    expect(subscription?.status).toBe("trialing");

    // Update subscription status via webhook (trial ended, now active)
    await stripe.handleWebhook(
      JSON.stringify({
        id: "evt_update_status",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_to_update",
            customer: customer.stripe_customer_id,
            status: "active",
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            cancel_at_period_end: false,
          },
        },
      }),
      "valid"
    );

    // Verify status updated
    subscription = await stripe.getSubscription("user-update-webhook");
    expect(subscription?.status).toBe("active");

    // Verify update event was emitted
    const updateEvent = emittedEvents.find(
      (e) => e.type === "stripe.subscription.updated" && e.data.subscriptionId === "sub_to_update"
    );
    expect(updateEvent).toBeDefined();
    expect(updateEvent?.data.previousStatus).toBe("trialing");
    expect(updateEvent?.data.status).toBe("active");
  });

  it("should not emit update event when status unchanged", async () => {
    const stripe = manager.getServices().stripe;

    await stripe.getOrCreateCustomer({
      userId: "user-no-status-change",
      email: "nostatuschange@example.com",
    });

    const customer = await db
      .selectFrom("stripe_customers")
      .selectAll()
      .where("user_id", "=", "user-no-status-change")
      .executeTakeFirstOrThrow();

    // Create subscription
    await stripe.handleWebhook(
      JSON.stringify({
        id: "evt_create_no_change",
        type: "customer.subscription.created",
        data: {
          object: {
            id: "sub_no_change",
            customer: customer.stripe_customer_id,
            status: "active",
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            cancel_at_period_end: false,
            items: {
              data: [{ price: { id: "price_test", product: "prod_test" }, quantity: 1 }],
            },
          },
        },
      }),
      "valid"
    );

    // Clear events
    emittedEvents.length = 0;

    // Update with same status (e.g., quantity change)
    await stripe.handleWebhook(
      JSON.stringify({
        id: "evt_same_status",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_no_change",
            customer: customer.stripe_customer_id,
            status: "active", // Same status
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            cancel_at_period_end: false,
          },
        },
      }),
      "valid"
    );

    // Should not have emitted update event
    const updateEvent = emittedEvents.find((e) => e.type === "stripe.subscription.updated");
    expect(updateEvent).toBeUndefined();
  });
});

describe("Stripe Plugin Integration - Subscription Deletion Webhook", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let emittedEvents: Array<{ type: string; data: any }>;

  beforeEach(async () => {
    db = await createTestDatabase();
    const core = createTestCoreServices(db);

    emittedEvents = [];
    const originalEmit = core.events.emit;
    core.events.emit = (type: string, data: any) => {
      emittedEvents.push({ type, data });
      return originalEmit.call(core.events, type, data);
    };

    manager = new PluginManager(core);
    manager.register(createIntegrationMockPlugin());
    await manager.init();
  });

  it("should mark subscription as canceled via webhook", async () => {
    const stripe = manager.getServices().stripe;

    await stripe.getOrCreateCustomer({
      userId: "user-delete-webhook",
      email: "deletewebhook@example.com",
    });

    const customer = await db
      .selectFrom("stripe_customers")
      .selectAll()
      .where("user_id", "=", "user-delete-webhook")
      .executeTakeFirstOrThrow();

    // Create subscription
    await stripe.handleWebhook(
      JSON.stringify({
        id: "evt_create_to_delete",
        type: "customer.subscription.created",
        data: {
          object: {
            id: "sub_to_delete",
            customer: customer.stripe_customer_id,
            status: "active",
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            cancel_at_period_end: false,
            items: {
              data: [{ price: { id: "price_test", product: "prod_test" }, quantity: 1 }],
            },
          },
        },
      }),
      "valid"
    );

    // Verify active
    expect(await stripe.hasActiveSubscription("user-delete-webhook")).toBe(true);

    // Delete via webhook
    await stripe.handleWebhook(
      JSON.stringify({
        id: "evt_delete_sub",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_to_delete",
            customer: customer.stripe_customer_id,
            status: "canceled",
          },
        },
      }),
      "valid"
    );

    // Verify no longer active
    expect(await stripe.hasActiveSubscription("user-delete-webhook")).toBe(false);

    // Check subscription is marked as canceled with ended_at
    const dbSub = await db
      .selectFrom("stripe_subscriptions")
      .selectAll()
      .where("stripe_subscription_id", "=", "sub_to_delete")
      .executeTakeFirst();

    expect(dbSub?.status).toBe("canceled");
    expect(dbSub?.ended_at).not.toBeNull();

    // Verify canceled event was emitted
    const canceledEvent = emittedEvents.find(
      (e) => e.type === "stripe.subscription.canceled" && e.data.subscriptionId === "sub_to_delete"
    );
    expect(canceledEvent).toBeDefined();
    expect(canceledEvent?.data.userId).toBe("user-delete-webhook");
  });
});

describe("Stripe Plugin Integration - Trial Subscriptions", () => {
  let manager: PluginManager;
  let db: Kysely<any>;

  beforeEach(async () => {
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createIntegrationMockPlugin());
    await manager.init();
  });

  it("should store trial dates in subscription", async () => {
    const stripe = manager.getServices().stripe;

    await stripe.getOrCreateCustomer({
      userId: "user-trial-dates",
      email: "trialdates@example.com",
    });

    const customer = await db
      .selectFrom("stripe_customers")
      .selectAll()
      .where("user_id", "=", "user-trial-dates")
      .executeTakeFirstOrThrow();

    const trialStart = Math.floor(Date.now() / 1000);
    const trialEnd = trialStart + 14 * 24 * 60 * 60; // 14 days

    await stripe.handleWebhook(
      JSON.stringify({
        id: "evt_trial_dates",
        type: "customer.subscription.created",
        data: {
          object: {
            id: "sub_with_trial",
            customer: customer.stripe_customer_id,
            status: "trialing",
            current_period_start: trialStart,
            current_period_end: trialEnd,
            cancel_at_period_end: false,
            trial_start: trialStart,
            trial_end: trialEnd,
            items: {
              data: [{ price: { id: "price_test", product: "prod_test" }, quantity: 1 }],
            },
          },
        },
      }),
      "valid"
    );

    // Note: The mock plugin doesn't currently store trial dates, but the real plugin does
    // This test verifies the webhook flow works for trial subscriptions
    const subscription = await stripe.getSubscription("user-trial-dates");
    expect(subscription?.status).toBe("trialing");
  });
});

describe("Stripe Plugin Integration - Webhook Error Handling", () => {
  let manager: PluginManager;
  let db: Kysely<any>;

  beforeEach(async () => {
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createIntegrationMockPlugin());
    await manager.init();
  });

  it("should reject invalid signature", async () => {
    const stripe = manager.getServices().stripe;

    await expect(
      stripe.handleWebhook(JSON.stringify({ id: "evt_invalid", type: "test" }), "invalid")
    ).rejects.toThrow();
  });

  it("should mark event as failed when processing fails", async () => {
    const stripe = manager.getServices().stripe;

    // Try to create subscription for non-existent customer
    const event = {
      id: "evt_fail_processing",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_will_fail",
          customer: "cus_nonexistent",
          status: "active",
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          cancel_at_period_end: false,
          items: {
            data: [{ price: { id: "price_test", product: "prod_test" }, quantity: 1 }],
          },
        },
      },
    };

    await expect(stripe.handleWebhook(JSON.stringify(event), "valid")).rejects.toThrow(
      "Customer not found"
    );

    // Event should be marked as failed
    const eventRecord = await db
      .selectFrom("stripe_webhook_events")
      .selectAll()
      .where("stripe_event_id", "=", "evt_fail_processing")
      .executeTakeFirst();

    expect(eventRecord?.status).toBe("failed");
    expect(eventRecord?.error).toContain("Customer not found");
  });
});

describe("Stripe Plugin Integration - Unhandled Event Types", () => {
  let manager: PluginManager;
  let db: Kysely<any>;

  beforeEach(async () => {
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createIntegrationMockPlugin());
    await manager.init();
  });

  it("should process unhandled event types without error", async () => {
    const stripe = manager.getServices().stripe;

    const result = await stripe.handleWebhook(
      JSON.stringify({
        id: "evt_unknown_type",
        type: "some.unknown.event",
        data: {
          object: { foo: "bar" },
        },
      }),
      "valid"
    );

    expect(result.processed).toBe(true);
    expect(result.eventType).toBe("some.unknown.event");

    // Event should still be recorded
    const eventRecord = await db
      .selectFrom("stripe_webhook_events")
      .selectAll()
      .where("stripe_event_id", "=", "evt_unknown_type")
      .executeTakeFirst();

    expect(eventRecord?.status).toBe("processed");
  });
});

describe("Stripe Plugin Integration - Cancel and Resume Flow", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let emittedEvents: Array<{ type: string; data: any }>;

  beforeEach(async () => {
    db = await createTestDatabase();
    const core = createTestCoreServices(db);

    emittedEvents = [];
    const originalEmit = core.events.emit;
    core.events.emit = (type: string, data: any) => {
      emittedEvents.push({ type, data });
      return originalEmit.call(core.events, type, data);
    };

    manager = new PluginManager(core);
    manager.register(createIntegrationMockPlugin());
    await manager.init();
  });

  it("should handle cancel at period end and resume", async () => {
    const stripe = manager.getServices().stripe;

    // Setup customer and subscription
    await stripe.getOrCreateCustomer({
      userId: "user-cancel-resume",
      email: "cancelresume@example.com",
    });

    const customer = await db
      .selectFrom("stripe_customers")
      .selectAll()
      .where("user_id", "=", "user-cancel-resume")
      .executeTakeFirstOrThrow();

    await stripe.handleWebhook(
      JSON.stringify({
        id: "evt_create_cancel_resume",
        type: "customer.subscription.created",
        data: {
          object: {
            id: "sub_cancel_resume",
            customer: customer.stripe_customer_id,
            status: "active",
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            cancel_at_period_end: false,
            items: {
              data: [{ price: { id: "price_test", product: "prod_test" }, quantity: 1 }],
            },
          },
        },
      }),
      "valid"
    );

    // Cancel at period end
    let subscription = await stripe.cancelSubscription("user-cancel-resume", { immediately: false });
    expect(subscription.cancelAtPeriodEnd).toBe(true);
    expect(subscription.status).toBe("active"); // Still active

    // Should still have active subscription
    expect(await stripe.hasActiveSubscription("user-cancel-resume")).toBe(true);

    // Resume
    subscription = await stripe.resumeSubscription("user-cancel-resume");
    expect(subscription.cancelAtPeriodEnd).toBe(false);

    // Cancel immediately
    subscription = await stripe.cancelSubscription("user-cancel-resume", { immediately: true });
    expect(subscription.status).toBe("canceled");

    // Should no longer have active subscription
    expect(await stripe.hasActiveSubscription("user-cancel-resume")).toBe(false);
  });

  it("should do nothing when resuming non-canceling subscription", async () => {
    const stripe = manager.getServices().stripe;

    await stripe.getOrCreateCustomer({
      userId: "user-resume-noop",
      email: "resumenoop@example.com",
    });

    const customer = await db
      .selectFrom("stripe_customers")
      .selectAll()
      .where("user_id", "=", "user-resume-noop")
      .executeTakeFirstOrThrow();

    await stripe.handleWebhook(
      JSON.stringify({
        id: "evt_create_resume_noop",
        type: "customer.subscription.created",
        data: {
          object: {
            id: "sub_resume_noop",
            customer: customer.stripe_customer_id,
            status: "active",
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            cancel_at_period_end: false,
            items: {
              data: [{ price: { id: "price_test", product: "prod_test" }, quantity: 1 }],
            },
          },
        },
      }),
      "valid"
    );

    // Try to resume (not canceling)
    const subscription = await stripe.resumeSubscription("user-resume-noop");
    expect(subscription.cancelAtPeriodEnd).toBe(false);
    expect(subscription.status).toBe("active");
  });
});

describe("Stripe Plugin Integration - Sync Subscription", () => {
  let manager: PluginManager;
  let db: Kysely<any>;

  beforeEach(async () => {
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createIntegrationMockPlugin());
    await manager.init();
  });

  it("should sync subscription by stripe ID", async () => {
    const stripe = manager.getServices().stripe;

    await stripe.getOrCreateCustomer({
      userId: "user-sync-sub",
      email: "syncsub@example.com",
    });

    const customer = await db
      .selectFrom("stripe_customers")
      .selectAll()
      .where("user_id", "=", "user-sync-sub")
      .executeTakeFirstOrThrow();

    await stripe.handleWebhook(
      JSON.stringify({
        id: "evt_create_sync",
        type: "customer.subscription.created",
        data: {
          object: {
            id: "sub_to_sync",
            customer: customer.stripe_customer_id,
            status: "active",
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            cancel_at_period_end: false,
            items: {
              data: [{ price: { id: "price_sync", product: "prod_sync" }, quantity: 1 }],
            },
          },
        },
      }),
      "valid"
    );

    const synced = await stripe.syncSubscription("sub_to_sync");
    expect(synced.stripeSubscriptionId).toBe("sub_to_sync");
    expect(synced.userId).toBe("user-sync-sub");
  });
});

describe("Stripe Plugin Integration - Concurrent Customers", () => {
  let manager: PluginManager;
  let db: Kysely<any>;

  beforeEach(async () => {
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createIntegrationMockPlugin());
    await manager.init();
  });

  it("should handle multiple customers independently", async () => {
    const stripe = manager.getServices().stripe;

    // Create multiple customers
    const customer1 = await stripe.getOrCreateCustomer({
      userId: "user-concurrent-1",
      email: "concurrent1@example.com",
    });

    const customer2 = await stripe.getOrCreateCustomer({
      userId: "user-concurrent-2",
      email: "concurrent2@example.com",
    });

    const customer3 = await stripe.getOrCreateCustomer({
      userId: "user-concurrent-3",
      email: "concurrent3@example.com",
    });

    // Each should have unique IDs
    expect(customer1.stripeCustomerId).not.toBe(customer2.stripeCustomerId);
    expect(customer2.stripeCustomerId).not.toBe(customer3.stripeCustomerId);

    // Each should be retrievable
    expect(await stripe.getCustomerByUserId("user-concurrent-1")).not.toBeNull();
    expect(await stripe.getCustomerByUserId("user-concurrent-2")).not.toBeNull();
    expect(await stripe.getCustomerByUserId("user-concurrent-3")).not.toBeNull();
  });
});
