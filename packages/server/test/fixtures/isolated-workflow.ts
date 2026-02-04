import { createPlugin } from "../../src/core";
import { workflow } from "../../src/core/workflows";

export const initProbePlugin = createPlugin.define({
  name: "initProbe",
  service: () => {
    let initialized = false;
    return {
      markInitialized: () => {
        initialized = true;
      },
      isInitialized: () => initialized,
    };
  },
  init: (ctx, service) => {
    service.markInitialized();
    ctx.core.cron.schedule("*/5 * * * * *", async () => undefined, { name: "init-probe" });
    ctx.core.jobs.register("init-probe", async () => "ok");
  },
});

export const initProbeWorkflow = workflow("init-probe-workflow")
  .task("check", {
    handler: async (_input, ctx) => {
      return { initialized: ctx.plugins.initProbe.isInitialized() };
    },
  })
  .build();
