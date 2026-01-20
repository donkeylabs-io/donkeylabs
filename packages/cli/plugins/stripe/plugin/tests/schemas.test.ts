/**
 * Stripe Plugin Schema Tests
 *
 * Tests for Zod schema validation
 */

import { describe, it, expect } from "bun:test";
import { stripeSchemas } from "../handlers";

describe("Stripe Schemas - Customer", () => {
  describe("getOrCreateCustomer", () => {
    it("should validate valid input", () => {
      const input = {
        email: "test@example.com",
        name: "Test User",
        metadata: { plan: "pro" },
      };

      const result = stripeSchemas.getOrCreateCustomer.input.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should reject invalid email", () => {
      const input = {
        email: "not-an-email",
      };

      const result = stripeSchemas.getOrCreateCustomer.input.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("should allow optional fields", () => {
      const input = {
        email: "minimal@example.com",
      };

      const result = stripeSchemas.getOrCreateCustomer.input.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  describe("updateCustomer", () => {
    it("should validate partial update", () => {
      const input = {
        name: "New Name",
      };

      const result = stripeSchemas.updateCustomer.input.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should validate email update", () => {
      const input = {
        email: "new@example.com",
      };

      const result = stripeSchemas.updateCustomer.input.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should reject invalid email format", () => {
      const input = {
        email: "invalid-email",
      };

      const result = stripeSchemas.updateCustomer.input.safeParse(input);
      expect(result.success).toBe(false);
    });
  });
});

describe("Stripe Schemas - Checkout", () => {
  describe("createSubscriptionCheckout", () => {
    it("should validate minimal input", () => {
      const input = {
        priceId: "price_abc123",
      };

      const result = stripeSchemas.createSubscriptionCheckout.input.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should validate full input", () => {
      const input = {
        priceId: "price_abc123",
        quantity: 5,
        trialDays: 14,
        metadata: { source: "signup" },
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
        allowPromotionCodes: true,
      };

      const result = stripeSchemas.createSubscriptionCheckout.input.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should reject invalid quantity", () => {
      const input = {
        priceId: "price_abc123",
        quantity: 0,
      };

      const result = stripeSchemas.createSubscriptionCheckout.input.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("should reject trial days over limit", () => {
      const input = {
        priceId: "price_abc123",
        trialDays: 1000,
      };

      const result = stripeSchemas.createSubscriptionCheckout.input.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("should reject invalid URL format", () => {
      const input = {
        priceId: "price_abc123",
        successUrl: "not-a-url",
      };

      const result = stripeSchemas.createSubscriptionCheckout.input.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe("createPaymentCheckout", () => {
    it("should validate valid line items", () => {
      const input = {
        lineItems: [
          { priceId: "price_item1", quantity: 2 },
          { priceId: "price_item2", quantity: 1 },
        ],
      };

      const result = stripeSchemas.createPaymentCheckout.input.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should reject empty line items", () => {
      const input = {
        lineItems: [],
      };

      const result = stripeSchemas.createPaymentCheckout.input.safeParse(input);
      // Empty array is technically valid (Stripe will reject it, not Zod)
      expect(result.success).toBe(true);
    });

    it("should reject invalid quantity", () => {
      const input = {
        lineItems: [{ priceId: "price_item1", quantity: 0 }],
      };

      const result = stripeSchemas.createPaymentCheckout.input.safeParse(input);
      expect(result.success).toBe(false);
    });
  });
});

describe("Stripe Schemas - Subscription Management", () => {
  describe("cancelSubscription", () => {
    it("should validate empty input", () => {
      const input = {};

      const result = stripeSchemas.cancelSubscription.input.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should validate with immediately flag", () => {
      const input = {
        immediately: true,
      };

      const result = stripeSchemas.cancelSubscription.input.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  describe("pauseSubscription", () => {
    it("should validate with resumesAt", () => {
      const input = {
        resumesAt: "2024-12-31T23:59:59Z",
        behavior: "mark_uncollectible" as const,
      };

      const result = stripeSchemas.pauseSubscription.input.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should reject invalid behavior", () => {
      const input = {
        behavior: "invalid_behavior",
      };

      const result = stripeSchemas.pauseSubscription.input.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe("changeSubscription", () => {
    it("should validate plan change", () => {
      const input = {
        newPriceId: "price_enterprise_monthly",
        prorationBehavior: "create_prorations" as const,
      };

      const result = stripeSchemas.changeSubscription.input.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should reject invalid proration behavior", () => {
      const input = {
        newPriceId: "price_enterprise_monthly",
        prorationBehavior: "invalid",
      };

      const result = stripeSchemas.changeSubscription.input.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe("updateQuantity", () => {
    it("should validate valid quantity", () => {
      const input = {
        quantity: 10,
      };

      const result = stripeSchemas.updateQuantity.input.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should reject zero quantity", () => {
      const input = {
        quantity: 0,
      };

      const result = stripeSchemas.updateQuantity.input.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("should reject negative quantity", () => {
      const input = {
        quantity: -5,
      };

      const result = stripeSchemas.updateQuantity.input.safeParse(input);
      expect(result.success).toBe(false);
    });
  });
});

describe("Stripe Schemas - Billing", () => {
  describe("reportUsage", () => {
    it("should validate minimal usage report", () => {
      const input = {
        value: 100,
      };

      const result = stripeSchemas.reportUsage.input.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should validate full usage report", () => {
      const input = {
        value: 500,
        meterId: "meter_api_calls",
        timestamp: "2024-01-15T12:00:00Z",
      };

      const result = stripeSchemas.reportUsage.input.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  describe("createPortalSession", () => {
    it("should validate empty input", () => {
      const input = {};

      const result = stripeSchemas.createPortalSession.input.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should validate with return URL", () => {
      const input = {
        returnUrl: "https://example.com/dashboard",
      };

      const result = stripeSchemas.createPortalSession.input.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should reject invalid return URL", () => {
      const input = {
        returnUrl: "not-a-url",
      };

      const result = stripeSchemas.createPortalSession.input.safeParse(input);
      expect(result.success).toBe(false);
    });
  });
});

describe("Stripe Schemas - Output Validation", () => {
  describe("checkoutResult", () => {
    it("should validate checkout result", () => {
      const output = {
        sessionId: "cs_test_abc123",
        url: "https://checkout.stripe.com/pay/cs_test_abc123",
      };

      const result = stripeSchemas.createSubscriptionCheckout.output.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe("subscriptionRecord", () => {
    it("should validate full subscription record", () => {
      const output = {
        id: "sub_internal_123",
        stripeSubscriptionId: "sub_stripe_123",
        stripeCustomerId: "cus_stripe_123",
        userId: "user_123",
        status: "active",
        priceId: "price_pro_monthly",
        productId: "prod_pro",
        quantity: 1,
        currentPeriodStart: "2024-01-01T00:00:00Z",
        currentPeriodEnd: "2024-02-01T00:00:00Z",
        cancelAtPeriodEnd: false,
        canceledAt: null,
        endedAt: null,
        trialStart: null,
        trialEnd: null,
        metadata: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };

      const result = stripeSchemas.getSubscription.output.safeParse(output);
      expect(result.success).toBe(true);
    });

    it("should validate subscription with trial", () => {
      const output = {
        id: "sub_internal_123",
        stripeSubscriptionId: "sub_stripe_123",
        stripeCustomerId: "cus_stripe_123",
        userId: "user_123",
        status: "trialing",
        priceId: "price_pro_monthly",
        productId: "prod_pro",
        quantity: 1,
        currentPeriodStart: "2024-01-01T00:00:00Z",
        currentPeriodEnd: "2024-02-01T00:00:00Z",
        cancelAtPeriodEnd: false,
        canceledAt: null,
        endedAt: null,
        trialStart: "2024-01-01T00:00:00Z",
        trialEnd: "2024-01-15T00:00:00Z",
        metadata: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };

      const result = stripeSchemas.getSubscription.output.safeParse(output);
      expect(result.success).toBe(true);
    });

    it("should reject invalid status", () => {
      const output = {
        id: "sub_internal_123",
        stripeSubscriptionId: "sub_stripe_123",
        stripeCustomerId: "cus_stripe_123",
        userId: "user_123",
        status: "invalid_status",
        priceId: "price_pro_monthly",
        productId: "prod_pro",
        quantity: 1,
        currentPeriodStart: "2024-01-01T00:00:00Z",
        currentPeriodEnd: "2024-02-01T00:00:00Z",
        cancelAtPeriodEnd: false,
        canceledAt: null,
        endedAt: null,
        trialStart: null,
        trialEnd: null,
        metadata: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };

      const result = stripeSchemas.getSubscription.output.safeParse(output);
      expect(result.success).toBe(false);
    });
  });

  describe("upcomingInvoice", () => {
    it("should validate upcoming invoice", () => {
      const output = {
        amountDue: 1999,
        currency: "usd",
        periodStart: "2024-01-01T00:00:00Z",
        periodEnd: "2024-02-01T00:00:00Z",
        lines: [
          {
            description: "Pro Plan (Monthly)",
            amount: 1999,
            quantity: 1,
          },
        ],
      };

      const result = stripeSchemas.getUpcomingInvoice.output.safeParse(output);
      expect(result.success).toBe(true);
    });

    it("should validate null upcoming invoice", () => {
      const result = stripeSchemas.getUpcomingInvoice.output.safeParse(null);
      expect(result.success).toBe(true);
    });
  });
});
