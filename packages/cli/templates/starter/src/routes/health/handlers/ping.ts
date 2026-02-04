import type { ServerContext } from "@donkeylabs/server";

type AppContext = ServerContext;

interface Handler<TInput = any, TOutput = any> {
  handle(input: TInput): TOutput | Promise<TOutput>;
}

type PingInput = {
  name: string;
  cool: number;
  echo?: string;
};

type PingOutput = {
  status: "ok";
  timestamp: string;
  echo?: string;
};

export class PingHandler implements Handler {
  ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  async handle(input: PingInput): Promise<PingOutput> {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      echo: input.echo,
    };
  }
}
