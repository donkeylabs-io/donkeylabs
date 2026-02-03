/**
 * Audit Plugin
 *
 * Comprehensive audit logging with query capabilities.
 * Tracks user actions, system events, and data changes.
 */

import { createPlugin, type ErrorFactory } from "@donkeylabs/server";
import { z } from "zod";
import type { DB } from "./schema";

declare module "@donkeylabs/server" {
  interface ErrorFactories {
    AuditLogFailed: ErrorFactory;
    EntryNotFound: ErrorFactory;
  }
}

export interface AuditLogEntry {
  id: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  userId?: string;
  userEmail?: string;
  ipAddress?: string;
  userAgent?: string;
  before?: Record<string, any>;
  after?: Record<string, any>;
  metadata?: Record<string, any>;
  severity: "info" | "warning" | "error" | "critical";
  createdAt: string;
}

export interface LogOptions {
  action: string;
  resourceType: string;
  resourceId?: string;
  userId?: string;
  userEmail?: string;
  ipAddress?: string;
  userAgent?: string;
  before?: Record<string, any>;
  after?: Record<string, any>;
  metadata?: Record<string, any>;
  severity?: "info" | "warning" | "error" | "critical";
}

export interface QueryOptions {
  userId?: string;
  resourceType?: string;
  resourceId?: string;
  action?: string;
  severity?: "info" | "warning" | "error" | "critical";
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

export interface QueryResult {
  entries: AuditLogEntry[];
  total: number;
  hasMore: boolean;
}

export interface HistoryEntry {
  timestamp: string;
  action: string;
  userId?: string;
  userEmail?: string;
  changes: Array<{
    field: string;
    from: any;
    to: any;
  }>;
}

export interface AuditService {
  log(options: LogOptions): Promise<AuditLogEntry>;
  query(options: QueryOptions): Promise<QueryResult>;
  getHistory(resourceType: string, resourceId: string): Promise<HistoryEntry[]>;
  getById(id: string): Promise<AuditLogEntry | null>;
  getUserActivity(userId: string, limit?: number): Promise<AuditLogEntry[]>;
  purge(beforeDate: string): Promise<number>;
}

export const auditPlugin = createPlugin
  .withSchema<DB>()
  .define({
    name: "audit",
    version: "1.0.0",

    events: {
      "audit.logged": z.object({
        entryId: z.string(),
        action: z.string(),
        resourceType: z.string(),
        severity: z.string(),
      }),
    },

    customErrors: {
      AuditLogFailed: {
        status: 500,
        code: "AUDIT_LOG_FAILED",
        message: "Failed to create audit log entry",
      },
      EntryNotFound: {
        status: 404,
        code: "ENTRY_NOT_FOUND",
        message: "Audit log entry not found",
      },
    },

    service: async (ctx) => {
      const db = ctx.db;
      const logger = ctx.core.logger.child({ plugin: "audit" });
      const config = ctx.config.plugins?.audit || {};
      const retentionDays = config.retentionDays || 90;

      function generateEntryId(): string {
        return `aud_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      }

      function mapAuditEntry(row: any): AuditLogEntry {
        return {
          id: row.id,
          action: row.action,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          userId: row.user_id,
          userEmail: row.user_email,
          ipAddress: row.ip_address,
          userAgent: row.user_agent,
          before: row.before_data ? JSON.parse(row.before_data) : undefined,
          after: row.after_data ? JSON.parse(row.after_data) : undefined,
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
          severity: row.severity,
          createdAt: row.created_at,
        };
      }

      function computeChanges(before?: Record<string, any>, after?: Record<string, any>): Array<{field: string, from: any, to: any}> {
        if (!before || !after) return [];
        
        const changes: Array<{field: string, from: any, to: any}> = [];
        const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
        
        for (const key of allKeys) {
          if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
            changes.push({
              field: key,
              from: before[key],
              to: after[key],
            });
          }
        }
        
        return changes;
      }

      return {
        async log(options: LogOptions): Promise<AuditLogEntry> {
          const entryId = generateEntryId();
          const now = new Date().toISOString();

          try {
            const result = await db
              .insertInto("audit_log")
              .values({
                id: entryId,
                action: options.action,
                resource_type: options.resourceType,
                resource_id: options.resourceId || null,
                user_id: options.userId || null,
                user_email: options.userEmail || null,
                ip_address: options.ipAddress || null,
                user_agent: options.userAgent || null,
                before_data: options.before ? JSON.stringify(options.before) : null,
                after_data: options.after ? JSON.stringify(options.after) : null,
                metadata: options.metadata ? JSON.stringify(options.metadata) : null,
                severity: options.severity || "info",
                created_at: now,
              })
              .returningAll()
              .executeTakeFirstOrThrow();

            ctx.core.events.emit("audit.logged", {
              entryId: result.id,
              action: result.action,
              resourceType: result.resource_type,
              severity: result.severity,
            });

            logger.info({
              entryId: result.id,
              action: result.action,
              resourceType: result.resource_type,
              severity: result.severity,
            }, "Audit log entry created");

            return mapAuditEntry(result);
          } catch (error) {
            logger.error({ error, options }, "Failed to create audit log");
            throw ctx.core.errors.AuditLogFailed();
          }
        },

        async query(options: QueryOptions): Promise<QueryResult> {
          let query = db.selectFrom("audit_log").selectAll();
          let countQuery = db
            .selectFrom("audit_log")
            .select((eb) => eb.fn.count("id").as("count"));

          if (options.userId) {
            query = query.where("user_id", "=", options.userId);
            countQuery = countQuery.where("user_id", "=", options.userId);
          }

          if (options.resourceType) {
            query = query.where("resource_type", "=", options.resourceType);
            countQuery = countQuery.where("resource_type", "=", options.resourceType);
          }

          if (options.resourceId) {
            query = query.where("resource_id", "=", options.resourceId);
            countQuery = countQuery.where("resource_id", "=", options.resourceId);
          }

          if (options.action) {
            query = query.where("action", "=", options.action);
            countQuery = countQuery.where("action", "=", options.action);
          }

          if (options.severity) {
            query = query.where("severity", "=", options.severity);
            countQuery = countQuery.where("severity", "=", options.severity);
          }

          if (options.startDate) {
            query = query.where("created_at", ">=", options.startDate);
            countQuery = countQuery.where("created_at", ">=", options.startDate);
          }

          if (options.endDate) {
            query = query.where("created_at", "<=", options.endDate);
            countQuery = countQuery.where("created_at", "<=", options.endDate);
          }

          const limit = options.limit || 50;
          const offset = options.offset || 0;

          const [entries, countResult] = await Promise.all([
            query
              .orderBy("created_at", "desc")
              .limit(limit)
              .offset(offset)
              .execute(),
            countQuery.executeTakeFirst(),
          ]);

          const total = Number(countResult?.count || 0);

          return {
            entries: entries.map(mapAuditEntry),
            total,
            hasMore: total > offset + limit,
          };
        },

        async getHistory(resourceType: string, resourceId: string): Promise<HistoryEntry[]> {
          const entries = await db
            .selectFrom("audit_log")
            .selectAll()
            .where("resource_type", "=", resourceType)
            .where("resource_id", "=", resourceId)
            .where("before_data", "is not", null)
            .orderBy("created_at", "desc")
            .execute();

          return entries.map((row) => {
            const before = row.before_data ? JSON.parse(row.before_data) : undefined;
            const after = row.after_data ? JSON.parse(row.after_data) : undefined;
            
            return {
              timestamp: row.created_at,
              action: row.action,
              userId: row.user_id || undefined,
              userEmail: row.user_email || undefined,
              changes: computeChanges(before, after),
            };
          });
        },

        async getById(id: string): Promise<AuditLogEntry | null> {
          const entry = await db
            .selectFrom("audit_log")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();

          return entry ? mapAuditEntry(entry) : null;
        },

        async getUserActivity(userId: string, limit: number = 50): Promise<AuditLogEntry[]> {
          const entries = await db
            .selectFrom("audit_log")
            .selectAll()
            .where("user_id", "=", userId)
            .orderBy("created_at", "desc")
            .limit(limit)
            .execute();

          return entries.map(mapAuditEntry);
        },

        async purge(beforeDate: string): Promise<number> {
          const result = await db
            .deleteFrom("audit_log")
            .where("created_at", "<", beforeDate)
            .execute();

          const deletedCount = Number(result[0].numDeletedRows || 0);

          logger.info({ deletedCount, beforeDate }, "Audit log purged");

          return deletedCount;
        },
      };
    },
  });

export type { DB } from "./schema";
