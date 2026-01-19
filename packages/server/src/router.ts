/// <reference path="../registry.d.ts" />
import { z } from "zod";
import type { GlobalContext, PluginHandlerRegistry } from "./core";
import type { MiddlewareDefinition } from "./middleware";

export type ServerContext = GlobalContext;

/** Base interface for middleware builder - extended by generated types */
export interface IMiddlewareBuilder<TRouter> {}

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

export interface HandlerClass<I = any, O = any> {
  new (ctx: ServerContext): { handle(input: I): Promise<O> | O };
}

function isHandlerClass(fn: any): fn is HandlerClass {
  return typeof fn === 'function' && fn.prototype && typeof fn.prototype.handle === 'function';
}

export interface TypedRouteConfig<I = any, O = any> {
  input?: z.ZodType<I>;
  output?: z.ZodType<O>;
  handle: ((input: I, ctx: ServerContext) => Promise<O> | O) | HandlerClass<I, O>;
}

export interface RouteMetadata {
  name: string;
  handler: string;
  inputSchema?: z.ZodType<any>;
  outputSchema?: z.ZodType<any>;
}

export interface RawRouteConfig {
  handle: (req: Request, ctx: ServerContext) => Promise<Response> | Response;
}

export interface IRouteBuilderBase<TRouter> {
  typed<I, O>(config: TypedRouteConfig<I, O>): TRouter;
  raw(config: RawRouteConfig): TRouter;
}

export interface IRouteBuilder<TRouter> extends IRouteBuilderBase<TRouter> {}


export class RouteBuilder<TRouter extends Router> implements IRouteBuilderBase<TRouter> {
  constructor(
    private router: TRouter,
    private name: string,
    private _middleware: MiddlewareDefinition[] = []
  ) {}

  typed<I, O>(config: TypedRouteConfig<I, O>): TRouter {
    if (isHandlerClass(config.handle)) {
        const HandlerClass = config.handle;
        config.handle = (input, ctx) => new HandlerClass(ctx).handle(input);
    }
    return this.router.addRoute(this.name, "typed", config, this._middleware);
  }

  raw(config: RawRouteConfig): TRouter {
    return this.router.addRoute(this.name, "raw", config, this._middleware);
  }

  addHandler(handler: string, config: any): TRouter {
    return this.router.addRoute(this.name, handler, config, this._middleware);
  }
}

export interface IRouter {
  route(name: string): IRouteBuilder<this>;
  router(prefixOrRouter: string | IRouter): IRouter;
  middleware: IMiddlewareBuilder<this>;
  getRoutes(): RouteDefinition<any, any, any>[];
  getMetadata(): RouteMetadata[];
  getPrefix(): string;
}

export class Router implements IRouter {
  private routes: Map<string, RouteDefinition<any, any, any>> = new Map();
  private childRouters: IRouter[] = [];
  private prefix: string;
  private _middlewareStack: MiddlewareDefinition[] = [];

  constructor(prefix: string = "") {
    this.prefix = prefix;
  }

  route(name: string): IRouteBuilder<this> {
    return new RouteBuilder(this, name, this._middlewareStack) as unknown as IRouteBuilder<this>;
  }

  /** Create a nested router or register a child router */
  router(prefixOrRouter: string | IRouter): IRouter {
    if (typeof prefixOrRouter === "string") {
      const fullPrefix = this.prefix ? `${this.prefix}.${prefixOrRouter}` : prefixOrRouter;
      const childRouter = new Router(fullPrefix);
      childRouter._middlewareStack = [...this._middlewareStack];
      // Track child router so its routes are included in getRoutes()
      this.childRouters.push(childRouter);
      return childRouter;
    }
    // Merge child router's routes into this router
    for (const route of prefixOrRouter.getRoutes()) {
      const fullName = this.prefix ? `${this.prefix}.${route.name}` : route.name;
      this.routes.set(fullName, { ...route, name: fullName, middleware: [...this._middlewareStack, ...(route.middleware || [])] });
    }
    return this;
  }

  /** Middleware builder - chain middleware before defining routes */
  get middleware(): IMiddlewareBuilder<this> {
    return createMiddlewareBuilderProxy(this);
  }

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
    const allRoutes = Array.from(this.routes.values());
    // Include routes from all child routers
    for (const child of this.childRouters) {
      allRoutes.push(...child.getRoutes());
    }
    return allRoutes;
  }

  getMetadata(): RouteMetadata[] {
    return this.getRoutes().map(route => ({
      name: route.name,
      handler: route.handler,
      inputSchema: route.input,
      outputSchema: route.output,
    }));
  }

  /** Get route metadata with TypeScript type strings for code generation */
  getTypedMetadata(): Array<{
    name: string;
    handler: string;
    inputType?: string;
    outputType?: string;
  }> {
    // Dynamic import to avoid circular deps
    const { zodSchemaToTs } = require("./generator/zod-to-ts");
    return this.getRoutes().map(route => ({
      name: route.name,
      handler: route.handler,
      inputType: route.input ? zodSchemaToTs(route.input) : undefined,
      outputType: route.output ? zodSchemaToTs(route.output) : undefined,
    }));
  }

  getPrefix(): string {
    return this.prefix;
  }
}

/** Creates a Proxy that intercepts middleware method calls and adds them to the router's middleware stack */
function createMiddlewareBuilderProxy<TRouter extends Router>(router: TRouter): IMiddlewareBuilder<TRouter> {
  return new Proxy({} as IMiddlewareBuilder<TRouter>, {
    get(_target, prop) {
      if (typeof prop === "string") {
        return (config?: any) => {
          router["_middlewareStack"].push({ name: prop, config });
          return router;
        };
      }
      return undefined;
    },
  });
}

export const createRouter = (prefix?: string): IRouter => new Router(prefix);

/**
 * Define a route with type inference for input/output schemas.
 *
 * @example
 * export const myRoute = defineRoute({
 *   input: z.object({ name: z.string() }),
 *   output: z.object({ greeting: z.string() }),
 *   handle: async ({ name }, ctx) => {
 *     return { greeting: `Hello ${name}` };
 *   }
 * });
 */
export function defineRoute<I, O>(config: TypedRouteConfig<I, O>): TypedRouteConfig<I, O> {
  return config;
}

