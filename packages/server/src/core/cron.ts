// Core Cron Service
// Schedule recurring tasks with cron expressions

export interface CronTask {
  id: string;
  name: string;
  expression: string;
  handler: () => void | Promise<void>;
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
}

export interface CronConfig {
  timezone?: string; // For future use
}

export interface Cron {
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

// Simple cron expression parser
// Supports: * (any), specific values, ranges (1-5), steps (*/5)
// Format: second minute hour dayOfMonth month dayOfWeek
// Also supports 5-field format (minute hour dayOfMonth month dayOfWeek)
class CronExpression {
  private fields: [number[], number[], number[], number[], number[], number[]];

  constructor(expression: string) {
    const parts = expression.trim().split(/\s+/);

    // Support both 5-field and 6-field cron
    if (parts.length === 5) {
      // minute hour dayOfMonth month dayOfWeek
      this.fields = [
        [0], // seconds (always 0)
        this.parseField(parts[0]!, 0, 59),  // minutes
        this.parseField(parts[1]!, 0, 23),  // hours
        this.parseField(parts[2]!, 1, 31),  // day of month
        this.parseField(parts[3]!, 1, 12),  // month
        this.parseField(parts[4]!, 0, 6),   // day of week
      ];
    } else if (parts.length === 6) {
      // second minute hour dayOfMonth month dayOfWeek
      this.fields = [
        this.parseField(parts[0]!, 0, 59),  // seconds
        this.parseField(parts[1]!, 0, 59),  // minutes
        this.parseField(parts[2]!, 0, 23),  // hours
        this.parseField(parts[3]!, 1, 31),  // day of month
        this.parseField(parts[4]!, 1, 12),  // month
        this.parseField(parts[5]!, 0, 6),   // day of week
      ];
    } else {
      throw new Error(`Invalid cron expression: ${expression}`);
    }
  }

  private parseField(field: string, min: number, max: number): number[] {
    const values: Set<number> = new Set();

    for (const part of field.split(",")) {
      if (part === "*") {
        for (let i = min; i <= max; i++) values.add(i);
      } else if (part.includes("/")) {
        const [range, stepStr] = part.split("/");
        const step = parseInt(stepStr!, 10);
        const start = range === "*" ? min : parseInt(range!, 10);
        for (let i = start; i <= max; i += step) values.add(i);
      } else if (part.includes("-")) {
        const [startStr, endStr] = part.split("-");
        const start = parseInt(startStr!, 10);
        const end = parseInt(endStr!, 10);
        for (let i = start; i <= end; i++) values.add(i);
      } else {
        values.add(parseInt(part, 10));
      }
    }

    return Array.from(values).sort((a, b) => a - b);
  }

  matches(date: Date): boolean {
    const second = date.getSeconds();
    const minute = date.getMinutes();
    const hour = date.getHours();
    const dayOfMonth = date.getDate();
    const month = date.getMonth() + 1;
    const dayOfWeek = date.getDay();

    return (
      this.fields[0].includes(second) &&
      this.fields[1].includes(minute) &&
      this.fields[2].includes(hour) &&
      this.fields[3].includes(dayOfMonth) &&
      this.fields[4].includes(month) &&
      this.fields[5].includes(dayOfWeek)
    );
  }

  getNextRun(from: Date = new Date()): Date {
    const next = new Date(from);
    next.setMilliseconds(0);
    next.setSeconds(next.getSeconds() + 1);

    // Search up to 1 year ahead
    const maxIterations = 366 * 24 * 60 * 60;
    for (let i = 0; i < maxIterations; i++) {
      if (this.matches(next)) {
        return next;
      }
      next.setSeconds(next.getSeconds() + 1);
    }

    throw new Error("Could not find next run time within 1 year");
  }
}

interface InternalCronTask extends CronTask {
  _cronExpr: CronExpression;
}

class CronImpl implements Cron {
  private tasks = new Map<string, InternalCronTask>();
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private taskCounter = 0;

  constructor(_config: CronConfig = {}) {
    // timezone handling for future use
  }

  schedule(
    expression: string,
    handler: () => void | Promise<void>,
    options: { name?: string; enabled?: boolean } = {}
  ): string {
    const id = `cron_${++this.taskCounter}_${Date.now()}`;
    const cronExpr = new CronExpression(expression);

    const task: InternalCronTask = {
      id,
      name: options.name ?? id,
      expression,
      handler,
      enabled: options.enabled ?? true,
      nextRun: cronExpr.getNextRun(),
      _cronExpr: cronExpr,
    };

    this.tasks.set(id, task);

    return id;
  }

  unschedule(taskId: string): boolean {
    return this.tasks.delete(taskId);
  }

  pause(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) task.enabled = false;
  }

  resume(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.enabled = true;
      const cronExpr = new CronExpression(task.expression);
      task.nextRun = cronExpr.getNextRun();
    }
  }

  list(): CronTask[] {
    return Array.from(this.tasks.values()).map(t => ({
      id: t.id,
      name: t.name,
      expression: t.expression,
      handler: t.handler,
      enabled: t.enabled,
      lastRun: t.lastRun,
      nextRun: t.nextRun,
    }));
  }

  get(taskId: string): CronTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    return {
      id: task.id,
      name: task.name,
      expression: task.expression,
      handler: task.handler,
      enabled: task.enabled,
      lastRun: task.lastRun,
      nextRun: task.nextRun,
    };
  }

  async trigger(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    task.lastRun = new Date();
    await task.handler();
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Check every second
    this.timer = setInterval(() => {
      const now = new Date();

      for (const task of this.tasks.values()) {
        if (!task.enabled) continue;

        const cronExpr = new CronExpression(task.expression);
        if (cronExpr.matches(now)) {
          task.lastRun = now;
          task.nextRun = cronExpr.getNextRun(now);

          // Execute handler (fire and forget, but log errors)
          Promise.resolve(task.handler()).catch(err => {
            console.error(`[Cron] Task "${task.name}" failed:`, err);
          });
        }
      }
    }, 1000);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export function createCron(config?: CronConfig): Cron {
  return new CronImpl(config);
}
