// Route definition with full type inference
import { createRoute } from "@donkeylabs/server";
import { Input, Output } from "./schema";
import { PingModel } from "./models/model";

export const pingRoute = createRoute.typed({
  input: Input,
  output: Output,
  handle: async (input, ctx) => {
    const model = new PingModel(ctx);
    return model.handle(input);
  },
});
