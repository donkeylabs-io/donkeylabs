/**
 * Stripe Plugin
 *
 * Flexible Stripe integration with customer management, subscriptions,
 * checkout sessions, webhook handling, and usage-based billing.
 */

import { createPlugin } from "@donkeylabs/server";
import Stripe from "stripe";
import type { DB } from "./schema";
import type {
  StripeConfig,
  StripeService,
  CustomerRecord,
  SubscriptionRecord,
  SubscriptionStatus,
  GetOrCreateCustomerParams,
  UpdateCustomerParams,
  DeleteCustomerOptions,
  CreateSubscriptionCheckoutParams,
  CreatePaymentCheckoutParams,
  CheckoutResult,
  GetSubscriptionsOptions,
  CancelSubscriptionOptions,
  PauseSubscriptionOptions,
  ChangeSubscriptionParams,
  ReportUsageParams,
  CreatePortalSessionOptions,
  PortalSessionResult,
  WebhookResult,
  UpcomingInvoice,
  RequirePlanConfig,
} from "./types";

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function timestampToISO(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString();
}

export const stripePlugin = createPlugin
  .withSchema<DB>()
  .withConfig<StripeConfig>()
  .define({
    name: "stripe",
    version: "1.0.0",

    events: {
      "stripe.customer.created": {
        schema: {
          userId: "string",
          stripeCustomerId: "string",
        },
      },
      "stripe.subscription.created": {
        schema: {
          userId: "string",
          subscriptionId: "string",
          productId: "string",
          status: "string",
        },
      },
      "stripe.subscription.updated": {
        schema: {
          userId: "string",
          subscriptionId: "string",
          status: "string",
          previousStatus: "string",
        },
      },
      "stripe.subscription.canceled": {
        schema: {
          userId: "string",
          subscriptionId: "string",
          endsAt: "string",
        },
      },
      "stripe.payment.succeeded": {
        schema: {
          userId: "string",
          amount: "number",
          currency: "string",
        },
      },
      "stripe.payment.failed": {
        schema: {
          userId: "string",
          error: "string",
        },
      },
      "stripe.trial.ending": {
        schema: {
          userId: "string",
          subscriptionId: "string",
          trialEndsAt: "string",
        },
      },
    },

    customErrors: {
      CustomerNotFound: {
        status: 404,
        code: "STRIPE_CUSTOMER_NOT_FOUND",
        message: "Stripe customer not found",
      },
      SubscriptionNotFound: {
        status: 404,
        code: "STRIPE_SUBSCRIPTION_NOT_FOUND",
        message: "Subscription not found",
      },
      SubscriptionRequired: {
        status: 403,
        code: "STRIPE_SUBSCRIPTION_REQUIRED",
        message: "Active subscription required",
      },
      PaymentFailed: {
        status: 402,
        code: "STRIPE_PAYMENT_FAILED",
        message: "Payment processing failed",
      },
      WebhookVerificationFailed: {
        status: 400,
        code: "STRIPE_WEBHOOK_VERIFICATION_FAILED",
        message: "Invalid webhook signature",
      },
      StripeApiError: {
        status: 502,
        code: "STRIPE_API_ERROR",
        message: "Stripe API error",
      },
      CheckoutNotConfigured: {
        status: 500,
        code: "STRIPE_CHECKOUT_NOT_CONFIGURED",
        message: "Checkout URLs not configured",
      },
      PortalNotConfigured: {
        status: 500,
        code: "STRIPE_PORTAL_NOT_CONFIGURED",
        message: "Portal return URL not configured",
      },
    },

    middleware: {
      requireSubscription: async (req, ctx, next) => {
        const userId = (ctx as any).userId;
        if (!userId) {
          throw ctx.core.errors.Unauthorized("User not authenticated");
        }

        const hasActive = await ctx.plugins.stripe.hasActiveSubscription(userId);
        if (!hasActive) {
          throw ctx.core.errors.SubscriptionRequired();
        }

        return next();
      },

      requirePlan: async (req, ctx, next, config: RequirePlanConfig) => {
        const userId = (ctx as any).userId;
        if (!userId) {
          throw ctx.core.errors.Unauthorized("User not authenticated");
        }

        const hasPlan = await ctx.plugins.stripe.hasPlan(userId, config.productId);
        if (!hasPlan) {
          throw ctx.core.errors.SubscriptionRequired(
            `Plan ${config.productId} required`
          );
        }

        return next();
      },
    },

    service: async (ctx): Promise<StripeService> => {
      const config = ctx.config;
      const db = ctx.db;
      const logger = ctx.core.logger.child({ plugin: "stripe" });

      const stripe = new Stripe(config.secretKey, {
        apiVersion: "2024-12-18.acacia",
      });

      // Helper to convert DB row to CustomerRecord
      function toCustomerRecord(row: any): CustomerRecord {
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

      // Helper to convert DB row to SubscriptionRecord
      function toSubscriptionRecord(row: any): SubscriptionRecord {
        return {
          id: row.id,
          stripeSubscriptionId: row.stripe_subscription_id,
          stripeCustomerId: row.stripe_customer_id,
          userId: row.user_id,
          status: row.status as SubscriptionStatus,
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

      // Helper to get active subscription statuses
      const ACTIVE_STATUSES: SubscriptionStatus[] = ["active", "trialing"];

      return {
        // =====================================================================
        // CUSTOMER MANAGEMENT
        // =====================================================================

        async getOrCreateCustomer(
          params: GetOrCreateCustomerParams
        ): Promise<CustomerRecord> {
          const { userId, email, name, metadata } = params;

          // Check for existing customer
          const existing = await db
            .selectFrom("stripe_customers")
            .selectAll()
            .where("user_id", "=", userId)
            .where("deleted_at", "is", null)
            .executeTakeFirst();

          if (existing) {
            return toCustomerRecord(existing);
          }

          // Create customer in Stripe
          let stripeCustomer: Stripe.Customer;
          try {
            stripeCustomer = await stripe.customers.create({
              email,
              name,
              metadata: {
                ...metadata,
                userId,
              },
            });
          } catch (error) {
            logger.error({ error, userId }, "Failed to create Stripe customer");
            throw ctx.core.errors.StripeApiError(
              error instanceof Error ? error.message : "Failed to create customer"
            );
          }

          // Store in database
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

          ctx.core.events.emit("stripe.customer.created", {
            userId,
            stripeCustomerId: stripeCustomer.id,
          });

          logger.info({ userId, stripeCustomerId: stripeCustomer.id }, "Customer created");

          return toCustomerRecord(record);
        },

        async getCustomerByUserId(userId: string): Promise<CustomerRecord | null> {
          const row = await db
            .selectFrom("stripe_customers")
            .selectAll()
            .where("user_id", "=", userId)
            .where("deleted_at", "is", null)
            .executeTakeFirst();

          return row ? toCustomerRecord(row) : null;
        },

        async updateCustomer(
          userId: string,
          params: UpdateCustomerParams
        ): Promise<CustomerRecord> {
          const customer = await this.getCustomerByUserId(userId);
          if (!customer) {
            throw ctx.core.errors.CustomerNotFound();
          }

          // Update in Stripe
          try {
            await stripe.customers.update(customer.stripeCustomerId, {
              email: params.email,
              name: params.name,
              metadata: params.metadata,
            });
          } catch (error) {
            logger.error({ error, userId }, "Failed to update Stripe customer");
            throw ctx.core.errors.StripeApiError(
              error instanceof Error ? error.message : "Failed to update customer"
            );
          }

          // Update in database
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

        async deleteCustomer(
          userId: string,
          options?: DeleteCustomerOptions
        ): Promise<void> {
          const customer = await this.getCustomerByUserId(userId);
          if (!customer) {
            throw ctx.core.errors.CustomerNotFound();
          }

          if (options?.deleteInStripe) {
            try {
              await stripe.customers.del(customer.stripeCustomerId);
            } catch (error) {
              logger.warn({ error, userId }, "Failed to delete customer in Stripe");
            }
          }

          // Soft delete in database
          const now = new Date().toISOString();
          await db
            .updateTable("stripe_customers")
            .set({ deleted_at: now, updated_at: now })
            .where("user_id", "=", userId)
            .execute();

          logger.info({ userId }, "Customer deleted");
        },

        // =====================================================================
        // CHECKOUT SESSIONS
        // =====================================================================

        async createSubscriptionCheckout(
          params: CreateSubscriptionCheckoutParams
        ): Promise<CheckoutResult> {
          const {
            userId,
            priceId,
            quantity = 1,
            trialDays,
            metadata,
            successUrl,
            cancelUrl,
            allowPromotionCodes,
          } = params;

          const checkoutSuccessUrl = successUrl || config.checkout?.successUrl;
          const checkoutCancelUrl = cancelUrl || config.checkout?.cancelUrl;

          if (!checkoutSuccessUrl || !checkoutCancelUrl) {
            throw ctx.core.errors.CheckoutNotConfigured();
          }

          // Get or create customer
          const customer = await this.getCustomerByUserId(userId);
          if (!customer) {
            throw ctx.core.errors.CustomerNotFound(
              "Customer must be created before checkout"
            );
          }

          try {
            const session = await stripe.checkout.sessions.create({
              customer: customer.stripeCustomerId,
              mode: "subscription",
              line_items: [
                {
                  price: priceId,
                  quantity,
                },
              ],
              success_url: checkoutSuccessUrl,
              cancel_url: checkoutCancelUrl,
              allow_promotion_codes:
                allowPromotionCodes ?? config.checkout?.allowPromotionCodes ?? false,
              subscription_data: {
                trial_period_days: trialDays,
                metadata: {
                  ...metadata,
                  userId,
                },
              },
              metadata: {
                ...metadata,
                userId,
              },
            });

            logger.info({ userId, sessionId: session.id }, "Checkout session created");

            return {
              sessionId: session.id,
              url: session.url!,
            };
          } catch (error) {
            logger.error({ error, userId }, "Failed to create checkout session");
            throw ctx.core.errors.StripeApiError(
              error instanceof Error ? error.message : "Failed to create checkout"
            );
          }
        },

        async createPaymentCheckout(
          params: CreatePaymentCheckoutParams
        ): Promise<CheckoutResult> {
          const { userId, lineItems, metadata, successUrl, cancelUrl } = params;

          const checkoutSuccessUrl = successUrl || config.checkout?.successUrl;
          const checkoutCancelUrl = cancelUrl || config.checkout?.cancelUrl;

          if (!checkoutSuccessUrl || !checkoutCancelUrl) {
            throw ctx.core.errors.CheckoutNotConfigured();
          }

          const customer = await this.getCustomerByUserId(userId);
          if (!customer) {
            throw ctx.core.errors.CustomerNotFound(
              "Customer must be created before checkout"
            );
          }

          try {
            const session = await stripe.checkout.sessions.create({
              customer: customer.stripeCustomerId,
              mode: "payment",
              line_items: lineItems.map((item) => ({
                price: item.priceId,
                quantity: item.quantity,
              })),
              success_url: checkoutSuccessUrl,
              cancel_url: checkoutCancelUrl,
              metadata: {
                ...metadata,
                userId,
              },
            });

            logger.info({ userId, sessionId: session.id }, "Payment checkout created");

            return {
              sessionId: session.id,
              url: session.url!,
            };
          } catch (error) {
            logger.error({ error, userId }, "Failed to create payment checkout");
            throw ctx.core.errors.StripeApiError(
              error instanceof Error ? error.message : "Failed to create checkout"
            );
          }
        },

        // =====================================================================
        // SUBSCRIPTION MANAGEMENT
        // =====================================================================

        async getSubscription(userId: string): Promise<SubscriptionRecord | null> {
          const row = await db
            .selectFrom("stripe_subscriptions")
            .selectAll()
            .where("user_id", "=", userId)
            .where("status", "in", ACTIVE_STATUSES)
            .orderBy("created_at", "desc")
            .executeTakeFirst();

          return row ? toSubscriptionRecord(row) : null;
        },

        async getSubscriptions(
          userId: string,
          options?: GetSubscriptionsOptions
        ): Promise<SubscriptionRecord[]> {
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

        async cancelSubscription(
          userId: string,
          options?: CancelSubscriptionOptions
        ): Promise<SubscriptionRecord> {
          const subscription = await this.getSubscription(userId);
          if (!subscription) {
            throw ctx.core.errors.SubscriptionNotFound();
          }

          try {
            if (options?.immediately) {
              await stripe.subscriptions.cancel(subscription.stripeSubscriptionId);
            } else {
              await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
                cancel_at_period_end: true,
              });
            }
          } catch (error) {
            logger.error({ error, userId }, "Failed to cancel subscription");
            throw ctx.core.errors.StripeApiError(
              error instanceof Error ? error.message : "Failed to cancel"
            );
          }

          // Sync from Stripe to get updated state
          return await this.syncSubscription(subscription.stripeSubscriptionId);
        },

        async resumeSubscription(userId: string): Promise<SubscriptionRecord> {
          const subscription = await this.getSubscription(userId);
          if (!subscription) {
            throw ctx.core.errors.SubscriptionNotFound();
          }

          if (!subscription.cancelAtPeriodEnd) {
            return subscription;
          }

          try {
            await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
              cancel_at_period_end: false,
            });
          } catch (error) {
            logger.error({ error, userId }, "Failed to resume subscription");
            throw ctx.core.errors.StripeApiError(
              error instanceof Error ? error.message : "Failed to resume"
            );
          }

          return await this.syncSubscription(subscription.stripeSubscriptionId);
        },

        async pauseSubscription(
          userId: string,
          options?: PauseSubscriptionOptions
        ): Promise<SubscriptionRecord> {
          const subscription = await this.getSubscription(userId);
          if (!subscription) {
            throw ctx.core.errors.SubscriptionNotFound();
          }

          try {
            await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
              pause_collection: {
                behavior: options?.behavior || "mark_uncollectible",
                resumes_at: options?.resumesAt
                  ? Math.floor(options.resumesAt.getTime() / 1000)
                  : undefined,
              },
            });
          } catch (error) {
            logger.error({ error, userId }, "Failed to pause subscription");
            throw ctx.core.errors.StripeApiError(
              error instanceof Error ? error.message : "Failed to pause"
            );
          }

          return await this.syncSubscription(subscription.stripeSubscriptionId);
        },

        async unpauseSubscription(userId: string): Promise<SubscriptionRecord> {
          const subscription = await this.getSubscription(userId);
          if (!subscription) {
            throw ctx.core.errors.SubscriptionNotFound();
          }

          try {
            await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
              pause_collection: null,
            });
          } catch (error) {
            logger.error({ error, userId }, "Failed to unpause subscription");
            throw ctx.core.errors.StripeApiError(
              error instanceof Error ? error.message : "Failed to unpause"
            );
          }

          return await this.syncSubscription(subscription.stripeSubscriptionId);
        },

        async changeSubscription(
          userId: string,
          params: ChangeSubscriptionParams
        ): Promise<SubscriptionRecord> {
          const subscription = await this.getSubscription(userId);
          if (!subscription) {
            throw ctx.core.errors.SubscriptionNotFound();
          }

          try {
            // Get current subscription items
            const stripeSub = await stripe.subscriptions.retrieve(
              subscription.stripeSubscriptionId
            );
            const itemId = stripeSub.items.data[0]?.id;

            if (!itemId) {
              throw new Error("No subscription item found");
            }

            await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
              items: [
                {
                  id: itemId,
                  price: params.newPriceId,
                },
              ],
              proration_behavior: params.prorationBehavior || "create_prorations",
            });
          } catch (error) {
            logger.error({ error, userId }, "Failed to change subscription");
            throw ctx.core.errors.StripeApiError(
              error instanceof Error ? error.message : "Failed to change plan"
            );
          }

          return await this.syncSubscription(subscription.stripeSubscriptionId);
        },

        async updateSubscriptionQuantity(
          userId: string,
          quantity: number
        ): Promise<SubscriptionRecord> {
          const subscription = await this.getSubscription(userId);
          if (!subscription) {
            throw ctx.core.errors.SubscriptionNotFound();
          }

          try {
            const stripeSub = await stripe.subscriptions.retrieve(
              subscription.stripeSubscriptionId
            );
            const itemId = stripeSub.items.data[0]?.id;

            if (!itemId) {
              throw new Error("No subscription item found");
            }

            await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
              items: [
                {
                  id: itemId,
                  quantity,
                },
              ],
            });
          } catch (error) {
            logger.error({ error, userId }, "Failed to update quantity");
            throw ctx.core.errors.StripeApiError(
              error instanceof Error ? error.message : "Failed to update quantity"
            );
          }

          return await this.syncSubscription(subscription.stripeSubscriptionId);
        },

        async hasActiveSubscription(userId: string): Promise<boolean> {
          const count = await db
            .selectFrom("stripe_subscriptions")
            .select((eb) => eb.fn.count("id").as("count"))
            .where("user_id", "=", userId)
            .where("status", "in", ACTIVE_STATUSES)
            .executeTakeFirst();

          return Number(count?.count || 0) > 0;
        },

        async hasPlan(userId: string, productIdOrPriceId: string): Promise<boolean> {
          const count = await db
            .selectFrom("stripe_subscriptions")
            .select((eb) => eb.fn.count("id").as("count"))
            .where("user_id", "=", userId)
            .where("status", "in", ACTIVE_STATUSES)
            .where((eb) =>
              eb.or([
                eb("product_id", "=", productIdOrPriceId),
                eb("price_id", "=", productIdOrPriceId),
              ])
            )
            .executeTakeFirst();

          return Number(count?.count || 0) > 0;
        },

        // =====================================================================
        // PORTAL & BILLING
        // =====================================================================

        async createPortalSession(
          userId: string,
          options?: CreatePortalSessionOptions
        ): Promise<PortalSessionResult> {
          const returnUrl = options?.returnUrl || config.portal?.returnUrl;
          if (!returnUrl) {
            throw ctx.core.errors.PortalNotConfigured();
          }

          const customer = await this.getCustomerByUserId(userId);
          if (!customer) {
            throw ctx.core.errors.CustomerNotFound();
          }

          try {
            const session = await stripe.billingPortal.sessions.create({
              customer: customer.stripeCustomerId,
              return_url: returnUrl,
            });

            return { url: session.url };
          } catch (error) {
            logger.error({ error, userId }, "Failed to create portal session");
            throw ctx.core.errors.StripeApiError(
              error instanceof Error ? error.message : "Failed to create portal"
            );
          }
        },

        async reportUsage(params: ReportUsageParams): Promise<void> {
          const { userId, value, meterId, timestamp } = params;

          const meterIdToUse = meterId || config.billing?.defaultMeterId;
          if (!meterIdToUse) {
            throw ctx.core.errors.StripeApiError("No meter ID configured or provided");
          }

          const customer = await this.getCustomerByUserId(userId);
          if (!customer) {
            throw ctx.core.errors.CustomerNotFound();
          }

          try {
            await stripe.billing.meterEvents.create({
              event_name: meterIdToUse,
              payload: {
                stripe_customer_id: customer.stripeCustomerId,
                value: String(value),
              },
              timestamp: timestamp
                ? Math.floor(timestamp.getTime() / 1000)
                : undefined,
            });

            logger.debug({ userId, meterId: meterIdToUse, value }, "Usage reported");
          } catch (error) {
            logger.error({ error, userId }, "Failed to report usage");
            throw ctx.core.errors.StripeApiError(
              error instanceof Error ? error.message : "Failed to report usage"
            );
          }
        },

        async getUpcomingInvoice(userId: string): Promise<UpcomingInvoice | null> {
          const customer = await this.getCustomerByUserId(userId);
          if (!customer) {
            return null;
          }

          try {
            const invoice = await stripe.invoices.retrieveUpcoming({
              customer: customer.stripeCustomerId,
            });

            return {
              amountDue: invoice.amount_due,
              currency: invoice.currency,
              periodStart: timestampToISO(invoice.period_start),
              periodEnd: timestampToISO(invoice.period_end),
              lines: invoice.lines.data.map((line) => ({
                description: line.description || "",
                amount: line.amount,
                quantity: line.quantity || 1,
              })),
            };
          } catch (error) {
            // No upcoming invoice is not an error
            if (
              error instanceof Stripe.errors.StripeInvalidRequestError &&
              error.code === "invoice_upcoming_none"
            ) {
              return null;
            }
            logger.error({ error, userId }, "Failed to get upcoming invoice");
            throw ctx.core.errors.StripeApiError(
              error instanceof Error ? error.message : "Failed to get invoice"
            );
          }
        },

        // =====================================================================
        // WEBHOOKS
        // =====================================================================

        async handleWebhook(
          payload: string | Buffer,
          signature: string
        ): Promise<WebhookResult> {
          let event: Stripe.Event;

          try {
            event = stripe.webhooks.constructEvent(
              payload,
              signature,
              config.webhookSecret
            );
          } catch (error) {
            logger.warn({ error }, "Webhook verification failed");
            throw ctx.core.errors.WebhookVerificationFailed();
          }

          // Check if already processed (idempotency)
          const existing = await db
            .selectFrom("stripe_webhook_events")
            .selectAll()
            .where("stripe_event_id", "=", event.id)
            .executeTakeFirst();

          if (existing) {
            logger.debug({ eventId: event.id }, "Event already processed");
            return {
              processed: false,
              eventId: event.id,
              eventType: event.type,
            };
          }

          // Record event immediately
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

          try {
            // Process the event
            await this._processWebhookEvent(event);

            // Mark as processed
            await db
              .updateTable("stripe_webhook_events")
              .set({ status: "processed" })
              .where("id", "=", eventRecordId)
              .execute();

            logger.info({ eventId: event.id, type: event.type }, "Webhook processed");

            return {
              processed: true,
              eventId: event.id,
              eventType: event.type,
            };
          } catch (error) {
            // Mark as failed
            await db
              .updateTable("stripe_webhook_events")
              .set({
                status: "failed",
                error: error instanceof Error ? error.message : "Unknown error",
              })
              .where("id", "=", eventRecordId)
              .execute();

            logger.error({ error, eventId: event.id }, "Webhook processing failed");
            throw error;
          }
        },

        async _processWebhookEvent(event: Stripe.Event): Promise<void> {
          switch (event.type) {
            case "customer.subscription.created":
            case "customer.subscription.updated": {
              const subscription = event.data.object as Stripe.Subscription;
              await this.syncSubscription(subscription.id);
              break;
            }

            case "customer.subscription.deleted": {
              const subscription = event.data.object as Stripe.Subscription;
              await this.syncSubscription(subscription.id);

              // Find userId from our records
              const record = await db
                .selectFrom("stripe_subscriptions")
                .select(["user_id"])
                .where("stripe_subscription_id", "=", subscription.id)
                .executeTakeFirst();

              if (record) {
                ctx.core.events.emit("stripe.subscription.canceled", {
                  userId: record.user_id,
                  subscriptionId: subscription.id,
                  endsAt: timestampToISO(subscription.current_period_end),
                });
              }
              break;
            }

            case "customer.subscription.trial_will_end": {
              const subscription = event.data.object as Stripe.Subscription;
              const record = await db
                .selectFrom("stripe_subscriptions")
                .select(["user_id"])
                .where("stripe_subscription_id", "=", subscription.id)
                .executeTakeFirst();

              if (record && subscription.trial_end) {
                ctx.core.events.emit("stripe.trial.ending", {
                  userId: record.user_id,
                  subscriptionId: subscription.id,
                  trialEndsAt: timestampToISO(subscription.trial_end),
                });
              }
              break;
            }

            case "checkout.session.completed": {
              const session = event.data.object as Stripe.Checkout.Session;
              if (session.subscription && typeof session.subscription === "string") {
                await this.syncSubscription(session.subscription);
              }
              break;
            }

            case "invoice.paid": {
              const invoice = event.data.object as Stripe.Invoice;
              const customerId =
                typeof invoice.customer === "string"
                  ? invoice.customer
                  : invoice.customer?.id;

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

            case "invoice.payment_failed": {
              const invoice = event.data.object as Stripe.Invoice;
              const customerId =
                typeof invoice.customer === "string"
                  ? invoice.customer
                  : invoice.customer?.id;

              if (customerId) {
                const customer = await db
                  .selectFrom("stripe_customers")
                  .select(["user_id"])
                  .where("stripe_customer_id", "=", customerId)
                  .executeTakeFirst();

                if (customer) {
                  ctx.core.events.emit("stripe.payment.failed", {
                    userId: customer.user_id,
                    error: invoice.last_finalization_error?.message || "Payment failed",
                  });
                }
              }
              break;
            }

            case "customer.created":
            case "customer.updated": {
              const customer = event.data.object as Stripe.Customer;
              await this.syncCustomer(customer.id);
              break;
            }

            case "customer.deleted": {
              const customer = event.data.object as Stripe.Customer;
              const now = new Date().toISOString();
              await db
                .updateTable("stripe_customers")
                .set({ deleted_at: now, updated_at: now })
                .where("stripe_customer_id", "=", customer.id)
                .execute();
              break;
            }

            default:
              logger.debug({ type: event.type }, "Unhandled webhook event type");
          }
        },

        async isEventProcessed(eventId: string): Promise<boolean> {
          const event = await db
            .selectFrom("stripe_webhook_events")
            .select(["id"])
            .where("stripe_event_id", "=", eventId)
            .executeTakeFirst();

          return !!event;
        },

        // =====================================================================
        // SYNC
        // =====================================================================

        async syncSubscription(stripeSubscriptionId: string): Promise<SubscriptionRecord> {
          let stripeSub: Stripe.Subscription;

          try {
            stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId, {
              expand: ["items.data.price.product"],
            });
          } catch (error) {
            logger.error({ error, stripeSubscriptionId }, "Failed to fetch subscription");
            throw ctx.core.errors.StripeApiError(
              error instanceof Error ? error.message : "Failed to fetch subscription"
            );
          }

          // Get customer info to find userId
          const customer = await db
            .selectFrom("stripe_customers")
            .select(["user_id"])
            .where(
              "stripe_customer_id",
              "=",
              typeof stripeSub.customer === "string"
                ? stripeSub.customer
                : stripeSub.customer.id
            )
            .executeTakeFirst();

          if (!customer) {
            throw ctx.core.errors.CustomerNotFound(
              "Customer not found for subscription"
            );
          }

          const item = stripeSub.items.data[0];
          const price = item?.price;
          const product =
            typeof price?.product === "object" ? price.product : null;

          const now = new Date().toISOString();
          const existingRow = await db
            .selectFrom("stripe_subscriptions")
            .selectAll()
            .where("stripe_subscription_id", "=", stripeSubscriptionId)
            .executeTakeFirst();

          const subscriptionData = {
            stripe_subscription_id: stripeSubscriptionId,
            stripe_customer_id:
              typeof stripeSub.customer === "string"
                ? stripeSub.customer
                : stripeSub.customer.id,
            user_id: customer.user_id,
            status: stripeSub.status,
            price_id: price?.id || "",
            product_id: (product as Stripe.Product)?.id || "",
            quantity: item?.quantity || 1,
            current_period_start: timestampToISO(stripeSub.current_period_start),
            current_period_end: timestampToISO(stripeSub.current_period_end),
            cancel_at_period_end: stripeSub.cancel_at_period_end ? 1 : 0,
            canceled_at: stripeSub.canceled_at
              ? timestampToISO(stripeSub.canceled_at)
              : null,
            ended_at: stripeSub.ended_at
              ? timestampToISO(stripeSub.ended_at)
              : null,
            trial_start: stripeSub.trial_start
              ? timestampToISO(stripeSub.trial_start)
              : null,
            trial_end: stripeSub.trial_end
              ? timestampToISO(stripeSub.trial_end)
              : null,
            metadata: stripeSub.metadata
              ? JSON.stringify(stripeSub.metadata)
              : null,
            updated_at: now,
          };

          if (existingRow) {
            const previousStatus = existingRow.status;

            await db
              .updateTable("stripe_subscriptions")
              .set(subscriptionData)
              .where("stripe_subscription_id", "=", stripeSubscriptionId)
              .execute();

            if (previousStatus !== stripeSub.status) {
              ctx.core.events.emit("stripe.subscription.updated", {
                userId: customer.user_id,
                subscriptionId: stripeSubscriptionId,
                status: stripeSub.status,
                previousStatus,
              });
            }
          } else {
            const id = generateId("sub");
            await db
              .insertInto("stripe_subscriptions")
              .values({
                id,
                ...subscriptionData,
                created_at: now,
              })
              .execute();

            ctx.core.events.emit("stripe.subscription.created", {
              userId: customer.user_id,
              subscriptionId: stripeSubscriptionId,
              productId: (product as Stripe.Product)?.id || "",
              status: stripeSub.status,
            });
          }

          const row = await db
            .selectFrom("stripe_subscriptions")
            .selectAll()
            .where("stripe_subscription_id", "=", stripeSubscriptionId)
            .executeTakeFirstOrThrow();

          logger.info(
            { stripeSubscriptionId, status: stripeSub.status },
            "Subscription synced"
          );

          return toSubscriptionRecord(row);
        },

        async syncCustomer(stripeCustomerId: string): Promise<CustomerRecord> {
          let stripeCustomer: Stripe.Customer;

          try {
            stripeCustomer = (await stripe.customers.retrieve(
              stripeCustomerId
            )) as Stripe.Customer;
          } catch (error) {
            logger.error({ error, stripeCustomerId }, "Failed to fetch customer");
            throw ctx.core.errors.StripeApiError(
              error instanceof Error ? error.message : "Failed to fetch customer"
            );
          }

          if (stripeCustomer.deleted) {
            throw ctx.core.errors.CustomerNotFound("Customer was deleted in Stripe");
          }

          const now = new Date().toISOString();
          const existingRow = await db
            .selectFrom("stripe_customers")
            .selectAll()
            .where("stripe_customer_id", "=", stripeCustomerId)
            .executeTakeFirst();

          if (existingRow) {
            await db
              .updateTable("stripe_customers")
              .set({
                email: stripeCustomer.email,
                name: stripeCustomer.name,
                metadata: stripeCustomer.metadata
                  ? JSON.stringify(stripeCustomer.metadata)
                  : null,
                updated_at: now,
              })
              .where("stripe_customer_id", "=", stripeCustomerId)
              .execute();
          }

          const row = await db
            .selectFrom("stripe_customers")
            .selectAll()
            .where("stripe_customer_id", "=", stripeCustomerId)
            .executeTakeFirstOrThrow();

          logger.info({ stripeCustomerId }, "Customer synced");

          return toCustomerRecord(row);
        },
      } as StripeService & { _processWebhookEvent: (event: Stripe.Event) => Promise<void> };
    },

    init: async (ctx, service) => {
      const logger = ctx.core.logger.child({ plugin: "stripe" });

      // Register background job for async webhook processing
      ctx.core.jobs.register(
        "stripe.processWebhook",
        async (payload: { eventId: string; type: string; data: any }) => {
          logger.info({ eventId: payload.eventId }, "Processing webhook job");
        }
      );

      logger.info("Stripe plugin initialized");
    },
  });

export type { StripeConfig, StripeService, CustomerRecord, SubscriptionRecord } from "./types";
