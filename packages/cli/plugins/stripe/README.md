# Stripe Plugin

Flexible Stripe integration for @donkeylabs/server with customer management, subscriptions, checkout sessions, webhook handling, and usage-based billing.

## Features

- **Customer Management** - Link users to Stripe customers
- **Checkout Sessions** - Subscriptions and one-time payments
- **Subscription Management** - Create, update, cancel, pause, resume
- **Webhook Handling** - Idempotent event processing
- **Usage-Based Billing** - Meter event reporting
- **Middleware** - Subscription gating for protected routes

## Installation

```bash
# Add the plugin to your project
donkeylabs add stripe

# Install dependencies
bun add stripe
```

## Configuration

```typescript
import { stripePlugin } from './plugins/stripe';

server.registerPlugin(stripePlugin({
  // Required
  secretKey: process.env.STRIPE_SECRET_KEY!,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,

  // Checkout configuration
  checkout: {
    successUrl: 'https://yourapp.com/success?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://yourapp.com/pricing',
    allowPromotionCodes: true,
  },

  // Customer portal configuration
  portal: {
    returnUrl: 'https://yourapp.com/account',
  },

  // Optional: Usage-based billing
  billing: {
    defaultMeterId: 'api_calls',
  },
}));
```

## Environment Variables

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_SUCCESS_URL=https://yourapp.com/success
STRIPE_CANCEL_URL=https://yourapp.com/pricing
STRIPE_PORTAL_RETURN_URL=https://yourapp.com/account
```

## Database Schema

The plugin creates three tables:

### stripe_customers
Links application users to Stripe customers.

| Column | Type | Description |
|--------|------|-------------|
| id | text | Internal ID |
| user_id | text | Your app's user ID (unique) |
| stripe_customer_id | text | Stripe customer ID (unique) |
| email | text | Customer email |
| name | text | Customer name |
| metadata | text | JSON metadata |
| created_at | text | Creation timestamp |
| updated_at | text | Update timestamp |
| deleted_at | text | Soft delete timestamp |

### stripe_subscriptions
Stores subscription data synced from Stripe.

| Column | Type | Description |
|--------|------|-------------|
| id | text | Internal ID |
| stripe_subscription_id | text | Stripe subscription ID (unique) |
| stripe_customer_id | text | Stripe customer ID |
| user_id | text | Your app's user ID |
| status | text | active, canceled, past_due, etc. |
| price_id | text | Stripe price ID |
| product_id | text | Stripe product ID |
| quantity | integer | Seat count |
| current_period_start | text | Period start |
| current_period_end | text | Period end |
| cancel_at_period_end | integer | 0 or 1 |
| canceled_at | text | Cancellation timestamp |
| ended_at | text | End timestamp |
| trial_start | text | Trial start |
| trial_end | text | Trial end |
| metadata | text | JSON metadata |

### stripe_webhook_events
Tracks processed webhooks for idempotency.

| Column | Type | Description |
|--------|------|-------------|
| id | text | Internal ID |
| stripe_event_id | text | Stripe event ID (unique) |
| event_type | text | Event type |
| status | text | processing, processed, failed |
| error | text | Error message if failed |
| processed_at | text | Processing timestamp |

## Service Methods

### Customer Management

```typescript
// Get or create a Stripe customer
const customer = await ctx.plugins.stripe.getOrCreateCustomer({
  userId: 'user_123',
  email: 'user@example.com',
  name: 'John Doe',
  metadata: { plan: 'pro' },
});

// Get customer by user ID
const customer = await ctx.plugins.stripe.getCustomerByUserId('user_123');

// Update customer
const updated = await ctx.plugins.stripe.updateCustomer('user_123', {
  name: 'Jane Doe',
});

// Delete customer (soft delete)
await ctx.plugins.stripe.deleteCustomer('user_123', {
  deleteInStripe: true, // Also delete in Stripe
});
```

### Checkout Sessions

```typescript
// Create subscription checkout
const checkout = await ctx.plugins.stripe.createSubscriptionCheckout({
  userId: 'user_123',
  priceId: 'price_pro_monthly',
  quantity: 1,
  trialDays: 14,
  metadata: { source: 'landing_page' },
});
// Returns: { sessionId: 'cs_...', url: 'https://checkout.stripe.com/...' }

// Create one-time payment checkout
const payment = await ctx.plugins.stripe.createPaymentCheckout({
  userId: 'user_123',
  lineItems: [
    { priceId: 'price_credits_100', quantity: 2 },
  ],
});
```

### Subscription Management

```typescript
// Get active subscription
const subscription = await ctx.plugins.stripe.getSubscription('user_123');

// Get all subscriptions
const subscriptions = await ctx.plugins.stripe.getSubscriptions('user_123', {
  includeEnded: true,
});

// Check subscription status
const hasActive = await ctx.plugins.stripe.hasActiveSubscription('user_123');
const hasPro = await ctx.plugins.stripe.hasPlan('user_123', 'prod_pro');

// Cancel subscription
await ctx.plugins.stripe.cancelSubscription('user_123', {
  immediately: false, // Cancel at period end
});

// Resume before period end
await ctx.plugins.stripe.resumeSubscription('user_123');

// Pause subscription
await ctx.plugins.stripe.pauseSubscription('user_123', {
  behavior: 'mark_uncollectible',
  resumesAt: new Date('2024-03-01'),
});

// Unpause subscription
await ctx.plugins.stripe.unpauseSubscription('user_123');

// Change plan (upgrade/downgrade)
await ctx.plugins.stripe.changeSubscription('user_123', {
  newPriceId: 'price_enterprise_monthly',
  prorationBehavior: 'create_prorations',
});

// Update quantity (seats)
await ctx.plugins.stripe.updateSubscriptionQuantity('user_123', 5);
```

### Portal & Billing

```typescript
// Create customer portal session
const portal = await ctx.plugins.stripe.createPortalSession('user_123', {
  returnUrl: 'https://yourapp.com/account',
});
// Returns: { url: 'https://billing.stripe.com/...' }

// Report usage for metered billing
await ctx.plugins.stripe.reportUsage({
  userId: 'user_123',
  value: 100,
  meterId: 'api_calls',
  timestamp: new Date(),
});

// Get upcoming invoice preview
const invoice = await ctx.plugins.stripe.getUpcomingInvoice('user_123');
```

### Webhooks

```typescript
// Handle webhook (usually in a raw route handler)
const result = await ctx.plugins.stripe.handleWebhook(rawBody, signature);
// Returns: { processed: true, eventId: 'evt_...', eventType: 'customer.subscription.created' }

// Check if event was already processed (idempotency)
const processed = await ctx.plugins.stripe.isEventProcessed('evt_123');
```

### Sync

```typescript
// Force sync subscription from Stripe
await ctx.plugins.stripe.syncSubscription('sub_123');

// Force sync customer from Stripe
await ctx.plugins.stripe.syncCustomer('cus_123');
```

## Route Examples

### Create Routes

```typescript
import { createRouter } from '@donkeylabs/server';
import { stripeSchemas, createWebhookHandler } from './plugins/stripe/handlers';
import { z } from 'zod';

const api = createRouter('stripe');

// Create customer (typically called during signup)
api.route('createCustomer').typed({
  input: stripeSchemas.getOrCreateCustomer.input,
  output: stripeSchemas.getOrCreateCustomer.output,
  handle: async (input, ctx) => {
    return ctx.plugins.stripe.getOrCreateCustomer({
      userId: ctx.userId,
      ...input,
    });
  },
});

// Create checkout session
api.route('checkout').typed({
  input: stripeSchemas.createSubscriptionCheckout.input,
  output: stripeSchemas.createSubscriptionCheckout.output,
  handle: async (input, ctx) => {
    return ctx.plugins.stripe.createSubscriptionCheckout({
      userId: ctx.userId,
      ...input,
    });
  },
});

// Get subscription
api.route('subscription').typed({
  input: stripeSchemas.getSubscription.input,
  output: stripeSchemas.getSubscription.output,
  handle: async (input, ctx) => {
    return ctx.plugins.stripe.getSubscription(ctx.userId);
  },
});

// Create portal session
api.route('portal').typed({
  input: stripeSchemas.createPortalSession.input,
  output: stripeSchemas.createPortalSession.output,
  handle: async (input, ctx) => {
    return ctx.plugins.stripe.createPortalSession(ctx.userId, input);
  },
});

// Webhook endpoint (must be raw handler)
api.route('webhook').raw(createWebhookHandler());
```

## Middleware

### Require Any Subscription

```typescript
api.route('premium.feature').typed({
  input: z.object({}),
  output: z.object({ data: z.string() }),
  middleware: [ctx.plugins.stripe.middleware.requireSubscription],
  handle: async (input, ctx) => {
    return { data: 'premium content' };
  },
});
```

### Require Specific Plan

```typescript
api.route('enterprise.feature').typed({
  input: z.object({}),
  output: z.object({ data: z.string() }),
  middleware: [
    ctx.plugins.stripe.middleware.requirePlan({ productId: 'prod_enterprise' }),
  ],
  handle: async (input, ctx) => {
    return { data: 'enterprise content' };
  },
});
```

## Events

The plugin emits events that you can listen to:

```typescript
// Customer created
ctx.core.events.on('stripe.customer.created', (data) => {
  console.log(`Customer created: ${data.userId} -> ${data.stripeCustomerId}`);
});

// Subscription created
ctx.core.events.on('stripe.subscription.created', (data) => {
  console.log(`Subscription created: ${data.userId} subscribed to ${data.productId}`);
});

// Subscription updated
ctx.core.events.on('stripe.subscription.updated', (data) => {
  console.log(`Subscription ${data.status} (was ${data.previousStatus})`);
});

// Subscription canceled
ctx.core.events.on('stripe.subscription.canceled', (data) => {
  console.log(`Subscription ends at ${data.endsAt}`);
});

// Payment succeeded
ctx.core.events.on('stripe.payment.succeeded', (data) => {
  console.log(`Payment of ${data.amount} ${data.currency} succeeded`);
});

// Payment failed
ctx.core.events.on('stripe.payment.failed', (data) => {
  console.log(`Payment failed: ${data.error}`);
});

// Trial ending (3 days before)
ctx.core.events.on('stripe.trial.ending', (data) => {
  console.log(`Trial ends at ${data.trialEndsAt}`);
});
```

## Custom Errors

The plugin provides typed custom errors:

| Error | Status | Code | Description |
|-------|--------|------|-------------|
| CustomerNotFound | 404 | STRIPE_CUSTOMER_NOT_FOUND | Customer not found |
| SubscriptionNotFound | 404 | STRIPE_SUBSCRIPTION_NOT_FOUND | Subscription not found |
| SubscriptionRequired | 403 | STRIPE_SUBSCRIPTION_REQUIRED | Active subscription required |
| PaymentFailed | 402 | STRIPE_PAYMENT_FAILED | Payment processing failed |
| WebhookVerificationFailed | 400 | STRIPE_WEBHOOK_VERIFICATION_FAILED | Invalid signature |
| StripeApiError | 502 | STRIPE_API_ERROR | Stripe API error |

## Webhook Events Handled

The plugin automatically handles these webhook events:

**Customer Events:**
- `customer.created`
- `customer.updated`
- `customer.deleted`

**Subscription Events:**
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.trial_will_end`

**Checkout Events:**
- `checkout.session.completed`

**Invoice Events:**
- `invoice.paid`
- `invoice.payment_failed`

## Testing

The plugin includes comprehensive tests:

```bash
# Run all tests
bun test src/plugins/stripe

# Run specific test files
bun test src/plugins/stripe/tests/unit.test.ts
bun test src/plugins/stripe/tests/schemas.test.ts
bun test src/plugins/stripe/tests/integration.test.ts
```

## Best Practices

1. **Always create customers first** - Before creating checkouts, ensure users have a linked Stripe customer.

2. **Use webhooks for state changes** - Don't rely on checkout redirects alone. Always verify via webhooks.

3. **Implement idempotency** - The plugin handles this, but ensure your event handlers are also idempotent.

4. **Store minimal data** - The plugin syncs from Stripe. Don't duplicate data unnecessarily.

5. **Use middleware** - Leverage `requireSubscription` and `requirePlan` middleware for protected routes.

6. **Handle trial endings** - Listen to `stripe.trial.ending` events to notify users.

7. **Test with Stripe CLI** - Use `stripe listen --forward-to localhost:3000/api/stripe.webhook` for local testing.
