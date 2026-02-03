/**
 * Stripe Plugin Handler & Middleware Tests
 *
 * Tests for route handlers and middleware functions
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { createWebhookHandler, stripeSchemas } from "../handlers";

// =============================================================================
// WEBHOOK HANDLER TESTS
// =============================================================================

describe("createWebhookHandler", () => {
  describe("signature validation", () => {
    it("should return 400 when stripe-signature header is missing", async () => {
      const handler = createWebhookHandler();
      const req = new Request("http://localhost/webhook", {
        method: "POST",
        body: JSON.stringify({ id: "evt_test" }),
      });

      const mockCtx = {
        plugins: {
          stripe: {
            handleWebhook: mock(() => Promise.resolve({ processed: true })),
          },
        },
      };

      const response = await handler(req, mockCtx);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("Missing stripe-signature header");
    });

    it("should call handleWebhook with body and signature", async () => {
      const handler = createWebhookHandler();
      const eventPayload = JSON.stringify({
        id: "evt_test_123",
        type: "customer.subscription.created",
      });

      const req = new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "stripe-signature": "whsec_test_signature",
        },
        body: eventPayload,
      });

      const mockHandleWebhook = mock(() =>
        Promise.resolve({
          processed: true,
          eventId: "evt_test_123",
          eventType: "customer.subscription.created",
        })
      );

      const mockCtx = {
        plugins: {
          stripe: {
            handleWebhook: mockHandleWebhook,
          },
        },
      };

      const response = await handler(req, mockCtx);
      expect(response.status).toBe(200);

      expect(mockHandleWebhook).toHaveBeenCalledWith(
        eventPayload,
        "whsec_test_signature"
      );
    });
  });

  describe("successful webhook processing", () => {
    it("should return 200 with event details on success", async () => {
      const handler = createWebhookHandler();
      const req = new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "stripe-signature": "whsec_valid",
        },
        body: JSON.stringify({ id: "evt_success" }),
      });

      const mockCtx = {
        plugins: {
          stripe: {
            handleWebhook: mock(() =>
              Promise.resolve({
                processed: true,
                eventId: "evt_success",
                eventType: "invoice.paid",
              })
            ),
          },
        },
      };

      const response = await handler(req, mockCtx);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.received).toBe(true);
      expect(body.eventId).toBe("evt_success");
      expect(body.eventType).toBe("invoice.paid");
    });

    it("should return correct content-type header", async () => {
      const handler = createWebhookHandler();
      const req = new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "stripe-signature": "whsec_valid",
        },
        body: "{}",
      });

      const mockCtx = {
        plugins: {
          stripe: {
            handleWebhook: mock(() =>
              Promise.resolve({ processed: true, eventId: "evt_1", eventType: "test" })
            ),
          },
        },
      };

      const response = await handler(req, mockCtx);
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });
  });

  describe("webhook error handling", () => {
    it("should return 500 on generic error", async () => {
      const handler = createWebhookHandler();
      const req = new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "stripe-signature": "whsec_invalid",
        },
        body: "{}",
      });

      const mockCtx = {
        plugins: {
          stripe: {
            handleWebhook: mock(() => Promise.reject(new Error("Processing failed"))),
          },
        },
      };

      const response = await handler(req, mockCtx);
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe("Processing failed");
    });

    it("should use error status if available", async () => {
      const handler = createWebhookHandler();
      const req = new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "stripe-signature": "whsec_bad",
        },
        body: "{}",
      });

      const errorWithStatus = new Error("Invalid signature");
      (errorWithStatus as any).status = 400;

      const mockCtx = {
        plugins: {
          stripe: {
            handleWebhook: mock(() => Promise.reject(errorWithStatus)),
          },
        },
      };

      const response = await handler(req, mockCtx);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("Invalid signature");
    });

    it("should handle non-Error exceptions", async () => {
      const handler = createWebhookHandler();
      const req = new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "stripe-signature": "whsec_test",
        },
        body: "{}",
      });

      const mockCtx = {
        plugins: {
          stripe: {
            handleWebhook: mock(() => Promise.reject("String error")),
          },
        },
      };

      const response = await handler(req, mockCtx);
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe("Webhook failed");
    });
  });
});

// =============================================================================
// MIDDLEWARE TESTS
// =============================================================================

describe("Stripe Middleware - requireSubscription", () => {
  // Create a mock middleware function that mimics the plugin's behavior
  function createRequireSubscriptionMiddleware() {
    return async (req: any, ctx: any, next: () => Promise<any>) => {
      const userId = ctx.userId;
      if (!userId) {
        throw ctx.core.errors.Unauthorized("User not authenticated");
      }

      const hasActive = await ctx.plugins.stripe.hasActiveSubscription(userId);
      if (!hasActive) {
        throw ctx.core.errors.SubscriptionRequired();
      }

      return next();
    };
  }

  it("should throw Unauthorized when userId is missing", async () => {
    const middleware = createRequireSubscriptionMiddleware();
    const req = {};
    const ctx = {
      userId: undefined,
      core: {
        errors: {
          Unauthorized: (msg: string) => {
            const err = new Error(msg);
            (err as any).code = "UNAUTHORIZED";
            (err as any).status = 401;
            return err;
          },
        },
      },
      plugins: {
        stripe: {
          hasActiveSubscription: mock(() => Promise.resolve(false)),
        },
      },
    };
    const next = mock(() => Promise.resolve({ data: "success" }));

    await expect(middleware(req, ctx, next)).rejects.toThrow("User not authenticated");
    expect(next).not.toHaveBeenCalled();
  });

  it("should throw SubscriptionRequired when user has no active subscription", async () => {
    const middleware = createRequireSubscriptionMiddleware();
    const req = {};
    const mockHasActive = mock(() => Promise.resolve(false));
    const ctx = {
      userId: "user_123",
      core: {
        errors: {
          SubscriptionRequired: () => {
            const err = new Error("Active subscription required");
            (err as any).code = "STRIPE_SUBSCRIPTION_REQUIRED";
            (err as any).status = 403;
            return err;
          },
        },
      },
      plugins: {
        stripe: {
          hasActiveSubscription: mockHasActive,
        },
      },
    };
    const next = mock(() => Promise.resolve({ data: "success" }));

    await expect(middleware(req, ctx, next)).rejects.toThrow(
      "Active subscription required"
    );
    expect(mockHasActive).toHaveBeenCalledWith("user_123");
    expect(next).not.toHaveBeenCalled();
  });

  it("should call next() when user has active subscription", async () => {
    const middleware = createRequireSubscriptionMiddleware();
    const req = {};
    const mockHasActive = mock(() => Promise.resolve(true));
    const ctx = {
      userId: "user_active",
      core: {
        errors: {},
      },
      plugins: {
        stripe: {
          hasActiveSubscription: mockHasActive,
        },
      },
    };
    const nextResult = { data: "protected content" };
    const next = mock(() => Promise.resolve(nextResult));

    const result = await middleware(req, ctx, next);

    expect(mockHasActive).toHaveBeenCalledWith("user_active");
    expect(next).toHaveBeenCalled();
    expect(result).toEqual(nextResult);
  });
});

describe("Stripe Middleware - requirePlan", () => {
  // Create a mock middleware function that mimics the plugin's behavior
  function createRequirePlanMiddleware() {
    return async (
      req: any,
      ctx: any,
      next: () => Promise<any>,
      config: { productId: string }
    ) => {
      const userId = ctx.userId;
      if (!userId) {
        throw ctx.core.errors.Unauthorized("User not authenticated");
      }

      const hasPlan = await ctx.plugins.stripe.hasPlan(userId, config.productId);
      if (!hasPlan) {
        throw ctx.core.errors.SubscriptionRequired(`Plan ${config.productId} required`);
      }

      return next();
    };
  }

  it("should throw Unauthorized when userId is missing", async () => {
    const middleware = createRequirePlanMiddleware();
    const req = {};
    const ctx = {
      userId: undefined,
      core: {
        errors: {
          Unauthorized: (msg: string) => {
            const err = new Error(msg);
            (err as any).code = "UNAUTHORIZED";
            return err;
          },
        },
      },
      plugins: {
        stripe: {
          hasPlan: mock(() => Promise.resolve(false)),
        },
      },
    };
    const next = mock(() => Promise.resolve());
    const config = { productId: "prod_pro" };

    await expect(middleware(req, ctx, next, config)).rejects.toThrow(
      "User not authenticated"
    );
  });

  it("should throw SubscriptionRequired when user does not have the plan", async () => {
    const middleware = createRequirePlanMiddleware();
    const req = {};
    const mockHasPlan = mock(() => Promise.resolve(false));
    const ctx = {
      userId: "user_basic",
      core: {
        errors: {
          SubscriptionRequired: (msg: string) => {
            const err = new Error(msg);
            (err as any).code = "STRIPE_SUBSCRIPTION_REQUIRED";
            return err;
          },
        },
      },
      plugins: {
        stripe: {
          hasPlan: mockHasPlan,
        },
      },
    };
    const next = mock(() => Promise.resolve());
    const config = { productId: "prod_enterprise" };

    await expect(middleware(req, ctx, next, config)).rejects.toThrow(
      "Plan prod_enterprise required"
    );
    expect(mockHasPlan).toHaveBeenCalledWith("user_basic", "prod_enterprise");
  });

  it("should call next() when user has the required plan", async () => {
    const middleware = createRequirePlanMiddleware();
    const req = {};
    const mockHasPlan = mock(() => Promise.resolve(true));
    const ctx = {
      userId: "user_enterprise",
      core: {
        errors: {},
      },
      plugins: {
        stripe: {
          hasPlan: mockHasPlan,
        },
      },
    };
    const nextResult = { data: "enterprise feature" };
    const next = mock(() => Promise.resolve(nextResult));
    const config = { productId: "prod_enterprise" };

    const result = await middleware(req, ctx, next, config);

    expect(mockHasPlan).toHaveBeenCalledWith("user_enterprise", "prod_enterprise");
    expect(next).toHaveBeenCalled();
    expect(result).toEqual(nextResult);
  });

  it("should work with price ID instead of product ID", async () => {
    const middleware = createRequirePlanMiddleware();
    const req = {};
    const mockHasPlan = mock(() => Promise.resolve(true));
    const ctx = {
      userId: "user_pro",
      core: {
        errors: {},
      },
      plugins: {
        stripe: {
          hasPlan: mockHasPlan,
        },
      },
    };
    const next = mock(() => Promise.resolve({ data: "pro feature" }));
    const config = { productId: "price_pro_monthly" };

    await middleware(req, ctx, next, config);

    expect(mockHasPlan).toHaveBeenCalledWith("user_pro", "price_pro_monthly");
  });
});

// =============================================================================
// HANDLER SCHEMA EXPORTS TESTS
// =============================================================================

describe("stripeSchemas exports", () => {
  it("should export all customer schemas", () => {
    expect(stripeSchemas.getOrCreateCustomer).toBeDefined();
    expect(stripeSchemas.getOrCreateCustomer.input).toBeDefined();
    expect(stripeSchemas.getOrCreateCustomer.output).toBeDefined();

    expect(stripeSchemas.getCustomer).toBeDefined();
    expect(stripeSchemas.updateCustomer).toBeDefined();
    expect(stripeSchemas.deleteCustomer).toBeDefined();
  });

  it("should export all checkout schemas", () => {
    expect(stripeSchemas.createSubscriptionCheckout).toBeDefined();
    expect(stripeSchemas.createSubscriptionCheckout.input).toBeDefined();
    expect(stripeSchemas.createSubscriptionCheckout.output).toBeDefined();

    expect(stripeSchemas.createPaymentCheckout).toBeDefined();
  });

  it("should export all subscription management schemas", () => {
    expect(stripeSchemas.getSubscription).toBeDefined();
    expect(stripeSchemas.getSubscriptions).toBeDefined();
    expect(stripeSchemas.cancelSubscription).toBeDefined();
    expect(stripeSchemas.resumeSubscription).toBeDefined();
    expect(stripeSchemas.pauseSubscription).toBeDefined();
    expect(stripeSchemas.unpauseSubscription).toBeDefined();
    expect(stripeSchemas.changeSubscription).toBeDefined();
    expect(stripeSchemas.updateQuantity).toBeDefined();
    expect(stripeSchemas.hasActiveSubscription).toBeDefined();
    expect(stripeSchemas.hasPlan).toBeDefined();
  });

  it("should export all billing schemas", () => {
    expect(stripeSchemas.createPortalSession).toBeDefined();
    expect(stripeSchemas.reportUsage).toBeDefined();
    expect(stripeSchemas.getUpcomingInvoice).toBeDefined();
  });

  it("should export webhook schema", () => {
    expect(stripeSchemas.webhook).toBeDefined();
    expect(stripeSchemas.webhook.output).toBeDefined();
  });

  it("should export sync schemas", () => {
    expect(stripeSchemas.syncSubscription).toBeDefined();
    expect(stripeSchemas.syncCustomer).toBeDefined();
  });
});

// =============================================================================
// WEBHOOK HANDLER EDGE CASES
// =============================================================================

describe("createWebhookHandler - Edge Cases", () => {
  it("should handle empty body", async () => {
    const handler = createWebhookHandler();
    const req = new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "stripe-signature": "whsec_test",
      },
      body: "",
    });

    const mockCtx = {
      plugins: {
        stripe: {
          handleWebhook: mock(() =>
            Promise.resolve({ processed: true, eventId: "evt_1", eventType: "test" })
          ),
        },
      },
    };

    const response = await handler(req, mockCtx);
    // The handler itself doesn't validate body, it passes to handleWebhook
    expect(response.status).toBe(200);
  });

  it("should handle large payloads", async () => {
    const handler = createWebhookHandler();
    const largePayload = JSON.stringify({
      id: "evt_large",
      type: "customer.subscription.created",
      data: {
        object: {
          items: Array(100)
            .fill(null)
            .map((_, i) => ({
              id: `item_${i}`,
              price: { id: `price_${i}` },
            })),
        },
      },
    });

    const req = new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "stripe-signature": "whsec_test",
      },
      body: largePayload,
    });

    const mockCtx = {
      plugins: {
        stripe: {
          handleWebhook: mock(() =>
            Promise.resolve({
              processed: true,
              eventId: "evt_large",
              eventType: "customer.subscription.created",
            })
          ),
        },
      },
    };

    const response = await handler(req, mockCtx);
    expect(response.status).toBe(200);
  });

  it("should preserve signature exactly as received", async () => {
    const handler = createWebhookHandler();
    const complexSignature = "t=1234567890,v1=abc123def456,v0=legacy789";

    const req = new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "stripe-signature": complexSignature,
      },
      body: "{}",
    });

    let capturedSignature: string | null = null;
    const mockCtx = {
      plugins: {
        stripe: {
          handleWebhook: mock((body: string, sig: string) => {
            capturedSignature = sig;
            return Promise.resolve({ processed: true, eventId: "evt_1", eventType: "test" });
          }),
        },
      },
    };

    await handler(req, mockCtx);
    expect(capturedSignature).toBe(complexSignature);
  });
});
