/**
 * Stripe Plugin Unit Tests
 *
 * Tests for the Stripe plugin service methods with mocked Stripe SDK
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
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
// MOCK STRIPE SDK
// =============================================================================

interface MockStripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
  metadata: Record<string, string>;
  deleted?: boolean;
}

interface MockStripeSubscription {
  id: string;
  customer: string;
  status: string;
  items: {
    data: Array<{
      id: string;
      price: {
        id: string;
        product: { id: string };
      };
      quantity: number;
    }>;
  };
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  ended_at: number | null;
  trial_start: number | null;
  trial_end: number | null;
  metadata: Record<string, string>;
}

interface MockStripeState {
  customers: Map<string, MockStripeCustomer>;
  subscriptions: Map<string, MockStripeSubscription>;
  checkoutSessions: Map<string, any>;
  portalSessions: Map<string, any>;
}

function createMockStripe() {
  const state: MockStripeState = {
    customers: new Map(),
    subscriptions: new Map(),
    checkoutSessions: new Map(),
    portalSessions: new Map(),
  };

  let customerIdCounter = 0;
  let subscriptionIdCounter = 0;
  let sessionIdCounter = 0;

  return {
    _state: state,
    _reset: () => {
      state.customers.clear();
      state.subscriptions.clear();
      state.checkoutSessions.clear();
      state.portalSessions.clear();
      customerIdCounter = 0;
      subscriptionIdCounter = 0;
      sessionIdCounter = 0;
    },

    customers: {
      create: async (params: any): Promise<MockStripeCustomer> => {
        const id = `cus_mock_${++customerIdCounter}`;
        const customer: MockStripeCustomer = {
          id,
          email: params.email || null,
          name: params.name || null,
          metadata: params.metadata || {},
        };
        state.customers.set(id, customer);
        return customer;
      },

      retrieve: async (id: string): Promise<MockStripeCustomer> => {
        const customer = state.customers.get(id);
        if (!customer) {
          throw new Error(`Customer ${id} not found`);
        }
        return customer;
      },

      update: async (id: string, params: any): Promise<MockStripeCustomer> => {
        const customer = state.customers.get(id);
        if (!customer) {
          throw new Error(`Customer ${id} not found`);
        }
        if (params.email !== undefined) customer.email = params.email;
        if (params.name !== undefined) customer.name = params.name;
        if (params.metadata !== undefined) customer.metadata = params.metadata;
        return customer;
      },

      del: async (id: string): Promise<{ id: string; deleted: boolean }> => {
        const customer = state.customers.get(id);
        if (customer) {
          customer.deleted = true;
        }
        return { id, deleted: true };
      },
    },

    subscriptions: {
      retrieve: async (id: string): Promise<MockStripeSubscription> => {
        const subscription = state.subscriptions.get(id);
        if (!subscription) {
          throw new Error(`Subscription ${id} not found`);
        }
        return subscription;
      },

      update: async (id: string, params: any): Promise<MockStripeSubscription> => {
        const subscription = state.subscriptions.get(id);
        if (!subscription) {
          throw new Error(`Subscription ${id} not found`);
        }

        if (params.cancel_at_period_end !== undefined) {
          subscription.cancel_at_period_end = params.cancel_at_period_end;
        }
        if (params.pause_collection !== undefined) {
          subscription.status = params.pause_collection ? "paused" : "active";
        }
        if (params.items) {
          const item = params.items[0];
          if (item?.price) {
            subscription.items.data[0].price.id = item.price;
          }
          if (item?.quantity !== undefined) {
            subscription.items.data[0].quantity = item.quantity;
          }
        }

        return subscription;
      },

      cancel: async (id: string): Promise<MockStripeSubscription> => {
        const subscription = state.subscriptions.get(id);
        if (!subscription) {
          throw new Error(`Subscription ${id} not found`);
        }
        subscription.status = "canceled";
        subscription.canceled_at = Math.floor(Date.now() / 1000);
        subscription.ended_at = Math.floor(Date.now() / 1000);
        return subscription;
      },
    },

    checkout: {
      sessions: {
        create: async (params: any): Promise<any> => {
          const id = `cs_mock_${++sessionIdCounter}`;
          const session = {
            id,
            url: `https://checkout.stripe.com/pay/${id}`,
            customer: params.customer,
            mode: params.mode,
            subscription: params.mode === "subscription" ? `sub_mock_${++subscriptionIdCounter}` : null,
          };
          state.checkoutSessions.set(id, session);
          return session;
        },
      },
    },

    billingPortal: {
      sessions: {
        create: async (params: any): Promise<any> => {
          const id = `bps_mock_${++sessionIdCounter}`;
          const session = {
            id,
            url: `https://billing.stripe.com/session/${id}`,
            customer: params.customer,
            return_url: params.return_url,
          };
          state.portalSessions.set(id, session);
          return session;
        },
      },
    },

    billing: {
      meterEvents: {
        create: async (params: any): Promise<any> => {
          return { id: `mtre_mock_${Date.now()}` };
        },
      },
    },

    invoices: {
      retrieveUpcoming: async (params: any): Promise<any> => {
        return {
          amount_due: 1999,
          currency: "usd",
          period_start: Math.floor(Date.now() / 1000),
          period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          lines: {
            data: [
              {
                description: "Pro Plan",
                amount: 1999,
                quantity: 1,
              },
            ],
          },
        };
      },
    },

    webhooks: {
      constructEvent: (payload: string, signature: string, secret: string): any => {
        if (signature === "invalid") {
          throw new Error("Invalid signature");
        }
        return JSON.parse(payload);
      },
    },

    errors: {
      StripeInvalidRequestError: class StripeInvalidRequestError extends Error {
        code: string;
        constructor(message: string, code: string) {
          super(message);
          this.code = code;
        }
      },
    },

    // Helper to create test subscription
    _createSubscription: (customerId: string, status = "active"): MockStripeSubscription => {
      const id = `sub_mock_${++subscriptionIdCounter}`;
      const now = Math.floor(Date.now() / 1000);
      const subscription: MockStripeSubscription = {
        id,
        customer: customerId,
        status,
        items: {
          data: [
            {
              id: `si_mock_${subscriptionIdCounter}`,
              price: {
                id: "price_pro_monthly",
                product: { id: "prod_pro" },
              },
              quantity: 1,
            },
          ],
        },
        current_period_start: now,
        current_period_end: now + 30 * 24 * 60 * 60,
        cancel_at_period_end: false,
        canceled_at: null,
        ended_at: null,
        trial_start: null,
        trial_end: null,
        metadata: {},
      };
      state.subscriptions.set(id, subscription);
      return subscription;
    },
  };
}

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

  // Create stripe_customers table
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

  // Create stripe_subscriptions table
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

  // Create stripe_webhook_events table
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

function createMockStripePlugin(mockStripe: ReturnType<typeof createMockStripe>): Plugin {
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
      const config = ctx.config;
      const db = ctx.db;

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

          const stripeCustomer = await mockStripe.customers.create({
            email,
            name,
            metadata: { ...metadata, userId },
          });

          const id = generateId("cust");
          const now = new Date().toISOString();

          await db
            .insertInto("stripe_customers")
            .values({
              id,
              user_id: userId,
              stripe_customer_id: stripeCustomer.id,
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

        async updateCustomer(userId: string, params: any) {
          const customer = await this.getCustomerByUserId(userId);
          if (!customer) {
            throw ctx.core.errors.NotFound("Customer not found");
          }

          await mockStripe.customers.update(customer.stripeCustomerId, params);

          const now = new Date().toISOString();
          await db
            .updateTable("stripe_customers")
            .set({
              ...(params.email && { email: params.email }),
              ...(params.name && { name: params.name }),
              ...(params.metadata && { metadata: JSON.stringify(params.metadata) }),
              updated_at: now,
            })
            .where("user_id", "=", userId)
            .execute();

          const updated = await db
            .selectFrom("stripe_customers")
            .selectAll()
            .where("user_id", "=", userId)
            .executeTakeFirstOrThrow();

          return toCustomerRecord(updated);
        },

        async deleteCustomer(userId: string, options?: any) {
          const customer = await this.getCustomerByUserId(userId);
          if (!customer) {
            throw ctx.core.errors.NotFound("Customer not found");
          }

          if (options?.deleteInStripe) {
            await mockStripe.customers.del(customer.stripeCustomerId);
          }

          const now = new Date().toISOString();
          await db
            .updateTable("stripe_customers")
            .set({ deleted_at: now, updated_at: now })
            .where("user_id", "=", userId)
            .execute();
        },

        async createSubscriptionCheckout(params: any) {
          const customer = await this.getCustomerByUserId(params.userId);
          if (!customer) {
            throw ctx.core.errors.NotFound("Customer not found");
          }

          const session = await mockStripe.checkout.sessions.create({
            customer: customer.stripeCustomerId,
            mode: "subscription",
            line_items: [{ price: params.priceId, quantity: params.quantity || 1 }],
            success_url: params.successUrl || config.checkout.successUrl,
            cancel_url: params.cancelUrl || config.checkout.cancelUrl,
          });

          return {
            sessionId: session.id,
            url: session.url,
          };
        },

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

        async createPortalSession(userId: string, options?: any) {
          const customer = await this.getCustomerByUserId(userId);
          if (!customer) {
            throw ctx.core.errors.NotFound("Customer not found");
          }

          const session = await mockStripe.billingPortal.sessions.create({
            customer: customer.stripeCustomerId,
            return_url: options?.returnUrl || config.portal.returnUrl,
          });

          return { url: session.url };
        },

        async isEventProcessed(eventId: string) {
          const event = await db
            .selectFrom("stripe_webhook_events")
            .select(["id"])
            .where("stripe_event_id", "=", eventId)
            .executeTakeFirst();

          return !!event;
        },
      };
    },
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("Stripe Plugin - Customer Management", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let mockStripe: ReturnType<typeof createMockStripe>;

  beforeEach(async () => {
    mockStripe = createMockStripe();
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createMockStripePlugin(mockStripe));
    await manager.init();
  });

  it("should create a new customer", async () => {
    const stripe = manager.getServices().stripe;

    const result = await stripe.getOrCreateCustomer({
      userId: "user-123",
      email: "test@example.com",
      name: "Test User",
    });

    expect(result.userId).toBe("user-123");
    expect(result.email).toBe("test@example.com");
    expect(result.name).toBe("Test User");
    expect(result.stripeCustomerId).toMatch(/^cus_mock_/);
  });

  it("should return existing customer on second call", async () => {
    const stripe = manager.getServices().stripe;

    const first = await stripe.getOrCreateCustomer({
      userId: "user-456",
      email: "user@example.com",
    });

    const second = await stripe.getOrCreateCustomer({
      userId: "user-456",
      email: "different@example.com",
    });

    expect(first.id).toBe(second.id);
    expect(first.stripeCustomerId).toBe(second.stripeCustomerId);
    expect(first.email).toBe("user@example.com"); // Original email preserved
  });

  it("should get customer by user ID", async () => {
    const stripe = manager.getServices().stripe;

    await stripe.getOrCreateCustomer({
      userId: "user-789",
      email: "get@example.com",
    });

    const customer = await stripe.getCustomerByUserId("user-789");

    expect(customer).not.toBeNull();
    expect(customer?.email).toBe("get@example.com");
  });

  it("should return null for non-existent customer", async () => {
    const stripe = manager.getServices().stripe;

    const customer = await stripe.getCustomerByUserId("non-existent");

    expect(customer).toBeNull();
  });

  it("should update customer", async () => {
    const stripe = manager.getServices().stripe;

    await stripe.getOrCreateCustomer({
      userId: "user-update",
      email: "old@example.com",
      name: "Old Name",
    });

    const updated = await stripe.updateCustomer("user-update", {
      email: "new@example.com",
      name: "New Name",
    });

    expect(updated.email).toBe("new@example.com");
    expect(updated.name).toBe("New Name");
  });

  it("should soft delete customer", async () => {
    const stripe = manager.getServices().stripe;

    await stripe.getOrCreateCustomer({
      userId: "user-delete",
      email: "delete@example.com",
    });

    await stripe.deleteCustomer("user-delete");

    const customer = await stripe.getCustomerByUserId("user-delete");
    expect(customer).toBeNull();
  });
});

describe("Stripe Plugin - Checkout", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let mockStripe: ReturnType<typeof createMockStripe>;

  beforeEach(async () => {
    mockStripe = createMockStripe();
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createMockStripePlugin(mockStripe));
    await manager.init();
  });

  it("should create subscription checkout session", async () => {
    const stripe = manager.getServices().stripe;

    // First create a customer
    await stripe.getOrCreateCustomer({
      userId: "user-checkout",
      email: "checkout@example.com",
    });

    const result = await stripe.createSubscriptionCheckout({
      userId: "user-checkout",
      priceId: "price_pro_monthly",
    });

    expect(result.sessionId).toMatch(/^cs_mock_/);
    expect(result.url).toContain("checkout.stripe.com");
  });

  it("should throw error for checkout without customer", async () => {
    const stripe = manager.getServices().stripe;

    await expect(
      stripe.createSubscriptionCheckout({
        userId: "non-existent-user",
        priceId: "price_pro_monthly",
      })
    ).rejects.toThrow();
  });
});

describe("Stripe Plugin - Subscription Checks", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let mockStripe: ReturnType<typeof createMockStripe>;

  beforeEach(async () => {
    mockStripe = createMockStripe();
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createMockStripePlugin(mockStripe));
    await manager.init();
  });

  it("should return false for user without subscription", async () => {
    const stripe = manager.getServices().stripe;

    const hasSubscription = await stripe.hasActiveSubscription("no-sub-user");

    expect(hasSubscription).toBe(false);
  });

  it("should return true for user with active subscription", async () => {
    const stripe = manager.getServices().stripe;

    // Manually insert a subscription
    const now = new Date().toISOString();
    await db
      .insertInto("stripe_subscriptions")
      .values({
        id: "sub_test_1",
        stripe_subscription_id: "sub_stripe_1",
        stripe_customer_id: "cus_1",
        user_id: "user-with-sub",
        status: "active",
        price_id: "price_pro",
        product_id: "prod_pro",
        quantity: 1,
        current_period_start: now,
        current_period_end: now,
        cancel_at_period_end: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const hasSubscription = await stripe.hasActiveSubscription("user-with-sub");

    expect(hasSubscription).toBe(true);
  });

  it("should check for specific plan", async () => {
    const stripe = manager.getServices().stripe;

    const now = new Date().toISOString();
    await db
      .insertInto("stripe_subscriptions")
      .values({
        id: "sub_test_2",
        stripe_subscription_id: "sub_stripe_2",
        stripe_customer_id: "cus_2",
        user_id: "user-pro",
        status: "active",
        price_id: "price_pro_monthly",
        product_id: "prod_pro",
        quantity: 1,
        current_period_start: now,
        current_period_end: now,
        cancel_at_period_end: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();

    expect(await stripe.hasPlan("user-pro", "prod_pro")).toBe(true);
    expect(await stripe.hasPlan("user-pro", "price_pro_monthly")).toBe(true);
    expect(await stripe.hasPlan("user-pro", "prod_enterprise")).toBe(false);
  });
});

describe("Stripe Plugin - Portal", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let mockStripe: ReturnType<typeof createMockStripe>;

  beforeEach(async () => {
    mockStripe = createMockStripe();
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createMockStripePlugin(mockStripe));
    await manager.init();
  });

  it("should create portal session", async () => {
    const stripe = manager.getServices().stripe;

    await stripe.getOrCreateCustomer({
      userId: "user-portal",
      email: "portal@example.com",
    });

    const result = await stripe.createPortalSession("user-portal");

    expect(result.url).toContain("billing.stripe.com");
  });
});

describe("Stripe Plugin - Idempotency", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let mockStripe: ReturnType<typeof createMockStripe>;

  beforeEach(async () => {
    mockStripe = createMockStripe();
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createMockStripePlugin(mockStripe));
    await manager.init();
  });

  it("should track processed events", async () => {
    const stripe = manager.getServices().stripe;

    // Initially not processed
    expect(await stripe.isEventProcessed("evt_test_123")).toBe(false);

    // Record an event
    const now = new Date().toISOString();
    await db
      .insertInto("stripe_webhook_events")
      .values({
        id: "evt_internal_1",
        stripe_event_id: "evt_test_123",
        event_type: "customer.subscription.created",
        status: "processed",
        processed_at: now,
        created_at: now,
      })
      .execute();

    // Now it should be processed
    expect(await stripe.isEventProcessed("evt_test_123")).toBe(true);
  });
});

// =============================================================================
// ADDITIONAL UNIT TESTS
// =============================================================================

describe("Stripe Plugin - Customer Metadata", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let mockStripe: ReturnType<typeof createMockStripe>;

  beforeEach(async () => {
    mockStripe = createMockStripe();
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createMockStripePlugin(mockStripe));
    await manager.init();
  });

  it("should store and retrieve customer metadata", async () => {
    const stripe = manager.getServices().stripe;

    const result = await stripe.getOrCreateCustomer({
      userId: "user-metadata",
      email: "meta@example.com",
      metadata: {
        plan: "enterprise",
        source: "signup",
        referrer: "google",
      },
    });

    expect(result.metadata).toBeDefined();
    const metadata = JSON.parse(result.metadata!);
    expect(metadata.plan).toBe("enterprise");
    expect(metadata.source).toBe("signup");
    expect(metadata.referrer).toBe("google");
  });

  it("should handle customer without metadata", async () => {
    const stripe = manager.getServices().stripe;

    const result = await stripe.getOrCreateCustomer({
      userId: "user-no-metadata",
      email: "nometa@example.com",
    });

    expect(result.metadata).toBeNull();
  });

  it("should update customer metadata", async () => {
    const stripe = manager.getServices().stripe;

    await stripe.getOrCreateCustomer({
      userId: "user-update-meta",
      email: "updatemeta@example.com",
      metadata: { original: "value" },
    });

    const updated = await stripe.updateCustomer("user-update-meta", {
      metadata: { updated: "newvalue", extra: "field" },
    });

    const metadata = JSON.parse(updated.metadata!);
    expect(metadata.updated).toBe("newvalue");
    expect(metadata.extra).toBe("field");
  });
});

describe("Stripe Plugin - Customer Error Cases", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let mockStripe: ReturnType<typeof createMockStripe>;

  beforeEach(async () => {
    mockStripe = createMockStripe();
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createMockStripePlugin(mockStripe));
    await manager.init();
  });

  it("should throw error when updating non-existent customer", async () => {
    const stripe = manager.getServices().stripe;

    await expect(
      stripe.updateCustomer("non-existent-user", { name: "New Name" })
    ).rejects.toThrow();
  });

  it("should throw error when deleting non-existent customer", async () => {
    const stripe = manager.getServices().stripe;

    await expect(stripe.deleteCustomer("non-existent-user")).rejects.toThrow();
  });

  it("should throw error when creating portal for non-existent customer", async () => {
    const stripe = manager.getServices().stripe;

    await expect(stripe.createPortalSession("non-existent-user")).rejects.toThrow();
  });
});

describe("Stripe Plugin - Subscription Statuses", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let mockStripe: ReturnType<typeof createMockStripe>;

  beforeEach(async () => {
    mockStripe = createMockStripe();
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createMockStripePlugin(mockStripe));
    await manager.init();
  });

  it("should recognize trialing as active subscription", async () => {
    const stripe = manager.getServices().stripe;

    const now = new Date().toISOString();
    await db
      .insertInto("stripe_subscriptions")
      .values({
        id: "sub_trial_1",
        stripe_subscription_id: "sub_stripe_trial_1",
        stripe_customer_id: "cus_trial_1",
        user_id: "user-trialing",
        status: "trialing",
        price_id: "price_pro",
        product_id: "prod_pro",
        quantity: 1,
        current_period_start: now,
        current_period_end: now,
        cancel_at_period_end: 0,
        trial_start: now,
        trial_end: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        created_at: now,
        updated_at: now,
      })
      .execute();

    expect(await stripe.hasActiveSubscription("user-trialing")).toBe(true);
  });

  it("should not recognize past_due as active", async () => {
    const stripe = manager.getServices().stripe;

    const now = new Date().toISOString();
    await db
      .insertInto("stripe_subscriptions")
      .values({
        id: "sub_past_due_1",
        stripe_subscription_id: "sub_stripe_past_due_1",
        stripe_customer_id: "cus_past_due_1",
        user_id: "user-past-due",
        status: "past_due",
        price_id: "price_pro",
        product_id: "prod_pro",
        quantity: 1,
        current_period_start: now,
        current_period_end: now,
        cancel_at_period_end: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();

    expect(await stripe.hasActiveSubscription("user-past-due")).toBe(false);
  });

  it("should not recognize canceled as active", async () => {
    const stripe = manager.getServices().stripe;

    const now = new Date().toISOString();
    await db
      .insertInto("stripe_subscriptions")
      .values({
        id: "sub_canceled_1",
        stripe_subscription_id: "sub_stripe_canceled_1",
        stripe_customer_id: "cus_canceled_1",
        user_id: "user-canceled",
        status: "canceled",
        price_id: "price_pro",
        product_id: "prod_pro",
        quantity: 1,
        current_period_start: now,
        current_period_end: now,
        cancel_at_period_end: 0,
        canceled_at: now,
        ended_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();

    expect(await stripe.hasActiveSubscription("user-canceled")).toBe(false);
  });

  it("should not recognize unpaid as active", async () => {
    const stripe = manager.getServices().stripe;

    const now = new Date().toISOString();
    await db
      .insertInto("stripe_subscriptions")
      .values({
        id: "sub_unpaid_1",
        stripe_subscription_id: "sub_stripe_unpaid_1",
        stripe_customer_id: "cus_unpaid_1",
        user_id: "user-unpaid",
        status: "unpaid",
        price_id: "price_pro",
        product_id: "prod_pro",
        quantity: 1,
        current_period_start: now,
        current_period_end: now,
        cancel_at_period_end: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();

    expect(await stripe.hasActiveSubscription("user-unpaid")).toBe(false);
  });
});

describe("Stripe Plugin - Get Subscriptions", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let mockStripe: ReturnType<typeof createMockStripe>;

  beforeEach(async () => {
    mockStripe = createMockStripe();
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createMockStripePlugin(mockStripe));
    await manager.init();
  });

  it("should return empty array for user without subscriptions", async () => {
    const stripe = manager.getServices().stripe;

    const subscriptions = await stripe.getSubscriptions("no-subs-user");

    expect(subscriptions).toEqual([]);
  });

  it("should exclude ended subscriptions by default", async () => {
    const stripe = manager.getServices().stripe;

    const now = new Date().toISOString();

    // Active subscription
    await db
      .insertInto("stripe_subscriptions")
      .values({
        id: "sub_active_1",
        stripe_subscription_id: "sub_stripe_active_1",
        stripe_customer_id: "cus_1",
        user_id: "user-mixed-subs",
        status: "active",
        price_id: "price_pro",
        product_id: "prod_pro",
        quantity: 1,
        current_period_start: now,
        current_period_end: now,
        cancel_at_period_end: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();

    // Ended subscription
    await db
      .insertInto("stripe_subscriptions")
      .values({
        id: "sub_ended_1",
        stripe_subscription_id: "sub_stripe_ended_1",
        stripe_customer_id: "cus_1",
        user_id: "user-mixed-subs",
        status: "canceled",
        price_id: "price_basic",
        product_id: "prod_basic",
        quantity: 1,
        current_period_start: now,
        current_period_end: now,
        cancel_at_period_end: 0,
        ended_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const subscriptions = await stripe.getSubscriptions("user-mixed-subs");
    expect(subscriptions.length).toBe(1);
    expect(subscriptions[0].stripeSubscriptionId).toBe("sub_stripe_active_1");
  });

  it("should include ended subscriptions when option is set", async () => {
    const stripe = manager.getServices().stripe;

    const now = new Date().toISOString();

    await db
      .insertInto("stripe_subscriptions")
      .values({
        id: "sub_active_2",
        stripe_subscription_id: "sub_stripe_active_2",
        stripe_customer_id: "cus_2",
        user_id: "user-include-ended",
        status: "active",
        price_id: "price_pro",
        product_id: "prod_pro",
        quantity: 1,
        current_period_start: now,
        current_period_end: now,
        cancel_at_period_end: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await db
      .insertInto("stripe_subscriptions")
      .values({
        id: "sub_ended_2",
        stripe_subscription_id: "sub_stripe_ended_2",
        stripe_customer_id: "cus_2",
        user_id: "user-include-ended",
        status: "canceled",
        price_id: "price_basic",
        product_id: "prod_basic",
        quantity: 1,
        current_period_start: now,
        current_period_end: now,
        cancel_at_period_end: 0,
        ended_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const subscriptions = await stripe.getSubscriptions("user-include-ended", {
      includeEnded: true,
    });
    expect(subscriptions.length).toBe(2);
  });

  it("should return most recent subscription first", async () => {
    const stripe = manager.getServices().stripe;

    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const newDate = new Date().toISOString();

    await db
      .insertInto("stripe_subscriptions")
      .values({
        id: "sub_old",
        stripe_subscription_id: "sub_stripe_old",
        stripe_customer_id: "cus_order",
        user_id: "user-order-test",
        status: "active",
        price_id: "price_basic",
        product_id: "prod_basic",
        quantity: 1,
        current_period_start: oldDate,
        current_period_end: oldDate,
        cancel_at_period_end: 0,
        created_at: oldDate,
        updated_at: oldDate,
      })
      .execute();

    await db
      .insertInto("stripe_subscriptions")
      .values({
        id: "sub_new",
        stripe_subscription_id: "sub_stripe_new",
        stripe_customer_id: "cus_order",
        user_id: "user-order-test",
        status: "active",
        price_id: "price_pro",
        product_id: "prod_pro",
        quantity: 1,
        current_period_start: newDate,
        current_period_end: newDate,
        cancel_at_period_end: 0,
        created_at: newDate,
        updated_at: newDate,
      })
      .execute();

    const subscriptions = await stripe.getSubscriptions("user-order-test");
    expect(subscriptions[0].stripeSubscriptionId).toBe("sub_stripe_new");
    expect(subscriptions[1].stripeSubscriptionId).toBe("sub_stripe_old");
  });
});

describe("Stripe Plugin - Subscription Quantity", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let mockStripe: ReturnType<typeof createMockStripe>;

  beforeEach(async () => {
    mockStripe = createMockStripe();
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createMockStripePlugin(mockStripe));
    await manager.init();
  });

  it("should store subscription quantity", async () => {
    const stripe = manager.getServices().stripe;

    const now = new Date().toISOString();
    await db
      .insertInto("stripe_subscriptions")
      .values({
        id: "sub_qty",
        stripe_subscription_id: "sub_stripe_qty",
        stripe_customer_id: "cus_qty",
        user_id: "user-quantity",
        status: "active",
        price_id: "price_seats",
        product_id: "prod_seats",
        quantity: 10,
        current_period_start: now,
        current_period_end: now,
        cancel_at_period_end: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const subscription = await stripe.getSubscription("user-quantity");
    expect(subscription?.quantity).toBe(10);
  });
});

describe("Stripe Plugin - Customer Delete Options", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let mockStripe: ReturnType<typeof createMockStripe>;

  beforeEach(async () => {
    mockStripe = createMockStripe();
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createMockStripePlugin(mockStripe));
    await manager.init();
  });

  it("should soft delete by default", async () => {
    const stripe = manager.getServices().stripe;

    await stripe.getOrCreateCustomer({
      userId: "user-soft-delete",
      email: "softdelete@example.com",
    });

    await stripe.deleteCustomer("user-soft-delete");

    // Should not be retrievable via service
    const retrieved = await stripe.getCustomerByUserId("user-soft-delete");
    expect(retrieved).toBeNull();

    // But should still exist in DB with deleted_at set
    const dbRecord = await db
      .selectFrom("stripe_customers")
      .selectAll()
      .where("user_id", "=", "user-soft-delete")
      .executeTakeFirst();

    expect(dbRecord).toBeDefined();
    expect(dbRecord?.deleted_at).not.toBeNull();
  });

  it("should call Stripe API when deleteInStripe option is set", async () => {
    const stripe = manager.getServices().stripe;

    const customer = await stripe.getOrCreateCustomer({
      userId: "user-stripe-delete",
      email: "stripedelete@example.com",
    });

    // Verify customer exists in mock Stripe
    expect(mockStripe._state.customers.has(customer.stripeCustomerId)).toBe(true);

    await stripe.deleteCustomer("user-stripe-delete", { deleteInStripe: true });

    // Customer should be marked as deleted in mock Stripe
    const stripeCustomer = mockStripe._state.customers.get(customer.stripeCustomerId);
    expect(stripeCustomer?.deleted).toBe(true);
  });
});
