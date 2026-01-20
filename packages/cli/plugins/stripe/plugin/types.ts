/**
 * Stripe Plugin Types
 *
 * Configuration and type definitions for Stripe payments integration
 */

import type { Generated } from "kysely";

// =============================================================================
// PLUGIN CONFIGURATION
// =============================================================================

export interface StripeConfig {
  /** Stripe secret key (sk_live_* or sk_test_*) */
  secretKey: string;

  /** Webhook signing secret (whsec_*) */
  webhookSecret: string;

  /** Checkout session configuration */
  checkout?: {
    /** URL to redirect after successful checkout */
    successUrl: string;
    /** URL to redirect after cancelled checkout */
    cancelUrl: string;
    /** Allow promotion codes in checkout */
    allowPromotionCodes?: boolean;
  };

  /** Customer portal configuration */
  portal?: {
    /** URL to return to after portal session */
    returnUrl: string;
  };

  /** Usage-based billing defaults */
  billing?: {
    /** Default meter ID for usage reporting */
    defaultMeterId?: string;
  };
}

// =============================================================================
// SUBSCRIPTION STATUS
// =============================================================================

export type SubscriptionStatus =
  | "active"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "past_due"
  | "paused"
  | "trialing"
  | "unpaid";

export type WebhookEventStatus = "processing" | "processed" | "failed";

// =============================================================================
// DATABASE RECORD TYPES (camelCase for app use)
// =============================================================================

export interface CustomerRecord {
  id: string;
  userId: string;
  stripeCustomerId: string;
  email: string | null;
  name: string | null;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface SubscriptionRecord {
  id: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  userId: string;
  status: SubscriptionStatus;
  priceId: string;
  productId: string;
  quantity: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  endedAt: string | null;
  trialStart: string | null;
  trialEnd: string | null;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEventRecord {
  id: string;
  stripeEventId: string;
  eventType: string;
  status: WebhookEventStatus;
  error: string | null;
  processedAt: string;
  createdAt: string;
}

// =============================================================================
// SERVICE METHOD PARAMETERS
// =============================================================================

export interface GetOrCreateCustomerParams {
  userId: string;
  email: string;
  name?: string;
  metadata?: Record<string, string>;
}

export interface UpdateCustomerParams {
  email?: string;
  name?: string;
  metadata?: Record<string, string>;
}

export interface DeleteCustomerOptions {
  /** Also delete the customer in Stripe */
  deleteInStripe?: boolean;
}

export interface CreateSubscriptionCheckoutParams {
  userId: string;
  priceId: string;
  quantity?: number;
  trialDays?: number;
  metadata?: Record<string, string>;
  /** Override default success URL */
  successUrl?: string;
  /** Override default cancel URL */
  cancelUrl?: string;
  /** Allow promotion codes */
  allowPromotionCodes?: boolean;
}

export interface CreatePaymentCheckoutParams {
  userId: string;
  lineItems: Array<{
    priceId: string;
    quantity: number;
  }>;
  metadata?: Record<string, string>;
  successUrl?: string;
  cancelUrl?: string;
}

export interface CheckoutResult {
  sessionId: string;
  url: string;
}

export interface GetSubscriptionsOptions {
  /** Include ended subscriptions */
  includeEnded?: boolean;
}

export interface CancelSubscriptionOptions {
  /** Cancel immediately instead of at period end */
  immediately?: boolean;
}

export interface PauseSubscriptionOptions {
  /** When to automatically resume */
  resumesAt?: Date;
  /** What to do with pending invoices: 'mark_uncollectible', 'void', or 'keep_as_draft' */
  behavior?: "mark_uncollectible" | "void" | "keep_as_draft";
}

export interface ChangeSubscriptionParams {
  /** New price ID to switch to */
  newPriceId: string;
  /** Proration behavior */
  prorationBehavior?: "create_prorations" | "none" | "always_invoice";
}

export interface ReportUsageParams {
  userId: string;
  /** Usage value to report */
  value: number;
  /** Meter ID (uses default if not specified) */
  meterId?: string;
  /** Timestamp for the usage (defaults to now) */
  timestamp?: Date;
}

export interface CreatePortalSessionOptions {
  /** Override default return URL */
  returnUrl?: string;
}

export interface PortalSessionResult {
  url: string;
}

export interface WebhookResult {
  /** Whether the event was newly processed */
  processed: boolean;
  /** Event ID */
  eventId: string;
  /** Event type */
  eventType: string;
}

export interface UpcomingInvoice {
  amountDue: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  lines: Array<{
    description: string;
    amount: number;
    quantity: number;
  }>;
}

// =============================================================================
// SERVICE INTERFACE
// =============================================================================

export interface StripeService {
  // Customer Management
  getOrCreateCustomer(params: GetOrCreateCustomerParams): Promise<CustomerRecord>;
  getCustomerByUserId(userId: string): Promise<CustomerRecord | null>;
  updateCustomer(userId: string, params: UpdateCustomerParams): Promise<CustomerRecord>;
  deleteCustomer(userId: string, options?: DeleteCustomerOptions): Promise<void>;

  // Checkout Sessions
  createSubscriptionCheckout(params: CreateSubscriptionCheckoutParams): Promise<CheckoutResult>;
  createPaymentCheckout(params: CreatePaymentCheckoutParams): Promise<CheckoutResult>;

  // Subscription Management
  getSubscription(userId: string): Promise<SubscriptionRecord | null>;
  getSubscriptions(userId: string, options?: GetSubscriptionsOptions): Promise<SubscriptionRecord[]>;
  cancelSubscription(userId: string, options?: CancelSubscriptionOptions): Promise<SubscriptionRecord>;
  resumeSubscription(userId: string): Promise<SubscriptionRecord>;
  pauseSubscription(userId: string, options?: PauseSubscriptionOptions): Promise<SubscriptionRecord>;
  unpauseSubscription(userId: string): Promise<SubscriptionRecord>;
  changeSubscription(userId: string, params: ChangeSubscriptionParams): Promise<SubscriptionRecord>;
  updateSubscriptionQuantity(userId: string, quantity: number): Promise<SubscriptionRecord>;
  hasActiveSubscription(userId: string): Promise<boolean>;
  hasPlan(userId: string, productIdOrPriceId: string): Promise<boolean>;

  // Portal & Billing
  createPortalSession(userId: string, options?: CreatePortalSessionOptions): Promise<PortalSessionResult>;
  reportUsage(params: ReportUsageParams): Promise<void>;
  getUpcomingInvoice(userId: string): Promise<UpcomingInvoice | null>;

  // Webhooks
  handleWebhook(payload: string | Buffer, signature: string): Promise<WebhookResult>;
  isEventProcessed(eventId: string): Promise<boolean>;

  // Sync
  syncSubscription(stripeSubscriptionId: string): Promise<SubscriptionRecord>;
  syncCustomer(stripeCustomerId: string): Promise<CustomerRecord>;
}

// =============================================================================
// EVENT TYPES (for SSE/internal events)
// =============================================================================

export interface StripeCustomerCreatedEvent {
  userId: string;
  stripeCustomerId: string;
}

export interface StripeSubscriptionCreatedEvent {
  userId: string;
  subscriptionId: string;
  productId: string;
  status: SubscriptionStatus;
}

export interface StripeSubscriptionUpdatedEvent {
  userId: string;
  subscriptionId: string;
  status: SubscriptionStatus;
  previousStatus: SubscriptionStatus;
}

export interface StripeSubscriptionCanceledEvent {
  userId: string;
  subscriptionId: string;
  endsAt: string;
}

export interface StripePaymentSucceededEvent {
  userId: string;
  amount: number;
  currency: string;
}

export interface StripePaymentFailedEvent {
  userId: string;
  error: string;
}

export interface StripeTrialEndingEvent {
  userId: string;
  subscriptionId: string;
  trialEndsAt: string;
}

// =============================================================================
// MIDDLEWARE CONFIG TYPES
// =============================================================================

export interface RequirePlanConfig {
  /** Product ID or Price ID to require */
  productId: string;
}
