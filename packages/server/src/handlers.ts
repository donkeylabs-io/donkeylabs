import type { RouteDefinition, ServerContext } from "./router";
import { z } from "zod";

export interface HandlerRuntime<Fn extends Function = Function> {
  execute(
    req: Request,
    def: RouteDefinition<any, any>,
    userHandle: Fn,
    ctx: ServerContext
  ): Promise<Response>;

  readonly __signature: Fn;  // Required for type inference
}

/**
 * Factory function to create custom handlers without manual __signature.
 *
 * @example
 * type EchoFn = (body: any, ctx: ServerContext) => Promise<{ echo: any }>;
 *
 * export const EchoHandler = createHandler<EchoFn>(async (req, def, handle, ctx) => {
 *   const body = await req.json();
 *   const result = await handle(body, ctx);
 *   return Response.json(result);
 * });
 */
export function createHandler<Fn extends Function>(
  execute: (
    req: Request,
    def: RouteDefinition<any, any>,
    handle: Fn,
    ctx: ServerContext
  ) => Promise<Response>
): HandlerRuntime<Fn> {
  return {
    execute,
    __signature: undefined as unknown as Fn
  };
}

// ==========================================
// 1. Typed Handler (Default)
// ==========================================
export type TypedFn = (input: any, ctx: ServerContext) => Promise<any> | any;
export type TypedHandler = HandlerRuntime<TypedFn>;

export const TypedHandler: TypedHandler = {
  async execute(req, def, handle, ctx) {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      let body: any = {};
      try { body = await req.json(); } catch(e) { return Response.json({error: "Invalid JSON"}, {status:400}); }

      try {
        const input = def.input ? def.input.parse(body) : body;
        const result = await handle(input, ctx);
        const output = def.output ? def.output.parse(result) : result;
        return Response.json(output);
      } catch (e: any) {
         console.error(e);
         if (e instanceof z.ZodError) {
             return Response.json({ error: "Validation Failed", details: e.issues }, { status: 400 });
         }
         return Response.json({ error: e.message || "Internal Error" }, { status: 500 });
      }
  },
  __signature: undefined as unknown as TypedFn
}

// ==========================================
// 2. Raw Handler
// ==========================================
export type RawFn = (req: Request, ctx: ServerContext) => Promise<Response> | Response;
export type RawHandler = HandlerRuntime<RawFn>;

export const RawHandler: RawHandler = {
  async execute(req, def, handle, ctx) {
     return await handle(req, ctx);
  },
  __signature: undefined as unknown as RawFn
}

export const Handlers = {
    typed: TypedHandler,
    raw: RawHandler
};

