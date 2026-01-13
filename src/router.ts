/// <reference path="../registry.d.ts" />
import { z } from "zod";
import type { GlobalContext } from "../context";
import type { PluginHandlerRegistry } from "./core";
import type { MiddlewareDefinition } from "./middleware";

// 1. Server Context
export type ServerContext = GlobalContext;

// 2. Handler Registry (for runtime resolution)
export interface HandlerRegistry extends PluginHandlerRegistry {
    typed: {
        execute(req: Request, def: any, userHandle: Function, ctx: ServerContext): Promise<Response>;
        readonly __signature: (input: any, ctx: ServerContext) => Promise<any> | any;
    };
    raw: {
        execute(req: Request, def: any, userHandle: Function, ctx: ServerContext): Promise<Response>;
        readonly __signature: (req: Request, ctx: ServerContext) => Promise<Response> | Response;
    };
}

// 3. Route Definition (stored in router, used by server)
export type RouteDefinition<
    T extends keyof HandlerRegistry = "typed",
    I = any,
    O = any
> = {
  name: string;
  handler: T;
  input?: z.ZodType<I>;
  output?: z.ZodType<O>;
  middleware?: MiddlewareDefinition[];
  handle: T extends "typed"
    ? (input: I, ctx: ServerContext) => Promise<O> | O
    : T extends "raw"
    ? (req: Request, ctx: ServerContext) => Promise<Response> | Response
    : HandlerRegistry[T]["__signature"];
};

// 4. Route Config Types (for handler method parameters)
export interface TypedRouteConfig<I = any, O = any> {
  input?: z.ZodType<I>;
  output?: z.ZodType<O>;
  handle: (input: I, ctx: ServerContext) => Promise<O> | O;
}

// Route metadata for client generation
export interface RouteMetadata {
  name: string;
  handler: string;
  inputSchema?: z.ZodType<any>;
  outputSchema?: z.ZodType<any>;
}

export interface RawRouteConfig {
  handle: (req: Request, ctx: ServerContext) => Promise<Response> | Response;
}

// 5. Base Route Builder Interface (what the class implements)
export interface IRouteBuilderBase<TRouter> {
  typed<I, O>(config: TypedRouteConfig<I, O>): TRouter;
  raw(config: RawRouteConfig): TRouter;
}

// 6. Extended Route Builder Interface (augmented by registry.d.ts for custom handlers)
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface IRouteBuilder<TRouter> extends IRouteBuilderBase<TRouter> {}

// 6b. Base Middleware Builder Interface (augmented by registry.d.ts for custom middleware)
export interface IMiddlewareBuilderBase<TRouter> {
  route(name: string): IRouteBuilder<TRouter>;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface IMiddlewareBuilder<TRouter> extends IMiddlewareBuilderBase<TRouter> {}

// 6c. Middleware Builder Class (returned by router.middleware)
export class MiddlewareBuilder<TRouter extends Router> implements IMiddlewareBuilderBase<TRouter> {
  private _middleware: MiddlewareDefinition[] = [];

  constructor(private router: TRouter) {}

  // Creates a RouteBuilder with accumulated middleware
  route(name: string): IRouteBuilder<TRouter> {
    return new RouteBuilder(this.router, name, this._middleware) as unknown as IRouteBuilder<TRouter>;
  }

  // Internal: used by generated middleware methods
  addMiddleware(name: string, config: any): this {
    this._middleware.push({ name, config });
    return this;
  }
}

// 7. Route Builder Class (returned by router.route())
export class RouteBuilder<TRouter extends Router> implements IRouteBuilderBase<TRouter> {
  constructor(
    private router: TRouter,
    private name: string,
    private _middleware: MiddlewareDefinition[] = []
  ) {}

  typed<I, O>(config: TypedRouteConfig<I, O>): TRouter {
    return this.router.addRoute(this.name, "typed", config, this._middleware);
  }

  raw(config: RawRouteConfig): TRouter {
    return this.router.addRoute(this.name, "raw", config, this._middleware);
  }

  // Internal: used by generated handler methods
  addHandler(handler: string, config: any): TRouter {
    return this.router.addRoute(this.name, handler, config, this._middleware);
  }
}

// 8. Router Interface
export interface IRouter {
  route(name: string): IRouteBuilder<this>;
  middleware: IMiddlewareBuilder<this>;
  getRoutes(): RouteDefinition<any, any, any>[];
  getMetadata(): RouteMetadata[];
  getPrefix(): string;
}

// 9. Router Class
export class Router implements IRouter {
  private routes: Map<string, RouteDefinition<any, any, any>> = new Map();
  private prefix: string;

  constructor(prefix: string = "") {
    this.prefix = prefix;
  }

  // Returns a route builder for fluent handler selection
  route(name: string): IRouteBuilder<this> {
    return new RouteBuilder(this, name) as unknown as IRouteBuilder<this>;
  }

  // Returns a middleware builder for chaining middleware before routes
  get middleware(): IMiddlewareBuilder<this> {
    return new MiddlewareBuilder(this) as unknown as IMiddlewareBuilder<this>;
  }

  // Internal: add route to map (called by RouteBuilder)
  addRoute(name: string, handler: string, config: any, middleware: MiddlewareDefinition[] = []): this {
    const fullName = this.prefix ? `${this.prefix}.${name}` : name;
    this.routes.set(fullName, {
      name: fullName,
      handler,
      middleware: middleware.length > 0 ? middleware : undefined,
      ...config
    });
    return this;
  }

  getRoutes(): RouteDefinition<any, any, any>[] {
    return Array.from(this.routes.values());
  }

  getMetadata(): RouteMetadata[] {
    return this.getRoutes().map(route => ({
      name: route.name,
      handler: route.handler,
      inputSchema: route.input,
      outputSchema: route.output,
    }));
  }

  getPrefix(): string {
    return this.prefix;
  }
}

export const createRouter = (prefix?: string): IRouter => new Router(prefix);
