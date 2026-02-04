import { createRouter } from "@donkeylabs/server";
import { CounterGetHandler } from "./handlers/get";
import { CounterIncrementHandler } from "./handlers/increment";
import { CounterDecrementHandler } from "./handlers/decrement";

export const counterRouter = createRouter("counter")
  .route("counter.get").typed({ handle: CounterGetHandler })
  .route("counter.increment").typed({ handle: CounterIncrementHandler })
  .route("counter.decrement").typed({ handle: CounterDecrementHandler });

export default counterRouter;
