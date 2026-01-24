/**
 * Example Router - Demonstrates the feature module pattern
 *
 * Feature modules organize app-specific routes with:
 * - Thin router (just wiring)
 * - Handler classes with business logic
 * - Schemas in separate file
 *
 * Structure:
 *   routes/example/
 *   ├── index.ts              <- Router (this file)
 *   ├── example.schemas.ts    <- Zod schemas + types
 *   └── handlers/
 *       └── greet.handler.ts  <- Handler with business logic
 */

import { createRouter } from "@donkeylabs/server";
import { greetInputSchema, greetOutputSchema } from "./example.schemas";
import { GreetHandler } from "./handlers/greet.handler";

export const exampleRouter = createRouter("example")

  // Simple greeting route
  .route("greet").typed({
    input: greetInputSchema,
    output: greetOutputSchema,
    handle: GreetHandler,
  });
