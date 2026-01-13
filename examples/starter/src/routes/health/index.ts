import { createRouter } from "@donkeylabs/server";
import { pingRoute } from "./ping";

export const healthRouter = createRouter("health")
  .route("ping").typed(pingRoute);
