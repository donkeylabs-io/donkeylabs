# Jobs Service

Background job queue for processing tasks asynchronously with automatic retries, scheduling, and event integration.

## Quick Start

```ts
// Register a job handler
ctx.core.jobs.register("sendEmail", async (data) => {
  await emailService.send(data.to, data.subject, data.body);
});

// Enqueue a job for immediate processing
await ctx.core.jobs.enqueue("sendEmail", {
  to: "user@example.com",
  subject: "Welcome!",
  body: "Thanks for signing up.",
});

// Schedule a job for later
await ctx.core.jobs.schedule("sendEmail", data, new Date(Date.now() + 3600000));
```

---

## API Reference

### Interface

```ts
interface Jobs {
  register<T = any, R = any>(name: string, handler: JobHandler<T, R>): void;
  enqueue<T = any>(name: string, data: T, options?: { maxAttempts?: number }): Promise<string>;
  schedule<T = any>(name: string, data: T, runAt: Date, options?: { maxAttempts?: number }): Promise<string>;
  get(jobId: string): Promise<Job | null>;
  cancel(jobId: string): Promise<boolean>;
  getByName(name: string, status?: JobStatus): Promise<Job[]>;
  start(): void;
  stop(): Promise<void>;
}

type JobStatus = "pending" | "running" | "completed" | "failed" | "scheduled";

interface Job {
  id: string;
  name: string;
  data: any;
  status: JobStatus;
  createdAt: Date;
  runAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: any;
  error?: string;
  attempts: number;
  maxAttempts: number;
}
```

### Methods

| Method | Description |
|--------|-------------|
| `register(name, handler)` | Register a job handler |
| `enqueue(name, data, opts?)` | Queue job for immediate processing |
| `schedule(name, data, runAt, opts?)` | Queue job for future execution |
| `get(jobId)` | Get job by ID |
| `cancel(jobId)` | Cancel pending/scheduled job |
| `getByName(name, status?)` | Find jobs by name and optional status |
| `start()` | Start processing jobs |
| `stop()` | Stop processing (waits for active jobs) |

---

## Configuration

```ts
const server = new AppServer({
  db,
  jobs: {
    concurrency: 5,        // Max parallel jobs (default: 5)
    pollInterval: 1000,    // Check interval in ms (default: 1000)
    maxAttempts: 3,        // Default retry attempts (default: 3)
  },
});
```

---

## Usage Examples

### Registering Handlers

```ts
// plugins/email/index.ts
service: async (ctx) => {
  // Register job handler during plugin init
  ctx.core.jobs.register("sendEmail", async (data: {
    to: string;
    subject: string;
    body: string;
    template?: string;
  }) => {
    const html = data.template
      ? await renderTemplate(data.template, data)
      : data.body;

    const result = await emailProvider.send({
      to: data.to,
      subject: data.subject,
      html,
    });

    return { messageId: result.id };
  });

  return {
    async sendWelcome(email: string, name: string) {
      return ctx.core.jobs.enqueue("sendEmail", {
        to: email,
        subject: "Welcome!",
        template: "welcome",
        name,
      });
    },
  };
};
```

### Enqueuing Jobs

```ts
// From route handlers
router.route("register").typed({
  handle: async (input, ctx) => {
    const user = await ctx.db.insertInto("users").values(input).execute();

    // Queue welcome email
    await ctx.core.jobs.enqueue("sendEmail", {
      to: input.email,
      subject: "Welcome!",
      body: `Hi ${input.name}, thanks for signing up!`,
    });

    // Queue with custom retry settings
    await ctx.core.jobs.enqueue("syncToMailchimp", {
      email: input.email,
      name: input.name,
    }, { maxAttempts: 5 });

    return user;
  },
});
```

### Scheduling Jobs

```ts
// Schedule for specific time
const reminderTime = new Date();
reminderTime.setHours(reminderTime.getHours() + 24);

await ctx.core.jobs.schedule("sendReminder", {
  userId: user.id,
  message: "Don't forget to complete your profile!",
}, reminderTime);

// Schedule relative to now
await ctx.core.jobs.schedule("expireSession", {
  sessionId: session.id,
}, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)); // 7 days
```

### Job Status Tracking

```ts
// Get specific job
const jobId = await ctx.core.jobs.enqueue("processFile", { fileId: 123 });
const job = await ctx.core.jobs.get(jobId);

console.log(job.status);     // "pending" | "running" | "completed" | "failed"
console.log(job.attempts);   // Number of attempts so far
console.log(job.result);     // Result if completed
console.log(job.error);      // Error message if failed

// Find all pending jobs of a type
const pendingEmails = await ctx.core.jobs.getByName("sendEmail", "pending");

// Cancel a job
const cancelled = await ctx.core.jobs.cancel(jobId);
```

---

## Event Integration

Jobs automatically emit events on completion and failure:

```ts
// Listen for job completions
ctx.core.events.on("job.completed", async (data) => {
  console.log(`Job ${data.jobId} (${data.name}) completed with result:`, data.result);
});

// Listen for specific job type
ctx.core.events.on("job.sendEmail.completed", async (data) => {
  await updateEmailStatus(data.result.messageId, "sent");
});

// Listen for failures
ctx.core.events.on("job.failed", async (data) => {
  ctx.core.logger.error("Job failed", {
    jobId: data.jobId,
    name: data.name,
    error: data.error,
    attempts: data.attempts,
  });

  // Alert on critical failures
  if (data.name === "processPayment") {
    await alertOps(`Payment job failed: ${data.error}`);
  }
});
```

---

## Real-World Examples

### Image Processing Pipeline

```ts
// Register handlers for each step
ctx.core.jobs.register("processImage", async (data) => {
  const { imageId, operations } = data;
  const image = await loadImage(imageId);

  for (const op of operations) {
    switch (op) {
      case "resize":
        await resizeImage(image, { width: 800 });
        break;
      case "optimize":
        await optimizeImage(image);
        break;
      case "thumbnail":
        await createThumbnail(image, { width: 200 });
        break;
    }
  }

  await saveImage(image);
  return { processed: true, operations };
});

// In route handler
router.route("upload").typed({
  handle: async (input, ctx) => {
    const image = await saveUploadedImage(input.file);

    const jobId = await ctx.core.jobs.enqueue("processImage", {
      imageId: image.id,
      operations: ["resize", "optimize", "thumbnail"],
    });

    return { imageId: image.id, processingJob: jobId };
  },
});
```

### Order Processing

```ts
// Complex order workflow
ctx.core.jobs.register("processOrder", async (data) => {
  const { orderId } = data;
  const order = await getOrder(orderId);

  // Step 1: Validate inventory
  for (const item of order.items) {
    const available = await checkInventory(item.productId, item.quantity);
    if (!available) {
      throw new Error(`Insufficient inventory for ${item.productId}`);
    }
  }

  // Step 2: Process payment
  const payment = await processPayment(order);
  if (!payment.success) {
    throw new Error(`Payment failed: ${payment.error}`);
  }

  // Step 3: Reserve inventory
  await reserveInventory(order.items);

  // Step 4: Queue fulfillment
  await ctx.core.jobs.enqueue("fulfillOrder", { orderId });

  return { paymentId: payment.id };
});

ctx.core.jobs.register("fulfillOrder", async (data) => {
  const { orderId } = data;

  // Generate shipping label
  const label = await createShippingLabel(orderId);

  // Notify warehouse
  await notifyWarehouse(orderId, label);

  // Send confirmation
  await ctx.core.jobs.enqueue("sendEmail", {
    to: order.customerEmail,
    template: "order-confirmation",
    orderId,
    trackingNumber: label.trackingNumber,
  });

  return { trackingNumber: label.trackingNumber };
});
```

### Report Generation

```ts
ctx.core.jobs.register("generateReport", async (data) => {
  const { reportType, dateRange, userId } = data;

  ctx.core.logger.info("Generating report", { reportType, dateRange });

  let report;
  switch (reportType) {
    case "sales":
      report = await generateSalesReport(dateRange);
      break;
    case "inventory":
      report = await generateInventoryReport(dateRange);
      break;
    case "users":
      report = await generateUsersReport(dateRange);
      break;
  }

  // Save report
  const reportId = await saveReport(report);

  // Notify user
  await ctx.core.jobs.enqueue("sendEmail", {
    to: await getUserEmail(userId),
    subject: `Your ${reportType} report is ready`,
    body: `Download your report: /reports/${reportId}`,
  });

  return { reportId };
});

// Queue from cron
ctx.core.cron.schedule("0 6 * * 1", async () => {
  // Weekly sales report every Monday at 6am
  await ctx.core.jobs.enqueue("generateReport", {
    reportType: "sales",
    dateRange: { start: lastWeek(), end: today() },
    userId: adminUserId,
  });
});
```

---

## Retry Behavior

Jobs automatically retry on failure:

```ts
ctx.core.jobs.register("flakyTask", async (data) => {
  // This might fail sometimes
  if (Math.random() < 0.5) {
    throw new Error("Random failure");
  }
  return { success: true };
});

// Enqueue with custom retry count
await ctx.core.jobs.enqueue("flakyTask", {}, { maxAttempts: 5 });

// Job will retry up to 5 times before being marked as "failed"
```

### Custom Retry Logic

```ts
ctx.core.jobs.register("apiCall", async (data) => {
  const { url, payload, attempt = 1 } = data;

  try {
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (!response.ok && response.status >= 500) {
      // Server error - let job system retry
      throw new Error(`Server error: ${response.status}`);
    }

    if (!response.ok) {
      // Client error - don't retry
      return { success: false, status: response.status };
    }

    return { success: true, data: await response.json() };
  } catch (error) {
    if (error.message.includes("fetch failed")) {
      // Network error - retry with backoff
      throw error;
    }
    // Other errors - don't retry
    return { success: false, error: error.message };
  }
});
```

---

## Custom Adapters

Implement `JobAdapter` for persistent storage:

```ts
interface JobAdapter {
  create(job: Omit<Job, "id">): Promise<Job>;
  get(jobId: string): Promise<Job | null>;
  update(jobId: string, updates: Partial<Job>): Promise<void>;
  delete(jobId: string): Promise<boolean>;
  getPending(limit?: number): Promise<Job[]>;
  getScheduledReady(now: Date): Promise<Job[]>;
  getByName(name: string, status?: JobStatus): Promise<Job[]>;
}
```

---

## Logs and Custom Events

Job handlers receive a scoped logger and helpers. Logs are persisted and emitted as events:

- `log.job` (all job logs)
- `log.job.<jobId>` (per job)

Custom events are emitted via `ctx.emit`:

- `job.event`
- `job.<jobName>.event`
- `job.<jobId>.event`

### SQLite Adapter Example

```ts
class SQLiteJobAdapter implements JobAdapter {
  constructor(private db: Kysely<any>) {}

  async create(job: Omit<Job, "id">): Promise<Job> {
    const result = await this.db
      .insertInto("jobs")
      .values({
        ...job,
        data: JSON.stringify(job.data),
        createdAt: job.createdAt.toISOString(),
        runAt: job.runAt?.toISOString(),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    return { ...job, id: result.id };
  }

  async getPending(limit: number = 100): Promise<Job[]> {
    return this.db
      .selectFrom("jobs")
      .selectAll()
      .where("status", "=", "pending")
      .limit(limit)
      .execute();
  }

  // ... implement other methods
}
```

---

## Best Practices

### 1. Keep Jobs Idempotent

```ts
// Good - can be safely retried
ctx.core.jobs.register("updateStatus", async (data) => {
  await db.updateTable("orders")
    .set({ status: "shipped" })
    .where("id", "=", data.orderId)
    .where("status", "=", "processing") // Only if still processing
    .execute();
});

// Bad - not idempotent
ctx.core.jobs.register("incrementCounter", async (data) => {
  await db.raw(`UPDATE counters SET value = value + 1 WHERE id = ?`, [data.id]);
  // Re-running increments again!
});
```

### 2. Include Enough Context

```ts
// Good - all data needed to process
await ctx.core.jobs.enqueue("processOrder", {
  orderId: "order-123",
  customerId: "cust-456",
  items: order.items,
  total: order.total,
});

// Bad - requires database lookup that might change
await ctx.core.jobs.enqueue("processOrder", {
  orderId: "order-123",
  // Handler has to look up order, which might have changed
});
```

### 3. Log Job Progress

```ts
ctx.core.jobs.register("longRunningTask", async (data) => {
  ctx.core.logger.info("Job started", { jobData: data });

  for (let i = 0; i < data.items.length; i++) {
    ctx.core.logger.debug("Processing item", { index: i, total: data.items.length });
    await processItem(data.items[i]);
  }

  ctx.core.logger.info("Job completed", { itemsProcessed: data.items.length });
  return { processed: data.items.length };
});
```

### 4. Handle Failures Gracefully

```ts
ctx.core.jobs.register("criticalTask", async (data) => {
  try {
    return await performTask(data);
  } catch (error) {
    // Log with context
    ctx.core.logger.error("Critical task failed", {
      error: error.message,
      data,
      stack: error.stack,
    });

    // Emit for monitoring
    await ctx.core.events.emit("job.criticalTask.error", {
      error: error.message,
      data,
    });

    // Re-throw to trigger retry
    throw error;
  }
});
```
