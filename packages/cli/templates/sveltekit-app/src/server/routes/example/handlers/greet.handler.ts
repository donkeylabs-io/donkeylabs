import type { Handler, Routes, AppContext } from "$server/api";

/**
 * Greet Handler
 *
 * Example handler demonstrating the feature module pattern.
 * Business logic lives directly in the handler - no separate model layer needed.
 */
export class GreetHandler implements Handler<Routes.Example.Greet> {
  constructor(private ctx: AppContext) {}

  handle(input: Routes.Example.Greet.Input): Routes.Example.Greet.Output {
    // Business logic directly in handler
    const greeting = input.formal
      ? `Good day, ${input.name}. How may I assist you?`
      : `Hey ${input.name}!`;

    return {
      message: greeting,
      timestamp: new Date().toISOString(),
    };
  }
}
