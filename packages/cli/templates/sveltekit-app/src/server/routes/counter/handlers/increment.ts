import type { ServerContext } from "@donkeylabs/server";

type AppContext = ServerContext;

interface Handler<TInput = any, TOutput = any> {
  handle(input: TInput): TOutput | Promise<TOutput>;
}

export class CounterIncrementHandler implements Handler {
  ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  async handle(): Promise<{ count: number }> {
    return { count: 1 };
  }
}
