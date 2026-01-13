import type { ServerContext } from "./router";

// The next function - calls the next middleware or handler
export type NextFn = () => Promise<Response>;

// Middleware function signature (what plugins implement)
export type MiddlewareFn<TConfig = void> = (
  req: Request,
  ctx: ServerContext,
  next: NextFn,
  config: TConfig
) => Promise<Response>;

// Runtime middleware structure (mirrors HandlerRuntime pattern)
export interface MiddlewareRuntime<TConfig = void> {
  execute: MiddlewareFn<TConfig>;
  readonly __config: TConfig; // Phantom type for config inference
}

// Factory to create middleware (mirrors createHandler pattern)
export function createMiddleware<TConfig = void>(
  execute: MiddlewareFn<TConfig>
): MiddlewareRuntime<TConfig> {
  return {
    execute,
    __config: undefined as unknown as TConfig,
  };
}

// Stored middleware definition (attached to routes)
export interface MiddlewareDefinition {
  name: string;
  config: any;
}
