/**
 * Admin Dashboard Routes
 * All admin API endpoints
 */

import { z } from "zod";
import type { ServerContext } from "../router";
import { createRouter, defineRoute } from "../router";
import {
  renderDashboardLayout,
  renderOverview,
  renderJobsList,
  renderProcessesList,
  renderWorkflowsList,
  renderAuditLogs,
  renderSSEClients,
  renderWebSocketClients,
  renderEvents,
  renderCache,
  renderPlugins,
  renderRoutes,
  type DashboardData,
} from "./dashboard";
import type { AdminConfig } from "./index";

export interface AdminRouteContext {
  prefix: string;
  authorize?: AdminConfig["authorize"];
}

/**
 * Create admin router with all dashboard routes
 */
export function createAdminRouter(config: AdminRouteContext) {
  const { prefix, authorize } = config;
  const router = createRouter(prefix);

  // Helper to check authorization
  const checkAuth = (ctx: ServerContext): boolean => {
    if (authorize) {
      return authorize(ctx);
    }
    return true;
  };

  // Helper to get stats
  const getStats = async (ctx: ServerContext): Promise<DashboardData["stats"]> => {
    const { jobs, processes, workflows, sse, websocket } = ctx.core;

    // Get job counts
    const allJobs = await jobs.getAll({ limit: 1000 });
    const jobCounts = {
      pending: allJobs.filter((j) => j.status === "pending").length,
      running: allJobs.filter((j) => j.status === "running").length,
      completed: allJobs.filter((j) => j.status === "completed").length,
      failed: allJobs.filter((j) => j.status === "failed").length,
    };

    // Get process counts
    const runningProcesses = await processes.getRunning();
    const processCounts = {
      running: runningProcesses.length,
      total: runningProcesses.length,
    };

    // Get workflow counts
    const allWorkflows = await workflows.getAllInstances({ limit: 1000 });
    const workflowCounts = {
      running: allWorkflows.filter((w) => w.status === "running").length,
      total: allWorkflows.length,
    };

    return {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      jobs: jobCounts,
      processes: processCounts,
      workflows: workflowCounts,
      sse: { clients: sse.getClients().length },
      websocket: { clients: websocket.getClients().length },
    };
  };

  // Main dashboard route (HTML)
  router.route("dashboard").html({
    input: z.object({
      view: z.string().default("overview"),
      // partial can be "1" or 1 (string or number from query params)
      partial: z.union([z.string(), z.number()]).optional(),
      status: z.string().optional(),
    }),
    handle: async (input, ctx) => {
      if (!checkAuth(ctx)) {
        return '<html><body><h1>Unauthorized</h1></body></html>';
      }

      const { view, partial, status } = input;
      let content: string;

      switch (view) {
        case "overview": {
          const stats = await getStats(ctx);
          content = renderOverview(prefix, stats);
          break;
        }
        case "jobs": {
          const jobs = await ctx.core.jobs.getAll({
            status: status as any,
            limit: 100,
          });
          content = renderJobsList(prefix, jobs);
          break;
        }
        case "processes": {
          const processes = await ctx.core.processes.getRunning();
          content = renderProcessesList(prefix, processes);
          break;
        }
        case "workflows": {
          const workflows = await ctx.core.workflows.getAllInstances({
            status: status as any,
            limit: 100,
          });
          content = renderWorkflowsList(prefix, workflows);
          break;
        }
        case "audit": {
          const logs = await ctx.core.audit.query({
            limit: 100,
          });
          content = renderAuditLogs(prefix, logs);
          break;
        }
        case "sse": {
          const clients = ctx.core.sse.getClients();
          content = renderSSEClients(prefix, clients);
          break;
        }
        case "websocket": {
          const clients = ctx.core.websocket.getClients();
          content = renderWebSocketClients(prefix, clients);
          break;
        }
        case "events": {
          // Get recent events from event history if available
          const events: any[] = [];
          content = renderEvents(prefix, events);
          break;
        }
        case "cache": {
          const keys = await ctx.core.cache.keys?.() ?? [];
          content = renderCache(prefix, keys);
          break;
        }
        case "plugins": {
          const plugins = Object.keys(ctx.plugins).map((name) => ({
            name,
            dependencies: [],
            hasSchema: false,
          }));
          content = renderPlugins(prefix, plugins);
          break;
        }
        case "routes": {
          // Get routes from server context
          const routes: any[] = [];
          content = renderRoutes(prefix, routes);
          break;
        }
        default:
          content = "<div>Unknown view</div>";
      }

      // Return partial content for htmx requests
      if (partial === "1" || partial === 1) {
        return content;
      }

      return renderDashboardLayout(prefix, content, view);
    },
  });

  // Stats API route
  router.route("stats").typed(
    defineRoute({
      input: z.object({}),
      output: z.object({
        uptime: z.number(),
        memory: z.object({
          heapUsed: z.number(),
          heapTotal: z.number(),
        }),
        jobs: z.object({
          pending: z.number(),
          running: z.number(),
          completed: z.number(),
          failed: z.number(),
        }),
        processes: z.object({
          running: z.number(),
          total: z.number(),
        }),
        workflows: z.object({
          running: z.number(),
          total: z.number(),
        }),
        sse: z.object({ clients: z.number() }),
        websocket: z.object({ clients: z.number() }),
      }),
      handle: async (_input, ctx) => {
        if (!checkAuth(ctx)) {
          throw ctx.errors.Forbidden("Unauthorized");
        }
        return getStats(ctx);
      },
    })
  );

  // Jobs list route
  router.route("jobs.list").typed(
    defineRoute({
      input: z.object({
        status: z.enum(["pending", "running", "completed", "failed", "scheduled"]).optional(),
        name: z.string().optional(),
        limit: z.number().default(100),
        offset: z.number().default(0),
      }),
      output: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          status: z.string(),
          attempts: z.number(),
          maxAttempts: z.number(),
          createdAt: z.string(),
          startedAt: z.string().nullable(),
          completedAt: z.string().nullable(),
          error: z.string().nullable(),
        })
      ),
      handle: async (input, ctx) => {
        if (!checkAuth(ctx)) {
          throw ctx.errors.Forbidden("Unauthorized");
        }
        const jobs = await ctx.core.jobs.getAll(input);
        return jobs.map((job) => ({
          id: job.id,
          name: job.name,
          status: job.status,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          createdAt: job.createdAt.toISOString(),
          startedAt: job.startedAt?.toISOString() ?? null,
          completedAt: job.completedAt?.toISOString() ?? null,
          error: job.error ?? null,
        }));
      },
    })
  );

  // Jobs cancel route
  router.route("jobs.cancel").typed(
    defineRoute({
      input: z.object({ jobId: z.string() }),
      output: z.object({ success: z.boolean() }),
      handle: async (input, ctx) => {
        if (!checkAuth(ctx)) {
          throw ctx.errors.Forbidden("Unauthorized");
        }
        const success = await ctx.core.jobs.cancel(input.jobId);
        return { success };
      },
    })
  );

  // Processes list route
  router.route("processes.list").typed(
    defineRoute({
      input: z.object({}),
      output: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          status: z.string(),
          pid: z.number().nullable(),
          restartCount: z.number(),
          startedAt: z.string().nullable(),
        })
      ),
      handle: async (_input, ctx) => {
        if (!checkAuth(ctx)) {
          throw ctx.errors.Forbidden("Unauthorized");
        }
        const processes = await ctx.core.processes.getRunning();
        return processes.map((proc) => ({
          id: proc.id,
          name: proc.name,
          status: proc.status,
          pid: proc.pid ?? null,
          restartCount: proc.restartCount ?? 0,
          startedAt: proc.startedAt?.toISOString() ?? null,
        }));
      },
    })
  );

  // Processes stop route
  router.route("processes.stop").typed(
    defineRoute({
      input: z.object({ name: z.string() }),
      output: z.object({ success: z.boolean() }),
      handle: async (input, ctx) => {
        if (!checkAuth(ctx)) {
          throw ctx.errors.Forbidden("Unauthorized");
        }
        // Note: stop expects a process ID, not a name
        // Get processes by name first
        const processes = await ctx.core.processes.getByName(input.name);
        for (const proc of processes) {
          await ctx.core.processes.stop(proc.id);
        }
        return { success: true };
      },
    })
  );

  // Processes restart route
  router.route("processes.restart").typed(
    defineRoute({
      input: z.object({ name: z.string() }),
      output: z.object({ success: z.boolean() }),
      handle: async (input, ctx) => {
        if (!checkAuth(ctx)) {
          throw ctx.errors.Forbidden("Unauthorized");
        }
        const processes = await ctx.core.processes.getByName(input.name);
        for (const proc of processes) {
          await ctx.core.processes.restart(proc.id);
        }
        return { success: true };
      },
    })
  );

  // Workflows list route
  router.route("workflows.list").typed(
    defineRoute({
      input: z.object({
        status: z.enum(["pending", "running", "completed", "failed", "cancelled", "timed_out"]).optional(),
        workflowName: z.string().optional(),
        limit: z.number().default(100),
        offset: z.number().default(0),
      }),
      output: z.array(
        z.object({
          id: z.string(),
          workflowName: z.string(),
          status: z.string(),
          currentStep: z.string().nullable(),
          createdAt: z.string(),
          startedAt: z.string().nullable(),
          completedAt: z.string().nullable(),
          error: z.string().nullable(),
        })
      ),
      handle: async (input, ctx) => {
        if (!checkAuth(ctx)) {
          throw ctx.errors.Forbidden("Unauthorized");
        }
        const workflows = await ctx.core.workflows.getAllInstances(input);
        return workflows.map((wf) => ({
          id: wf.id,
          workflowName: wf.workflowName,
          status: wf.status,
          currentStep: wf.currentStep ?? null,
          createdAt: wf.createdAt.toISOString(),
          startedAt: wf.startedAt?.toISOString() ?? null,
          completedAt: wf.completedAt?.toISOString() ?? null,
          error: wf.error ?? null,
        }));
      },
    })
  );

  // Workflows cancel route
  router.route("workflows.cancel").typed(
    defineRoute({
      input: z.object({ instanceId: z.string() }),
      output: z.object({ success: z.boolean() }),
      handle: async (input, ctx) => {
        if (!checkAuth(ctx)) {
          throw ctx.errors.Forbidden("Unauthorized");
        }
        const success = await ctx.core.workflows.cancel(input.instanceId);
        return { success };
      },
    })
  );

  // Audit list route
  router.route("audit.list").typed(
    defineRoute({
      input: z.object({
        action: z.string().optional(),
        actor: z.string().optional(),
        resource: z.string().optional(),
        limit: z.number().default(100),
        offset: z.number().default(0),
      }),
      output: z.array(
        z.object({
          id: z.string(),
          action: z.string(),
          actor: z.string(),
          resource: z.string(),
          resourceId: z.string().nullable(),
          timestamp: z.string(),
        })
      ),
      handle: async (input, ctx) => {
        if (!checkAuth(ctx)) {
          throw ctx.errors.Forbidden("Unauthorized");
        }
        const logs = await ctx.core.audit.query({
          action: input.action,
          actor: input.actor,
          resource: input.resource,
          limit: input.limit,
          offset: input.offset,
        });
        return logs.map((log) => ({
          id: log.id,
          action: log.action,
          actor: log.actor,
          resource: log.resource,
          resourceId: log.resourceId ?? null,
          timestamp: log.timestamp.toISOString(),
        }));
      },
    })
  );

  // SSE clients route
  router.route("sse.clients").typed(
    defineRoute({
      input: z.object({}),
      output: z.array(
        z.object({
          id: z.string(),
          channels: z.array(z.string()),
          connectedAt: z.string(),
        })
      ),
      handle: async (_input, ctx) => {
        if (!checkAuth(ctx)) {
          throw ctx.errors.Forbidden("Unauthorized");
        }
        const clients = ctx.core.sse.getClients();
        return clients.map((client) => ({
          id: client.id,
          channels: Array.from(client.channels || []),
          connectedAt: client.createdAt?.toISOString() ?? new Date().toISOString(),
        }));
      },
    })
  );

  // WebSocket clients route
  router.route("websocket.clients").typed(
    defineRoute({
      input: z.object({}),
      output: z.array(
        z.object({
          id: z.string(),
          connectedAt: z.string(),
        })
      ),
      handle: async (_input, ctx) => {
        if (!checkAuth(ctx)) {
          throw ctx.errors.Forbidden("Unauthorized");
        }
        const clients = ctx.core.websocket.getClients();
        return clients.map((client) => ({
          id: client.id,
          connectedAt: client.connectedAt?.toISOString() ?? new Date().toISOString(),
        }));
      },
    })
  );

  // Cache keys route
  router.route("cache.keys").typed(
    defineRoute({
      input: z.object({}),
      output: z.array(z.string()),
      handle: async (_input, ctx) => {
        if (!checkAuth(ctx)) {
          throw ctx.errors.Forbidden("Unauthorized");
        }
        return (await ctx.core.cache.keys?.()) ?? [];
      },
    })
  );

  // Plugins route
  router.route("plugins").typed(
    defineRoute({
      input: z.object({}),
      output: z.array(
        z.object({
          name: z.string(),
          dependencies: z.array(z.string()),
        })
      ),
      handle: async (_input, ctx) => {
        if (!checkAuth(ctx)) {
          throw ctx.errors.Forbidden("Unauthorized");
        }
        return Object.keys(ctx.plugins).map((name) => ({
          name,
          dependencies: [],
        }));
      },
    })
  );

  // Routes list route
  router.route("routes").typed(
    defineRoute({
      input: z.object({}),
      output: z.array(
        z.object({
          name: z.string(),
          handler: z.string(),
          hasInput: z.boolean(),
          hasOutput: z.boolean(),
        })
      ),
      handle: async (_input, ctx) => {
        if (!checkAuth(ctx)) {
          throw ctx.errors.Forbidden("Unauthorized");
        }
        // This would need access to the server's route map
        // For now, return empty array - will be populated when integrated
        return [];
      },
    })
  );

  // Live stats SSE route
  // Subscribes to the admin:stats channel for real-time updates
  router.route("live").sse({
    input: z.object({}),
    events: {
      stats: z.object({
        uptime: z.number(),
        memory: z.object({
          heapUsed: z.number(),
          heapTotal: z.number(),
        }),
      }),
    },
    handle: (_input, ctx) => {
      if (!checkAuth(ctx)) {
        return [];
      }
      // Return channel to subscribe to
      return [`admin:stats`];
    },
  });

  return router;
}
