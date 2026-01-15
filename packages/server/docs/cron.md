# Cron Service

Schedule recurring tasks using cron expressions. Supports standard 5-field and extended 6-field formats.

## Quick Start

```ts
// Run every minute
ctx.core.cron.schedule("* * * * *", () => {
  console.log("Every minute!");
});

// Run at midnight daily
ctx.core.cron.schedule("0 0 * * *", async () => {
  await generateDailyReport();
});
```

---

## API Reference

### Interface

```ts
interface Cron {
  schedule(
    expression: string,
    handler: () => void | Promise<void>,
    options?: { name?: string; enabled?: boolean }
  ): string;
  unschedule(taskId: string): boolean;
  pause(taskId: string): void;
  resume(taskId: string): void;
  list(): CronTask[];
  get(taskId: string): CronTask | undefined;
  trigger(taskId: string): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

interface CronTask {
  id: string;
  name: string;
  expression: string;
  handler: () => void | Promise<void>;
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
}
```

### Methods

| Method | Description |
|--------|-------------|
| `schedule(expr, handler, opts?)` | Create scheduled task, returns task ID |
| `unschedule(taskId)` | Remove task permanently |
| `pause(taskId)` | Temporarily disable task |
| `resume(taskId)` | Re-enable paused task |
| `list()` | Get all scheduled tasks |
| `get(taskId)` | Get specific task |
| `trigger(taskId)` | Execute task immediately |
| `start()` | Start the scheduler |
| `stop()` | Stop the scheduler |

---

## Cron Expression Format

### 5-Field Format (Standard)

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6, Sunday=0)
│ │ │ │ │
* * * * *
```

### 6-Field Format (With Seconds)

```
┌───────────── second (0-59)
│ ┌───────────── minute (0-59)
│ │ ┌───────────── hour (0-23)
│ │ │ ┌───────────── day of month (1-31)
│ │ │ │ ┌───────────── month (1-12)
│ │ │ │ │ ┌───────────── day of week (0-6)
│ │ │ │ │ │
* * * * * *
```

### Special Characters

| Character | Description | Example |
|-----------|-------------|---------|
| `*` | Any value | `* * * * *` (every minute) |
| `,` | Value list | `1,15,30 * * * *` (minutes 1, 15, 30) |
| `-` | Range | `9-17 * * * *` (hours 9 through 17) |
| `/` | Step | `*/5 * * * *` (every 5 minutes) |

---

## Common Patterns

```ts
// Every minute
"* * * * *"

// Every 5 minutes
"*/5 * * * *"

// Every hour at minute 0
"0 * * * *"

// Every day at midnight
"0 0 * * *"

// Every day at 9am
"0 9 * * *"

// Every Monday at 9am
"0 9 * * 1"

// Every weekday at 9am
"0 9 * * 1-5"

// First day of month at midnight
"0 0 1 * *"

// Every 30 seconds (6-field)
"*/30 * * * * *"

// Every hour, Monday-Friday, 9am-5pm
"0 9-17 * * 1-5"
```

---

## Usage Examples

### Basic Scheduling

```ts
// Schedule with auto-generated ID
const taskId = ctx.core.cron.schedule("0 * * * *", () => {
  console.log("Hourly task");
});

// Schedule with name for easier management
ctx.core.cron.schedule("0 0 * * *", async () => {
  await generateReport();
}, { name: "daily-report" });

// Schedule but start disabled
ctx.core.cron.schedule("*/5 * * * *", () => {
  console.log("This won't run until enabled");
}, { name: "optional-task", enabled: false });
```

### Managing Tasks

```ts
// List all tasks
const tasks = ctx.core.cron.list();
for (const task of tasks) {
  console.log(`${task.name}: ${task.expression} (${task.enabled ? "active" : "paused"})`);
  console.log(`  Last run: ${task.lastRun}`);
  console.log(`  Next run: ${task.nextRun}`);
}

// Pause a task
ctx.core.cron.pause(taskId);

// Resume a task
ctx.core.cron.resume(taskId);

// Remove a task
ctx.core.cron.unschedule(taskId);

// Trigger immediately (for testing)
await ctx.core.cron.trigger(taskId);
```

---

## Real-World Examples

### Daily Reports

```ts
// plugins/analytics/index.ts
service: async (ctx) => {
  // Generate daily analytics at 1am
  ctx.core.cron.schedule("0 1 * * *", async () => {
    ctx.core.logger.info("Generating daily analytics report");

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const stats = await ctx.db
      .selectFrom("events")
      .select([
        ctx.db.fn.count("id").as("totalEvents"),
        ctx.db.fn.countDistinct("userId").as("uniqueUsers"),
      ])
      .where("createdAt", ">=", yesterday.toISOString())
      .executeTakeFirst();

    await ctx.db.insertInto("daily_reports").values({
      date: yesterday.toISOString().split("T")[0],
      data: JSON.stringify(stats),
    }).execute();

    ctx.core.logger.info("Daily report generated", stats);
  }, { name: "daily-analytics" });

  return { /* analytics methods */ };
};
```

### Cache Cleanup

```ts
// Clean expired cache entries every hour
ctx.core.cron.schedule("0 * * * *", async () => {
  const expiredKeys = await ctx.core.cache.keys("temp:*");
  let cleaned = 0;

  for (const key of expiredKeys) {
    if (!(await ctx.core.cache.has(key))) {
      cleaned++;
    }
  }

  ctx.core.logger.debug("Cache cleanup", { checked: expiredKeys.length, cleaned });
}, { name: "cache-cleanup" });
```

### Health Checks

```ts
// Check external service health every 5 minutes
ctx.core.cron.schedule("*/5 * * * *", async () => {
  const services = ["api.stripe.com", "api.sendgrid.com", "s3.amazonaws.com"];

  for (const service of services) {
    try {
      const start = Date.now();
      const response = await fetch(`https://${service}/health`);
      const latency = Date.now() - start;

      if (response.ok) {
        ctx.core.logger.debug("Health check passed", { service, latency });
      } else {
        ctx.core.logger.warn("Health check degraded", { service, status: response.status });
      }
    } catch (error) {
      ctx.core.logger.error("Health check failed", { service, error: error.message });
      await ctx.core.events.emit("health.check.failed", { service, error: error.message });
    }
  }
}, { name: "health-checks" });
```

### Data Synchronization

```ts
// Sync data from external API every 15 minutes
ctx.core.cron.schedule("*/15 * * * *", async () => {
  ctx.core.logger.info("Starting data sync");

  try {
    const response = await fetch("https://api.external.com/products");
    const products = await response.json();

    for (const product of products) {
      await ctx.db
        .insertInto("products")
        .values(product)
        .onConflict((oc) => oc.column("externalId").doUpdateSet(product))
        .execute();
    }

    ctx.core.logger.info("Data sync completed", { count: products.length });
  } catch (error) {
    ctx.core.logger.error("Data sync failed", { error: error.message });
  }
}, { name: "product-sync" });
```

### Scheduled Notifications

```ts
// Send weekly digest every Monday at 9am
ctx.core.cron.schedule("0 9 * * 1", async () => {
  const users = await ctx.db
    .selectFrom("users")
    .where("weeklyDigest", "=", true)
    .execute();

  for (const user of users) {
    await ctx.core.jobs.enqueue("sendWeeklyDigest", {
      userId: user.id,
      email: user.email,
    });
  }

  ctx.core.logger.info("Weekly digest queued", { users: users.length });
}, { name: "weekly-digest" });
```

---

## Error Handling

Task errors are logged but don't stop other tasks:

```ts
ctx.core.cron.schedule("* * * * *", async () => {
  throw new Error("Task failed");
});
// Error is logged: [Cron] Task "cron_1_..." failed: Task failed
// Task continues to run on next schedule
```

For critical tasks, implement retry logic:

```ts
ctx.core.cron.schedule("0 * * * *", async () => {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await criticalOperation();
      return; // Success
    } catch (error) {
      ctx.core.logger.warn("Task attempt failed", { attempt, error: error.message });

      if (attempt === maxRetries) {
        ctx.core.logger.error("Task failed after retries", { maxRetries });
        await ctx.core.events.emit("cron.task.failed", {
          task: "critical-operation",
          error: error.message,
        });
      } else {
        await new Promise((r) => setTimeout(r, 1000 * attempt)); // Backoff
      }
    }
  }
}, { name: "critical-operation" });
```

---

## Testing Cron Tasks

```ts
import { createCron } from "./core/cron";

describe("Cron Tasks", () => {
  it("should execute task on trigger", async () => {
    const cron = createCron();
    let executed = false;

    const taskId = cron.schedule("0 0 1 1 *", () => {
      executed = true;
    });

    // Manually trigger instead of waiting
    await cron.trigger(taskId);

    expect(executed).toBe(true);

    await cron.stop();
  });
});
```

---

## Best Practices

### 1. Name Your Tasks

```ts
// Good - identifiable in logs and list()
ctx.core.cron.schedule("0 * * * *", handler, { name: "hourly-cleanup" });

// Bad - auto-generated IDs are hard to track
ctx.core.cron.schedule("0 * * * *", handler);
```

### 2. Log Task Execution

```ts
ctx.core.cron.schedule("0 0 * * *", async () => {
  const start = Date.now();
  ctx.core.logger.info("Daily task starting");

  try {
    await processDaily();
    ctx.core.logger.info("Daily task completed", { duration: Date.now() - start });
  } catch (error) {
    ctx.core.logger.error("Daily task failed", { error: error.message });
  }
}, { name: "daily-process" });
```

### 3. Use Jobs for Heavy Work

```ts
// Good - cron schedules, jobs process
ctx.core.cron.schedule("0 0 * * *", async () => {
  const users = await ctx.db.selectFrom("users").execute();

  for (const user of users) {
    // Queue each as separate job
    await ctx.core.jobs.enqueue("processUser", { userId: user.id });
  }
});

// Bad - long-running cron task
ctx.core.cron.schedule("0 0 * * *", async () => {
  const users = await ctx.db.selectFrom("users").execute();

  for (const user of users) {
    await heavyProcessing(user); // Blocks cron
  }
});
```

### 4. Consider Time Zones

```ts
// Be explicit about timing expectations
// This runs at midnight server time
ctx.core.cron.schedule("0 0 * * *", handler, { name: "midnight-task" });

// Document if specific timezone is needed
// TODO: Runs at midnight UTC - adjust for local time if needed
```

### 5. Monitor Task Health

```ts
ctx.core.cron.schedule("*/5 * * * *", async () => {
  // Emit metrics for monitoring
  const tasks = ctx.core.cron.list();

  for (const task of tasks) {
    if (task.lastRun) {
      const timeSinceRun = Date.now() - task.lastRun.getTime();
      await ctx.core.events.emit("cron.task.metric", {
        name: task.name,
        enabled: task.enabled,
        timeSinceLastRun: timeSinceRun,
      });
    }
  }
}, { name: "cron-monitor" });
```
