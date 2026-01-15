// After running `bun run gen:types`, use typed Handler:
import { Handler } from "@donkeylabs/server";
import type { Health } from "$server/routes";
import { AppContext } from "$server/context";

/**
 * Model class with handler logic.
 */
export class PingModel implements Handler<Health.Ping> {
  ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  handle(input: Health.Ping.Input): Health.Ping.Output {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      echo: input.echo,
    };
  }
}
