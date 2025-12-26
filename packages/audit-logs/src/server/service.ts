import { Kysely, sql } from "kysely";
import type { AuditLogDB, LogEntryRow, NewLogEntry } from "./db";
import type {
  LogEntry,
  LogEntryInput,
  LogQueryFilters,
  PaginatedResult,
  LogStats,
  UserActivitySummary,
  LogLevel,
  RetentionConfig,
  TraceSummary,
} from "../shared/types";
import { LOG_LEVEL_PRIORITY, DEFAULT_RETENTION } from "../shared/types";
import { Redactor } from "./redactor";
import type { IAuditLogService } from "../logger";

/**
 * Generates a unique ID for log entries
 */
function generateLogId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `log_${timestamp}_${random}`;
}

/**
 * Escape SQL LIKE wildcards (%, _) in a string to prevent injection
 * Uses backslash escaping which works in SQLite with ESCAPE '\'
 */
function escapeLikePattern(pattern: string): string {
  return pattern.replace(/[%_\\]/g, "\\$&");
}

/**
 * Convert database row to LogEntry type
 */
function rowToLogEntry(row: LogEntryRow): LogEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    level: row.level as LogLevel,
    event: row.event,
    userId: row.user_id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    username: row.username,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    geoCountry: row.geo_country,
    geoCity: row.geo_city,
    method: row.method,
    path: row.path,
    statusCode: row.status_code,
    durationMs: row.duration_ms,
    metadata: row.metadata,
    message: row.message,
    traceId: row.trace_id,
  };
}

export class AuditLogService implements IAuditLogService {
  private db: Kysely<AuditLogDB>;
  private redactor: Redactor;
  private retention: RetentionConfig;
  private onLog?: (entry: LogEntry) => void;

  constructor(
    db: Kysely<AuditLogDB>,
    redactor: Redactor,
    retention: RetentionConfig = DEFAULT_RETENTION,
    onLog?: (entry: LogEntry) => void
  ) {
    this.db = db;
    this.redactor = redactor;
    this.retention = retention;
    this.onLog = onLog;
  }

  /**
   * Set callback for new log entries (used by WebSocket hub)
   */
  setOnLog(callback: (entry: LogEntry) => void): void {
    this.onLog = callback;
  }

  /**
   * Log a single entry
   */
  async log(input: LogEntryInput): Promise<string> {
    const id = generateLogId();
    const timestamp = Date.now();

    // Redact metadata if present
    const metadata = input.metadata ? this.redactor.redactJSON(JSON.stringify(input.metadata)) : null;

    const entry: NewLogEntry = {
      id,
      timestamp,
      level: input.level ?? "info",
      event: input.event,
      user_id: input.userId ?? null,
      company_id: input.companyId ?? null,
      employee_id: input.employeeId ?? null,
      username: input.username ?? null,
      ip_address: input.ipAddress ?? null,
      user_agent: input.userAgent ?? null,
      geo_country: input.geoCountry ?? null,
      geo_city: input.geoCity ?? null,
      method: input.method ?? null,
      path: input.path ?? null,
      status_code: input.statusCode ?? null,
      duration_ms: input.durationMs ?? null,
      metadata,
      message: input.message ?? null,
      trace_id: input.traceId ?? null,
    };

    await this.db.insertInto("log_entry").values(entry).execute();

    // Notify WebSocket hub
    if (this.onLog) {
      const logEntry = rowToLogEntry(entry as LogEntryRow);
      this.onLog(logEntry);
    }

    return id;
  }

  /**
   * Log multiple entries in a batch
   */
  async logBatch(inputs: LogEntryInput[]): Promise<void> {
    if (inputs.length === 0) return;

    const timestamp = Date.now();
    const entries: NewLogEntry[] = inputs.map((input, i) => ({
      id: generateLogId() + i.toString(36),
      timestamp: timestamp + i, // Ensure unique timestamps for ordering
      level: input.level ?? "info",
      event: input.event,
      user_id: input.userId ?? null,
      company_id: input.companyId ?? null,
      employee_id: input.employeeId ?? null,
      username: input.username ?? null,
      ip_address: input.ipAddress ?? null,
      user_agent: input.userAgent ?? null,
      geo_country: input.geoCountry ?? null,
      geo_city: input.geoCity ?? null,
      method: input.method ?? null,
      path: input.path ?? null,
      status_code: input.statusCode ?? null,
      duration_ms: input.durationMs ?? null,
      metadata: input.metadata ? this.redactor.redactJSON(JSON.stringify(input.metadata)) : null,
      message: input.message ?? null,
      trace_id: input.traceId ?? null,
    }));

    await this.db.insertInto("log_entry").values(entries).execute();

    // Notify WebSocket hub for each entry
    if (this.onLog) {
      for (const entry of entries) {
        const logEntry = rowToLogEntry(entry as LogEntryRow);
        this.onLog(logEntry);
      }
    }
  }

  /**
   * Query logs with filters and pagination
   */
  async query(filters: Partial<LogQueryFilters> = {}): Promise<PaginatedResult<LogEntry>> {
    let query = this.db.selectFrom("log_entry");

    // Apply filters
    if (filters.startTime !== undefined) {
      query = query.where("timestamp", ">=", filters.startTime);
    }
    if (filters.endTime !== undefined) {
      query = query.where("timestamp", "<=", filters.endTime);
    }
    if (filters.userId !== undefined) {
      query = query.where("user_id", "=", filters.userId);
    }
    if (filters.companyId !== undefined) {
      query = query.where("company_id", "=", filters.companyId);
    }
    if (filters.employeeId !== undefined) {
      query = query.where("employee_id", "=", filters.employeeId);
    }
    if (filters.username !== undefined) {
      query = query.where("username", "=", filters.username);
    }
    if (filters.ipAddress !== undefined) {
      query = query.where("ip_address", "=", filters.ipAddress);
    }
    if (filters.event !== undefined) {
      if (filters.event.endsWith("*")) {
        // Prefix match - escape SQL wildcards in the prefix to prevent injection
        const prefix = escapeLikePattern(filters.event.slice(0, -1));
        query = query.where(sql<boolean>`event LIKE ${prefix + "%"} ESCAPE '\\'`);
      } else {
        query = query.where("event", "=", filters.event);
      }
    }
    if (filters.events && filters.events.length > 0) {
      query = query.where((eb) => {
        const conditions = filters.events!.map((event) => {
          if (event.endsWith("*")) {
            // Escape SQL wildcards in the prefix to prevent injection
            const prefix = escapeLikePattern(event.slice(0, -1));
            return sql<boolean>`event LIKE ${prefix + "%"} ESCAPE '\\'`;
          }
          return eb("event", "=", event);
        });
        return eb.or(conditions);
      });
    }
    if (filters.level !== undefined) {
      query = query.where("level", "=", filters.level);
    }
    if (filters.levels && filters.levels.length > 0) {
      query = query.where("level", "in", filters.levels);
    }
    if (filters.minLevel !== undefined) {
      const minPriority = LOG_LEVEL_PRIORITY[filters.minLevel];
      const validLevels = Object.entries(LOG_LEVEL_PRIORITY)
        .filter(([, priority]) => priority >= minPriority)
        .map(([level]) => level);
      query = query.where("level", "in", validLevels);
    }
    if (filters.method !== undefined) {
      query = query.where("method", "=", filters.method);
    }
    if (filters.path !== undefined) {
      // Escape SQL wildcards in path to prevent injection
      const escapedPath = escapeLikePattern(filters.path);
      query = query.where(sql<boolean>`path LIKE ${"%" + escapedPath + "%"} ESCAPE '\\'`);
    }
    if (filters.traceId !== undefined) {
      query = query.where("trace_id", "=", filters.traceId);
    }

    // Get total count
    const countResult = await query
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirst();
    const total = countResult?.count ?? 0;

    // Apply sorting
    const sortColumn = filters.sortBy ?? "timestamp";
    const sortOrder = filters.sortOrder ?? "desc";
    query = query.orderBy(sortColumn, sortOrder);

    // Apply pagination
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;
    query = query.limit(limit).offset(offset);

    // Execute query
    const rows = await query.selectAll().execute();
    const data = rows.map(rowToLogEntry);

    return {
      data,
      total,
      limit,
      offset,
      hasMore: offset + data.length < total,
    };
  }

  /**
   * Full-text search logs
   */
  async search(text: string, filters?: Partial<LogQueryFilters>): Promise<PaginatedResult<LogEntry>> {
    // Validate search text to prevent FTS5 injection and performance issues
    if (!text || typeof text !== "string") {
      throw new Error("Search text must be a non-empty string");
    }

    const trimmedText = text.trim();
    if (trimmedText.length === 0) {
      throw new Error("Search text cannot be empty");
    }

    if (trimmedText.length > 1000) {
      throw new Error("Search text too long (max 1000 characters)");
    }

    // Sanitize FTS5 search text by escaping special characters
    // FTS5 special chars: " * ( ) [ ] { } : AND OR NOT NEAR
    const sanitizedText = trimmedText.replace(/["*()[\]{}:]/g, " ");

    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;

    // Use FTS5 for search
    let query = sql<LogEntryRow & { rank: number }>`
      SELECT log_entry.*, log_entry_fts.rank
      FROM log_entry_fts
      INNER JOIN log_entry ON log_entry.rowid = log_entry_fts.rowid
      WHERE log_entry_fts MATCH ${sanitizedText}
    `;

    // Add additional filters
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters?.startTime !== undefined) {
      conditions.push("log_entry.timestamp >= ?");
      params.push(filters.startTime);
    }
    if (filters?.endTime !== undefined) {
      conditions.push("log_entry.timestamp <= ?");
      params.push(filters.endTime);
    }
    if (filters?.userId !== undefined) {
      conditions.push("log_entry.user_id = ?");
      params.push(filters.userId);
    }
    if (filters?.companyId !== undefined) {
      conditions.push("log_entry.company_id = ?");
      params.push(filters.companyId);
    }
    if (filters?.level !== undefined) {
      conditions.push("log_entry.level = ?");
      params.push(filters.level);
    }
    if (filters?.minLevel !== undefined) {
      const minPriority = LOG_LEVEL_PRIORITY[filters.minLevel];
      const validLevels = Object.entries(LOG_LEVEL_PRIORITY)
        .filter(([, priority]) => priority >= minPriority)
        .map(([level]) => `'${level}'`);
      conditions.push(`log_entry.level IN (${validLevels.join(", ")})`);
    }

    // Build full query
    let fullQuery = query;
    if (conditions.length > 0) {
      fullQuery = sql`${query} AND ${sql.raw(conditions.join(" AND "))}`;
    }

    // Count query
    const countQuery = sql<{ count: number }>`
      SELECT COUNT(*) as count FROM (${fullQuery})
    `;
    const countResult = await countQuery.execute(this.db);
    const total = countResult.rows[0]?.count ?? 0;

    // Add ordering and pagination
    const sortOrder = filters?.sortOrder === "asc" ? "ASC" : "DESC";
    fullQuery = sql`${fullQuery} ORDER BY rank, timestamp ${sql.raw(sortOrder)} LIMIT ${limit} OFFSET ${offset}`;

    const result = await fullQuery.execute(this.db);
    const data = result.rows.map((row) => rowToLogEntry(row as LogEntryRow));

    return {
      data,
      total,
      limit,
      offset,
      hasMore: offset + data.length < total,
    };
  }

  /**
   * Get aggregated statistics
   */
  async getStats(filters: Partial<LogQueryFilters>): Promise<LogStats> {
    let baseQuery = this.db.selectFrom("log_entry");

    // Apply time filters
    if (filters.startTime !== undefined) {
      baseQuery = baseQuery.where("timestamp", ">=", filters.startTime);
    }
    if (filters.endTime !== undefined) {
      baseQuery = baseQuery.where("timestamp", "<=", filters.endTime);
    }
    if (filters.companyId !== undefined) {
      baseQuery = baseQuery.where("company_id", "=", filters.companyId);
    }

    // Total count
    const totalResult = await baseQuery
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirst();
    const totalLogs = totalResult?.count ?? 0;

    // Count by level
    const levelCounts = await baseQuery
      .select(["level", (eb) => eb.fn.countAll<number>().as("count")])
      .groupBy("level")
      .execute();

    const byLevel: Record<LogLevel, number> = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
      security: 0,
    };
    for (const row of levelCounts) {
      byLevel[row.level as LogLevel] = row.count;
    }

    // Top events
    const eventCounts = await baseQuery
      .select(["event", (eb) => eb.fn.countAll<number>().as("count")])
      .groupBy("event")
      .orderBy("count", "desc")
      .limit(20)
      .execute();

    const byEvent = eventCounts.map((row) => ({
      event: row.event,
      count: row.count,
    }));

    // Top users
    const userCounts = await baseQuery
      .select(["user_id", "username", (eb) => eb.fn.countAll<number>().as("count")])
      .where("user_id", "is not", null)
      .groupBy(["user_id", "username"])
      .orderBy("count", "desc")
      .limit(20)
      .execute();

    const byUser = userCounts.map((row) => ({
      userId: row.user_id!,
      username: row.username,
      count: row.count,
    }));

    // Time range
    const timeRange = await baseQuery
      .select([
        (eb) => eb.fn.min("timestamp").as("start"),
        (eb) => eb.fn.max("timestamp").as("end"),
      ])
      .executeTakeFirst();

    return {
      totalLogs,
      byLevel,
      byEvent,
      byUser,
      timeRange: timeRange?.start && timeRange?.end
        ? { start: timeRange.start as number, end: timeRange.end as number }
        : null,
    };
  }

  /**
   * Get activity summary for a specific user
   */
  async getUserActivity(userId: number, days: number = 30): Promise<UserActivitySummary> {
    const startTime = Date.now() - days * 24 * 60 * 60 * 1000;

    // Get user info and counts
    const summary = await this.db
      .selectFrom("log_entry")
      .select([
        "username",
        (eb) => eb.fn.countAll<number>().as("totalActions"),
        (eb) => eb.fn.min("timestamp").as("firstSeen"),
        (eb) => eb.fn.max("timestamp").as("lastSeen"),
      ])
      .where("user_id", "=", userId)
      .where("timestamp", ">=", startTime)
      .groupBy("username")
      .executeTakeFirst();

    // Get top events
    const topEvents = await this.db
      .selectFrom("log_entry")
      .select(["event", (eb) => eb.fn.countAll<number>().as("count")])
      .where("user_id", "=", userId)
      .where("timestamp", ">=", startTime)
      .groupBy("event")
      .orderBy("count", "desc")
      .limit(10)
      .execute();

    // Get recent logs
    const recentLogs = await this.db
      .selectFrom("log_entry")
      .selectAll()
      .where("user_id", "=", userId)
      .orderBy("timestamp", "desc")
      .limit(20)
      .execute();

    return {
      userId,
      username: summary?.username ?? null,
      totalActions: summary?.totalActions ?? 0,
      firstSeen: (summary?.firstSeen as number) ?? 0,
      lastSeen: (summary?.lastSeen as number) ?? 0,
      topEvents: topEvents.map((row) => ({ event: row.event, count: row.count })),
      recentLogs: recentLogs.map(rowToLogEntry),
    };
  }

  /**
   * Get retention configuration
   */
  async getRetention(): Promise<RetentionConfig> {
    const configRows = await this.db.selectFrom("retention_config").selectAll().execute();

    // Start with defaults
    const config: RetentionConfig = { ...DEFAULT_RETENTION };

    // Override with database values
    for (const row of configRows) {
      const level = row.level as keyof RetentionConfig;
      if (level === "default") {
        config.default = row.retention_months;
      } else if (level === "security" || level === "error" || level === "warn" || level === "info" || level === "debug") {
        config[level] = row.retention_months;
      }
    }

    return config;
  }

  /**
   * Set retention configuration
   */
  async setRetention(config: RetentionConfig): Promise<RetentionConfig> {
    // Validate retention months (1-120 months = 1 month to 10 years)
    const MIN_RETENTION_MONTHS = 1;
    const MAX_RETENTION_MONTHS = 120;

    const validateMonths = (months: number | undefined, level: string): void => {
      if (months === undefined) return;
      if (!Number.isInteger(months) || months < MIN_RETENTION_MONTHS || months > MAX_RETENTION_MONTHS) {
        throw new Error(
          `Invalid retention for ${level}: ${months}. Must be an integer between ${MIN_RETENTION_MONTHS} and ${MAX_RETENTION_MONTHS} months.`
        );
      }
    };

    // Validate all retention values
    validateMonths(config.default, "default");
    validateMonths(config.security, "security");
    validateMonths(config.error, "error");
    validateMonths(config.warn, "warn");
    validateMonths(config.info, "info");
    validateMonths(config.debug, "debug");

    // Update in-memory retention
    this.retention = config;

    // Upsert each level's retention
    const levels = ["default", "security", "error", "warn", "info", "debug"] as const;

    for (const level of levels) {
      const months = level === "default" ? config.default : config[level as keyof RetentionConfig];
      if (months === undefined) continue;

      // Check if exists
      const existing = await this.db
        .selectFrom("retention_config")
        .selectAll()
        .where("level", "=", level)
        .executeTakeFirst();

      if (existing) {
        await this.db
          .updateTable("retention_config")
          .set({ retention_months: months })
          .where("level", "=", level)
          .execute();
      } else {
        await this.db
          .insertInto("retention_config")
          .values({ level, retention_months: months })
          .execute();
      }
    }

    return config;
  }

  /**
   * Clean up old logs based on retention policy
   */
  async cleanupOldLogs(): Promise<{ deleted: number; byLevel: Record<string, number> }> {
    const now = Date.now();
    const byLevel: Record<string, number> = {};
    let totalDeleted = 0;

    // Get retention config from database
    const config = await this.getRetention();

    // Convert months to milliseconds for cleanup
    const levels = ["debug", "info", "warn", "error", "security"] as const;

    for (const level of levels) {
      const months = config[level] ?? config.default;
      // Convert months to milliseconds (approximately 30 days per month)
      const cutoff = now - months * 30 * 24 * 60 * 60 * 1000;

      const result = await this.db
        .deleteFrom("log_entry")
        .where("level", "=", level)
        .where("timestamp", "<", cutoff)
        .execute();

      const deleted = Number(result[0]?.numDeletedRows ?? 0);
      byLevel[level] = deleted;
      totalDeleted += deleted;
    }

    return { deleted: totalDeleted, byLevel };
  }

  /**
   * Get a single log entry by ID
   */
  async getById(id: string): Promise<LogEntry | null> {
    const row = await this.db
      .selectFrom("log_entry")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? rowToLogEntry(row) : null;
  }

  /**
   * Get logs by trace ID (for correlating related logs)
   */
  async getByTraceId(traceId: string): Promise<LogEntry[]> {
    const rows = await this.db
      .selectFrom("log_entry")
      .selectAll()
      .where("trace_id", "=", traceId)
      .orderBy("timestamp", "asc")
      .execute();

    return rows.map(rowToLogEntry);
  }

  /**
   * Query traces (grouped by trace_id) with pagination
   * Returns trace summaries for the main audit log view
   */
  async queryTraces(filters: Partial<LogQueryFilters> = {}): Promise<PaginatedResult<TraceSummary>> {
    // Base query to get trace summaries
    // For batch requests, prefer showing /api/batch as the main path instead of sub-requests
    let query = this.db
      .selectFrom("log_entry")
      .select([
        "trace_id",
        (eb) => eb.fn.min("timestamp").as("start_time"),
        (eb) => eb.fn.max("timestamp").as("end_time"),
        (eb) => eb.fn.countAll<number>().as("log_count"),
        // Get method - prefer /api/batch entry if present
        sql<string>`COALESCE(
          (SELECT method FROM log_entry le2 WHERE le2.trace_id = log_entry.trace_id AND le2.path = '/api/batch' LIMIT 1),
          MAX(method)
        )`.as("method"),
        // Get path - prefer /api/batch if present (this is the parent batch request)
        sql<string>`COALESCE(
          (SELECT path FROM log_entry le2 WHERE le2.trace_id = log_entry.trace_id AND le2.path = '/api/batch' LIMIT 1),
          MAX(path)
        )`.as("path"),
        (eb) => eb.fn.max("user_id").as("user_id"),
        (eb) => eb.fn.max("username").as("username"),
        (eb) => eb.fn.max("employee_id").as("employee_id"),
        (eb) => eb.fn.max("ip_address").as("ip_address"),
        // Get status_code - prefer /api/batch entry if present
        sql<number>`COALESCE(
          (SELECT status_code FROM log_entry le2 WHERE le2.trace_id = log_entry.trace_id AND le2.path = '/api/batch' LIMIT 1),
          MAX(status_code)
        )`.as("status_code"),
        // Get duration_ms - prefer /api/batch entry if present
        sql<number>`COALESCE(
          (SELECT duration_ms FROM log_entry le2 WHERE le2.trace_id = log_entry.trace_id AND le2.path = '/api/batch' LIMIT 1),
          MAX(duration_ms)
        )`.as("duration_ms"),
        // Get the highest severity level using CASE expression
        sql<string>`MAX(CASE level
          WHEN 'security' THEN 5
          WHEN 'error' THEN 4
          WHEN 'warn' THEN 3
          WHEN 'info' THEN 2
          WHEN 'debug' THEN 1
          ELSE 0 END)`.as("max_level_priority"),
        sql<string>`(SELECT level FROM log_entry le2 WHERE le2.trace_id = log_entry.trace_id
          ORDER BY CASE level WHEN 'security' THEN 5 WHEN 'error' THEN 4 WHEN 'warn' THEN 3 WHEN 'info' THEN 2 WHEN 'debug' THEN 1 ELSE 0 END DESC LIMIT 1)`.as("highest_level"),
      ])
      .where("trace_id", "is not", null);

    // Apply level filter before grouping (filter traces that contain logs with this level)
    if (filters.level !== undefined) {
      // Only include traces that have at least one log with this level
      query = query.where(sql<boolean>`trace_id IN (SELECT DISTINCT trace_id FROM log_entry WHERE level = ${filters.level} AND trace_id IS NOT NULL)`);
    }
    if (filters.levels !== undefined && filters.levels.length > 0) {
      // Validate levels to prevent SQL injection
      const VALID_LEVELS = ['debug', 'info', 'warn', 'error', 'security'] as const;
      const validLevels = filters.levels.filter(l => VALID_LEVELS.includes(l as typeof VALID_LEVELS[number]));

      if (validLevels.length > 0) {
        // Only include traces that have at least one log with any of these levels
        // Use proper parameterized queries instead of string concatenation
        const conditions = validLevels.map(level => sql<boolean>`level = ${level}`);
        const levelCondition = conditions.reduce((acc, cond, i) =>
          i === 0 ? cond : sql<boolean>`${acc} OR ${cond}`
        );
        query = query.where(sql<boolean>`trace_id IN (SELECT DISTINCT trace_id FROM log_entry WHERE (${levelCondition}) AND trace_id IS NOT NULL)`);
      }
    }

    // Apply user/context filters using subqueries (before GROUP BY)
    // This is more efficient and avoids SQLite HAVING clause issues
    if (filters.userId !== undefined) {
      query = query.where(sql<boolean>`trace_id IN (SELECT trace_id FROM log_entry WHERE user_id = ${filters.userId} AND trace_id IS NOT NULL)`);
    }
    if (filters.companyId !== undefined) {
      query = query.where(sql<boolean>`trace_id IN (SELECT trace_id FROM log_entry WHERE company_id = ${filters.companyId} AND trace_id IS NOT NULL)`);
    }
    if (filters.employeeId !== undefined) {
      query = query.where(sql<boolean>`trace_id IN (SELECT trace_id FROM log_entry WHERE employee_id = ${filters.employeeId} AND trace_id IS NOT NULL)`);
    }
    if (filters.username !== undefined) {
      query = query.where(sql<boolean>`trace_id IN (SELECT trace_id FROM log_entry WHERE username = ${filters.username} AND trace_id IS NOT NULL)`);
    }
    if (filters.method !== undefined) {
      query = query.where(sql<boolean>`trace_id IN (SELECT trace_id FROM log_entry WHERE method = ${filters.method} AND trace_id IS NOT NULL)`);
    }
    if (filters.path !== undefined) {
      // Escape SQL wildcards in path to prevent injection
      const escapedPath = escapeLikePattern(filters.path);
      query = query.where(sql<boolean>`trace_id IN (SELECT trace_id FROM log_entry WHERE path LIKE ${"%" + escapedPath + "%"} ESCAPE '\\' AND trace_id IS NOT NULL)`);
    }

    query = query.groupBy("trace_id");

    // Apply time filters using HAVING (these work correctly with aggregates)
    if (filters.startTime !== undefined) {
      query = query.having(sql<boolean>`MIN(timestamp) >= ${filters.startTime}`);
    }
    if (filters.endTime !== undefined) {
      query = query.having(sql<boolean>`MAX(timestamp) <= ${filters.endTime}`);
    }

    // Count total traces using the same filtering approach
    // Use subqueries for user/context filters to avoid SQLite HAVING issues
    const levelFilterClause = filters.level !== undefined
      ? sql`AND trace_id IN (SELECT DISTINCT trace_id FROM log_entry WHERE level = ${filters.level} AND trace_id IS NOT NULL)`
      : filters.levels !== undefined && filters.levels.length > 0
        ? sql`AND trace_id IN (SELECT DISTINCT trace_id FROM log_entry WHERE level IN (${sql.raw(filters.levels.map(l => `'${l}'`).join(","))}) AND trace_id IS NOT NULL)`
        : sql``;
    const userIdFilterClause = filters.userId !== undefined
      ? sql`AND trace_id IN (SELECT trace_id FROM log_entry WHERE user_id = ${filters.userId} AND trace_id IS NOT NULL)`
      : sql``;
    const usernameFilterClause = filters.username !== undefined
      ? sql`AND trace_id IN (SELECT trace_id FROM log_entry WHERE username = ${filters.username} AND trace_id IS NOT NULL)`
      : sql``;
    const methodFilterClause = filters.method !== undefined
      ? sql`AND trace_id IN (SELECT trace_id FROM log_entry WHERE method = ${filters.method} AND trace_id IS NOT NULL)`
      : sql``;

    const countQuery = sql<{ count: number }>`
      SELECT COUNT(*) as count FROM (
        SELECT trace_id FROM log_entry
        WHERE trace_id IS NOT NULL
        ${levelFilterClause}
        ${userIdFilterClause}
        ${usernameFilterClause}
        ${methodFilterClause}
        GROUP BY trace_id
        ${filters.startTime !== undefined ? sql`HAVING MIN(timestamp) >= ${filters.startTime}` : sql``}
        ${filters.endTime !== undefined ? sql`AND MAX(timestamp) <= ${filters.endTime}` : sql``}
      )
    `;
    const countResult = await countQuery.execute(this.db);
    const total = countResult.rows[0]?.count ?? 0;

    // Apply sorting and pagination
    const sortOrder = filters.sortOrder ?? "desc";
    query = query.orderBy("start_time", sortOrder);

    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;
    query = query.limit(limit).offset(offset);

    // Execute query
    const rows = await query.execute();

    const data: TraceSummary[] = rows.map((row) => ({
      traceId: row.trace_id!,
      startTime: row.start_time as number,
      endTime: row.end_time as number,
      durationMs: (row.end_time as number) - (row.start_time as number),
      logCount: row.log_count,
      method: row.method ?? undefined,
      path: row.path ?? undefined,
      userId: row.user_id ?? undefined,
      username: row.username ?? undefined,
      employeeId: row.employee_id ?? undefined,
      ipAddress: row.ip_address ?? undefined,
      statusCode: row.status_code ?? undefined,
      requestDurationMs: row.duration_ms ?? undefined,
      highestLevel: (row.highest_level as LogLevel) ?? "info",
    }));

    return {
      data,
      total,
      limit,
      offset,
      hasMore: offset + data.length < total,
    };
  }
}
