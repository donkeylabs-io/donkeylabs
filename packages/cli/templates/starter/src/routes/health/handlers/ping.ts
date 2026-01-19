
// Types from generated api.ts (run server once to generate)
import type { Handler, Routes, AppContext } from "$server/api";

/**
 * Ping Handler
 */
export class PingHandler implements Handler<Routes.Api.Health.Ping> {
  ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  handle(input: Routes.Api.Health.Ping.Input): Routes.Api.Health.Ping.Output {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      echo: input.echo,
    };
  }
}
