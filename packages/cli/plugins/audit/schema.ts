/**
 * Audit Plugin Schema
 *
 * Type definitions for audit log table
 */

import type { Generated } from "kysely";

export interface AuditLogTable {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  user_id: string | null;
  user_email: string | null;
  ip_address: string | null;
  user_agent: string | null;
  before_data: string | null; // JSON string
  after_data: string | null; // JSON string
  metadata: string | null; // JSON string
  severity: string; // info, warning, error, critical
  created_at: Generated<string>;
}

export interface DB {
  audit_log: AuditLogTable;
}
