/**
 * Email Plugin Schema
 *
 * Type definitions for email queue table
 */

import type { Generated } from "kysely";

export interface EmailQueueTable {
  id: string;
  to_address: string;
  from_address: string | null;
  subject: string | null;
  text_content: string | null;
  html_content: string | null;
  cc: string | null;
  bcc: string | null;
  priority: Generated<number>; // -1 = low, 0 = normal, 1 = high
  scheduled_at: string;
  status: string; // pending, sent, failed
  attempts: Generated<number>;
  error_message: string | null;
  sent_at: string | null;
  created_at: Generated<string>;
}

export interface DB {
  email_queue: EmailQueueTable;
}
