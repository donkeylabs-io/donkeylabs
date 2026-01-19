/// <reference path="../registry.d.ts" />
import { z } from "zod";
import type { GlobalContext, PluginHandlerRegistry } from "./core";
import type { MiddlewareDefinition } from "./middleware";

export type ServerContext = GlobalContext;

/** Base interface for middleware builder - extended by generated types */
export interface IMiddlewareBuilder<TRouter> {}

/** Parsed form data passed to formData handler */
export interface ParsedFormData<F = any> {
  fields: F;
  files: File[];
}

/** Schema definitions for SSE events */
export type SSEEventSchemas = Record<string, z.ZodType<any>>;

export interface HandlerRegistry extends PluginHandlerRegistry {
    typed: {
        execute(req: Request, def: any, userHandle: Function, ctx: ServerContext): Promise<Response>;
        readonly __signature: (input: any, ctx: ServerContext) => Promise<any> | any;
    };
    raw: {
        execute(req: Request, def: any, userHandle: Function, ctx: ServerContext): Promise<Response>;
        readonly __signature: (req: Request, ctx: ServerContext) => Promise<Response> | Response;
    };
    stream: {
        execute(req: Request, def: any, userHandle: Function, ctx: ServerContext): Promise<Response>;
        readonly __signature: (input: any, ctx: ServerContext) => Promise<Response> | Response;
    };
    sse: {
        execute(req: Request, def: any, userHandle: Function, ctx: ServerContext): Promise<Response>;
        readonly __signature: (input: any, ctx: ServerContext) => string[] | Promise<string[]>;
    };
    formData: {
        execute(req: Request, def: any, userHandle: Function, ctx: ServerContext): Promise<Response>;
        readonly __signature: (data: ParsedFormData, ctx: ServerContext) => Promise<any> | any;
    };
    html: {
        execute(req: Request, def: any, userHandle: Function, ctx: ServerContext): Promise<Response>;
        readonly __signature: (input: any, ctx: ServerContext) => string | Response | Promise<string | Response>;
    };
}

export type RouteDefinition<
    T extends keyof HandlerRegistry = "typed",
    I = any,
    O = any,
    E extends SSEEventSchemas = SSEEventSchemas
> = {
  name: string;
  handler: T;
  input?: z.ZodType<I>;
  output?: z.ZodType<O>;
  /** SSE event schemas (for sse handler only) */
  events?: E;
  /** File constraints for formData handler */
  fileConstraints?: FileConstraints;
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

export interface StreamRouteConfig<I = any> {
  input?: z.ZodType<I>;
  handle: (input: I, ctx: ServerContext) => Promise<Response> | Response;
}

/** File upload constraints for formData handler */
export interface FileConstraints {
  /** Max file size in bytes */
  maxSize?: number;
  /** Accepted MIME types (e.g., "image/*", "application/pdf") */
  accept?: string[];
}

export interface SSERouteConfig<I = any, E extends SSEEventSchemas = SSEEventSchemas> {
  input?: z.ZodType<I>;
  /** Event schemas for type-safe client generation */
  events?: E;
  /** Return channel names to subscribe to */
  handle: (input: I, ctx: ServerContext) => string[] | Promise<string[]>;
}

export interface FormDataRouteConfig<F = any, O = any> {
  /** Schema for form fields (non-file data) */
  input?: z.ZodType<F>;
  /** Schema for output validation */
  output?: z.ZodType<O>;
  /** File upload constraints */
  files?: FileConstraints;
  handle: (data: ParsedFormData<F>, ctx: ServerContext) => Promise<O> | O;
}

export interface HTMLRouteConfig<I = any> {
  input?: z.ZodType<I>;
  handle: (input: I, ctx: ServerContext) => string | Response | Promise<string | Response>;
}

export interface IRouteBuilderBase<TRouter> {
  typed<I, O>(config: TypedRouteConfig<I, O>): TRouter;
  raw(config: RawRouteConfig): TRouter;
  /**
   * Stream handler - validated input, custom Response output.
   * Use for streaming, binary data, files, custom content-types, etc.
   *
   * @example
   * ```ts
   * api.route("files.download").stream({
   *   input: z.object({ fileId: z.string() }),
   *   handle: async (input, ctx) => {
   *     const file = await getFile(input.fileId);
   *     return new Response(file.stream, {
   *       headers: { "Content-Type": file.mimeType }
   *     });
   *   }
   * });
   * ```
   */
  stream<I>(config: StreamRouteConfig<I>): TRouter;
  /**
   * SSE handler - Server-Sent Events with validated input and typed events.
   * Returns channel names to subscribe the client to.
   *
   * @example
   * ```ts
   * api.route("notifications.subscribe").sse({
   *   input: z.object({ userId: z.string() }),
   *   events: {
   *     notification: z.object({ message: z.string(), id: z.string() }),
   *     announcement: z.object({ title: z.string(), urgent: z.boolean() }),
   *   },
   *   handle: (input, ctx) => [`user:${input.userId}`, "global"]
   * });
   * ```
   */
  sse<I, E extends SSEEventSchemas>(config: SSERouteConfig<I, E>): TRouter;
  /**
   * FormData handler - file uploads with validated fields.
   * Receives parsed form fields and files array.
   *
   * @example
   * ```ts
   * api.route("files.upload").formData({
   *   input: z.object({ folder: z.string() }),
   *   files: { maxSize: 10 * 1024 * 1024, accept: ["image/*"] },
   *   handle: async ({ fields, files }, ctx) => {
   *     const uploaded = await saveFiles(files, fields.folder);
   *     return { count: uploaded.length };
   *   }
   * });
   * ```
   */
  formData<F, O>(config: FormDataRouteConfig<F, O>): TRouter;
  /**
   * HTML handler - returns HTML responses.
   * Perfect for htmx, partial renders, or server components.
   *
   * @example
   * ```ts
   * api.route("components.userCard").html({
   *   input: z.object({ userId: z.string() }),
   *   handle: async (input, ctx) => {
   *     const user = await ctx.plugins.users.get(input.userId);
   *     return `<div class="card">${user.name}</div>`;
   *   }
   * });
   * ```
   */
  html<I>(config: HTMLRouteConfig<I>): TRouter;
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

  stream<I>(config: StreamRouteConfig<I>): TRouter {
    return this.router.addRoute(this.name, "stream", config, this._middleware);
  }

  sse<I, E extends SSEEventSchemas>(config: SSERouteConfig<I, E>): TRouter {
    return this.router.addRoute(this.name, "sse", config, this._middleware);
  }

  formData<F, O>(config: FormDataRouteConfig<F, O>): TRouter {
    // Map files constraints to fileConstraints for the handler
    const routeConfig = {
      ...config,
      fileConstraints: config.files,
    };
    return this.router.addRoute(this.name, "formData", routeConfig, this._middleware);
  }

  html<I>(config: HTMLRouteConfig<I>): TRouter {
    return this.router.addRoute(this.name, "html", config, this._middleware);
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
    eventsType?: Record<string, string>;
  }> {
    // Dynamic import to avoid circular deps
    const { zodSchemaToTs } = require("./generator/zod-to-ts");
    return this.getRoutes().map(route => {
      // Extract events schemas for SSE routes
      let eventsType: Record<string, string> | undefined;
      if (route.handler === "sse" && route.events) {
        eventsType = {};
        for (const [eventName, eventSchema] of Object.entries(route.events)) {
          eventsType[eventName] = zodSchemaToTs(eventSchema);
        }
      }
      return {
        name: route.name,
        handler: route.handler,
        inputType: route.input ? zodSchemaToTs(route.input) : undefined,
        outputType: route.output ? zodSchemaToTs(route.output) : undefined,
        eventsType,
      };
    });
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

