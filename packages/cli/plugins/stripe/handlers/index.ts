/**
 * Stripe Plugin Handlers
 *
 * Reusable route handlers and schemas for Stripe operations.
 * Import these into your routes and compose as needed.
 *
 * @example
 * ```ts
 * import { createRouter } from "@donkeylabs/server";
 * import { stripeSchemas, createWebhookHandler } from "./plugins/stripe/handlers";
 *
 * const api = createRouter("api");
 *
 * api.route("stripe.createCheckout").typed({
 *   input: stripeSchemas.createCheckout.input,
 *   output: stripeSchemas.createCheckout.output,
 *   handle: async (input, ctx) => {
 *     return ctx.plugins.stripe.createSubscriptionCheckout({
 *       userId: ctx.userId,
 *       ...input,
 *     });
 *   },
 * });
 *
 * // Webhook endpoint (raw handler)
 * api.route("stripe.webhook").raw(createWebhookHandler());
 * ```
 */

import { z } from "zod";

// =============================================================================
// SHARED SCHEMAS
// =============================================================================

const subscriptionStatusSchema = z.enum([
  "active",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "past_due",
  "paused",
  "trialing",
  "unpaid",
]);

const customerRecordSchema = z.object({
  id: z.string(),
  userId: z.string(),
  stripeCustomerId: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  metadata: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

const subscriptionRecordSchema = z.object({
  id: z.string(),
  stripeSubscriptionId: z.string(),
  stripeCustomerId: z.string(),
  userId: z.string(),
  status: subscriptionStatusSchema,
  priceId: z.string(),
  productId: z.string(),
  quantity: z.number(),
  currentPeriodStart: z.string(),
  currentPeriodEnd: z.string(),
  cancelAtPeriodEnd: z.boolean(),
  canceledAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  trialStart: z.string().nullable(),
  trialEnd: z.string().nullable(),
  metadata: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const checkoutResultSchema = z.object({
  sessionId: z.string(),
  url: z.string(),
});

const portalResultSchema = z.object({
  url: z.string(),
});

const invoiceLineSchema = z.object({
  description: z.string(),
  amount: z.number(),
  quantity: z.number(),
});

const upcomingInvoiceSchema = z.object({
  amountDue: z.number(),
  currency: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  lines: z.array(invoiceLineSchema),
});

// =============================================================================
// ROUTE SCHEMAS
// =============================================================================

export const stripeSchemas = {
  // ---------------------------------------------------------------------------
  // Customer Management
  // ---------------------------------------------------------------------------

  /**
   * Create or get Stripe customer
   */
  getOrCreateCustomer: {
    input: z.object({
      email: z.string().email(),
      name: z.string().optional(),
      metadata: z.record(z.string()).optional(),
    }),
    output: customerRecordSchema,
  },

  /**
   * Get customer by user ID
   */
  getCustomer: {
    input: z.object({}),
    output: customerRecordSchema.nullable(),
  },

  /**
   * Update customer
   */
  updateCustomer: {
    input: z.object({
      email: z.string().email().optional(),
      name: z.string().optional(),
      metadata: z.record(z.string()).optional(),
    }),
    output: customerRecordSchema,
  },

  /**
   * Delete customer
   */
  deleteCustomer: {
    input: z.object({
      deleteInStripe: z.boolean().optional(),
    }),
    output: z.object({
      success: z.boolean(),
    }),
  },

  // ---------------------------------------------------------------------------
  // Checkout
  // ---------------------------------------------------------------------------

  /**
   * Create subscription checkout session
   */
  createSubscriptionCheckout: {
    input: z.object({
      priceId: z.string(),
      quantity: z.number().min(1).optional(),
      trialDays: z.number().min(1).max(730).optional(),
      metadata: z.record(z.string()).optional(),
      successUrl: z.string().url().optional(),
      cancelUrl: z.string().url().optional(),
      allowPromotionCodes: z.boolean().optional(),
    }),
    output: checkoutResultSchema,
  },

  /**
   * Create one-time payment checkout session
   */
  createPaymentCheckout: {
    input: z.object({
      lineItems: z.array(
        z.object({
          priceId: z.string(),
          quantity: z.number().min(1),
        })
      ),
      metadata: z.record(z.string()).optional(),
      successUrl: z.string().url().optional(),
      cancelUrl: z.string().url().optional(),
    }),
    output: checkoutResultSchema,
  },

  // ---------------------------------------------------------------------------
  // Subscription Management
  // ---------------------------------------------------------------------------

  /**
   * Get active subscription
   */
  getSubscription: {
    input: z.object({}),
    output: subscriptionRecordSchema.nullable(),
  },

  /**
   * Get all subscriptions
   */
  getSubscriptions: {
    input: z.object({
      includeEnded: z.boolean().optional(),
    }),
    output: z.array(subscriptionRecordSchema),
  },

  /**
   * Cancel subscription
   */
  cancelSubscription: {
    input: z.object({
      immediately: z.boolean().optional(),
    }),
    output: subscriptionRecordSchema,
  },

  /**
   * Resume subscription (before period end)
   */
  resumeSubscription: {
    input: z.object({}),
    output: subscriptionRecordSchema,
  },

  /**
   * Pause subscription
   */
  pauseSubscription: {
    input: z.object({
      resumesAt: z.string().datetime().optional(),
      behavior: z.enum(["mark_uncollectible", "void", "keep_as_draft"]).optional(),
    }),
    output: subscriptionRecordSchema,
  },

  /**
   * Unpause subscription
   */
  unpauseSubscription: {
    input: z.object({}),
    output: subscriptionRecordSchema,
  },

  /**
   * Change subscription plan
   */
  changeSubscription: {
    input: z.object({
      newPriceId: z.string(),
      prorationBehavior: z
        .enum(["create_prorations", "none", "always_invoice"])
        .optional(),
    }),
    output: subscriptionRecordSchema,
  },

  /**
   * Update subscription quantity (seats)
   */
  updateQuantity: {
    input: z.object({
      quantity: z.number().min(1),
    }),
    output: subscriptionRecordSchema,
  },

  /**
   * Check if user has active subscription
   */
  hasActiveSubscription: {
    input: z.object({}),
    output: z.object({
      hasSubscription: z.boolean(),
    }),
  },

  /**
   * Check if user has specific plan
   */
  hasPlan: {
    input: z.object({
      productIdOrPriceId: z.string(),
    }),
    output: z.object({
      hasPlan: z.boolean(),
    }),
  },

  // ---------------------------------------------------------------------------
  // Portal & Billing
  // ---------------------------------------------------------------------------

  /**
   * Create customer portal session
   */
  createPortalSession: {
    input: z.object({
      returnUrl: z.string().url().optional(),
    }),
    output: portalResultSchema,
  },

  /**
   * Report usage for metered billing
   */
  reportUsage: {
    input: z.object({
      value: z.number(),
      meterId: z.string().optional(),
      timestamp: z.string().datetime().optional(),
    }),
    output: z.object({
      success: z.boolean(),
    }),
  },

  /**
   * Get upcoming invoice preview
   */
  getUpcomingInvoice: {
    input: z.object({}),
    output: upcomingInvoiceSchema.nullable(),
  },

  // ---------------------------------------------------------------------------
  // Webhook
  // ---------------------------------------------------------------------------

  /**
   * Webhook response schema (for documentation)
   */
  webhook: {
    output: z.object({
      received: z.boolean(),
      eventId: z.string().optional(),
      eventType: z.string().optional(),
    }),
  },

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  /**
   * Force sync subscription from Stripe
   */
  syncSubscription: {
    input: z.object({
      stripeSubscriptionId: z.string(),
    }),
    output: subscriptionRecordSchema,
  },

  /**
   * Force sync customer from Stripe
   */
  syncCustomer: {
    input: z.object({
      stripeCustomerId: z.string(),
    }),
    output: customerRecordSchema,
  },
} as const;

// =============================================================================
// WEBHOOK HANDLER
// =============================================================================

/**
 * Create a raw webhook handler for Stripe webhooks.
 *
 * @example
 * ```ts
 * import { createRouter } from "@donkeylabs/server";
 * import { createWebhookHandler } from "./plugins/stripe/handlers";
 *
 * const api = createRouter("api");
 *
 * // Must be raw to access raw body for signature verification
 * api.route("stripe.webhook").raw(createWebhookHandler());
 * ```
 */
export function createWebhookHandler() {
  return async (req: Request, ctx: any): Promise<Response> => {
    const signature = req.headers.get("stripe-signature");

    if (!signature) {
      return new Response(
        JSON.stringify({ error: "Missing stripe-signature header" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    try {
      const body = await req.text();
      const result = await ctx.plugins.stripe.handleWebhook(body, signature);

      return new Response(
        JSON.stringify({
          received: true,
          eventId: result.eventId,
          eventType: result.eventType,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Webhook failed";
      const status =
        error instanceof Error && "status" in error
          ? (error as any).status
          : 500;

      return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
  };
}

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;
export type CustomerRecord = z.infer<typeof customerRecordSchema>;
export type SubscriptionRecord = z.infer<typeof subscriptionRecordSchema>;
export type CheckoutResult = z.infer<typeof checkoutResultSchema>;
export type PortalResult = z.infer<typeof portalResultSchema>;
export type UpcomingInvoice = z.infer<typeof upcomingInvoiceSchema>;

export type CreateSubscriptionCheckoutInput = z.infer<
  typeof stripeSchemas.createSubscriptionCheckout.input
>;
export type CreatePaymentCheckoutInput = z.infer<
  typeof stripeSchemas.createPaymentCheckout.input
>;
export type CancelSubscriptionInput = z.infer<
  typeof stripeSchemas.cancelSubscription.input
>;
export type ChangeSubscriptionInput = z.infer<
  typeof stripeSchemas.changeSubscription.input
>;
export type ReportUsageInput = z.infer<typeof stripeSchemas.reportUsage.input>;
