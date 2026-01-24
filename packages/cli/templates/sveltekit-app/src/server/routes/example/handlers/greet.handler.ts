/**
 * Greet Handler
 *
 * Example handler demonstrating the feature module pattern.
 * Business logic lives directly in the handler - no separate model layer needed.
 */
export class GreetHandler {
  constructor(private ctx: any) {}

  handle(input: { name: string; formal?: boolean }) {
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
