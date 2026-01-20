/**
 * Stripe Plugin Database Schema
 *
 * Type definitions for Stripe-related tables
 */

import type { Generated } from "kysely";

export interface StripeCustomersTable {
  id: string;
  user_id: string;
  stripe_customer_id: string;
  email: string | null;
  name: string | null;
  metadata: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  deleted_at: string | null;
}

export interface StripeSubscriptionsTable {
  id: string;
  stripe_subscription_id: string;
  stripe_customer_id: string;
  user_id: string;
  status: string;
  price_id: string;
  product_id: string;
  quantity: number;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: number;
  canceled_at: string | null;
  ended_at: string | null;
  trial_start: string | null;
  trial_end: string | null;
  metadata: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface StripeWebhookEventsTable {
  id: string;
  stripe_event_id: string;
  event_type: string;
  status: string;
  error: string | null;
  processed_at: string;
  created_at: Generated<string>;
}

export interface DB {
  stripe_customers: StripeCustomersTable;
  stripe_subscriptions: StripeSubscriptionsTable;
  stripe_webhook_events: StripeWebhookEventsTable;
}
