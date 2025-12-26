import type { Generated, Insertable, Selectable, Updateable } from "kysely";

// ============================================================================
// Database Types
// ============================================================================

export interface AuditLogDB {
  log_entry: LogEntryTable;
  retention_config: RetentionConfigTable;
}

// ============================================================================
// Log Entry Table
// ============================================================================

export interface LogEntryTable {
  id: string;
  timestamp: number; // Unix ms
  level: string; // info, warn, error, security
  event: string; // Namespaced: auth.login, api.GET./orders

  // Context
  user_id: number | null;
  company_id: number | null;
  employee_id: number | null;
  username: string | null;

  // Request info
  ip_address: string | null;
  user_agent: string | null;
  geo_country: string | null;
  geo_city: string | null;

  // API-specific
  method: string | null;
  path: string | null;
  status_code: number | null;
  duration_ms: number | null;

  // Flexible payload (JSON string)
  metadata: string | null;

  // Human-readable message (optional)
  message: string | null;

  // For request correlation
  trace_id: string | null;
}

export type LogEntryRow = Selectable<LogEntryTable>;
export type NewLogEntry = Insertable<LogEntryTable>;
export type LogEntryUpdate = Updateable<LogEntryTable>;

// ============================================================================
// Retention Config Table
// ============================================================================

export interface RetentionConfigTable {
  id: Generated<number>;
  level: string; // 'default', 'security', 'error', etc.
  retention_months: number;
}

export type RetentionConfigRow = Selectable<RetentionConfigTable>;
export type NewRetentionConfig = Insertable<RetentionConfigTable>;
