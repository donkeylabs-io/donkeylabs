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

// ==========================================
// 3. Stream Handler (Validated input, custom Response output)
// ==========================================
/**
 * Stream handler function signature.
 * Like typed, but returns a Response instead of JSON-serializable data.
 * Use this for streaming, binary data, custom content-types, etc.
 *
 * Accepts both GET (query params) and POST (JSON body) for flexibility:
 * - GET /files.download?fileId=123 (for browser links, video src, etc.)
 * - POST /files.download {"fileId": "123"} (for programmatic requests)
 */
export type StreamFn<I = any> = (input: I, ctx: ServerContext) => Promise<Response> | Response;
export type StreamHandler = HandlerRuntime<StreamFn>;

export const StreamHandler: StreamHandler = {
  async execute(req, def, handle, ctx) {
    // Stream routes accept GET (for browser, <video src>, etc.) and POST
    if (req.method !== "GET" && req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      // Parse input from query params (GET) or body (POST)
      let body: any = {};
      if (req.method === "POST") {
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
      } else {
        // Parse query params for GET requests
        const url = new URL(req.url);
        for (const [key, value] of url.searchParams) {
          // Try to parse JSON values, otherwise use string
          try {
            body[key] = JSON.parse(value);
          } catch {
            body[key] = value;
          }
        }
      }

      // Validate input with Zod (like typed)
      const input = def.input ? def.input.parse(body) : body;
      // But return Response directly (like raw) - no output validation
      return await handle(input, ctx);
    } catch (e: any) {
      console.error(e);
      if (e instanceof z.ZodError) {
        return Response.json({ error: "Validation Failed", details: e.issues }, { status: 400 });
      }
      return Response.json({ error: e.message || "Internal Error" }, { status: e.status || 500 });
    }
  },
  __signature: undefined as unknown as StreamFn
}

// ==========================================
// 4. SSE Handler (Server-Sent Events)
// ==========================================
/**
 * SSE handler function signature.
 * Returns channels to subscribe to based on validated input.
 * The handler sets up the SSE connection and subscribes to channels.
 */
export type SSEFn<I = any> = (input: I, ctx: ServerContext) => string[] | Promise<string[]>;
export type SSEHandler = HandlerRuntime<SSEFn>;

export const SSEHandler: SSEHandler = {
  async execute(req, def, handle, ctx) {
    // SSE typically uses GET, but we also support POST for input
    if (req.method !== "GET" && req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      // Parse input from query params (GET) or body (POST)
      let body: any = {};
      if (req.method === "POST") {
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
      } else {
        // Parse query params for GET requests
        const url = new URL(req.url);
        for (const [key, value] of url.searchParams) {
          // Try to parse JSON values, otherwise use string
          try {
            body[key] = JSON.parse(value);
          } catch {
            body[key] = value;
          }
        }
      }

      // Validate input
      const input = def.input ? def.input.parse(body) : body;

      // Get channels from handler
      const channels = await handle(input, ctx);

      // Create SSE client and response
      const { client, response } = ctx.core.sse.addClient({
        lastEventId: req.headers.get("Last-Event-ID") || undefined,
      });

      // Subscribe to channels
      for (const channel of channels) {
        ctx.core.sse.subscribe(client.id, channel);
      }

      // Clean up client when connection is aborted
      req.signal.addEventListener("abort", () => {
        ctx.core.sse.removeClient(client.id);
      });

      return response;
    } catch (e: any) {
      console.error(e);
      if (e instanceof z.ZodError) {
        return Response.json({ error: "Validation Failed", details: e.issues }, { status: 400 });
      }
      return Response.json({ error: e.message || "Internal Error" }, { status: e.status || 500 });
    }
  },
  __signature: undefined as unknown as SSEFn
};

// ==========================================
// 5. FormData Handler (File Uploads / Multipart)
// ==========================================
/**
 * Parsed form data passed to handler.
 */
export interface ParsedFormData<F = any> {
  fields: F;
  files: File[];
}

/**
 * FormData handler function signature.
 * Receives validated fields and files array.
 */
export type FormDataFn<F = any, O = any> = (
  data: ParsedFormData<F>,
  ctx: ServerContext
) => Promise<O> | O;
export type FormDataHandler = HandlerRuntime<FormDataFn>;

export const FormDataHandler: FormDataHandler = {
  async execute(req, def, handle, ctx) {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const contentType = req.headers.get("Content-Type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return Response.json(
        { error: "Content-Type must be multipart/form-data" },
        { status: 400 }
      );
    }

    try {
      const formData = await req.formData();

      // Separate fields and files
      const fields: Record<string, any> = {};
      const files: File[] = [];

      for (const [key, value] of formData.entries()) {
        // Check if value is a File (not a string)
        if (typeof value !== "string") {
          const file = value as File;
          // Check file constraints if defined
          if (def.fileConstraints) {
            const { maxSize, accept } = def.fileConstraints;

            if (maxSize && file.size > maxSize) {
              return Response.json(
                { error: `File "${file.name}" exceeds max size of ${maxSize} bytes` },
                { status: 400 }
              );
            }

            if (accept && accept.length > 0) {
              const isAccepted = accept.some((pattern: string) => {
                if (pattern.endsWith("/*")) {
                  const prefix = pattern.slice(0, -1);
                  return file.type.startsWith(prefix);
                }
                return file.type === pattern;
              });

              if (!isAccepted) {
                return Response.json(
                  { error: `File "${file.name}" has invalid type "${file.type}"` },
                  { status: 400 }
                );
              }
            }
          }
          files.push(file);
        } else {
          // Try to parse JSON values
          try {
            fields[key] = JSON.parse(value);
          } catch {
            fields[key] = value;
          }
        }
      }

      // Validate fields with Zod schema
      const validatedFields = def.input ? def.input.parse(fields) : fields;

      // Call handler
      const result = await handle({ fields: validatedFields, files }, ctx);

      // Validate and return output
      const output = def.output ? def.output.parse(result) : result;
      return Response.json(output);
    } catch (e: any) {
      console.error(e);
      if (e instanceof z.ZodError) {
        return Response.json({ error: "Validation Failed", details: e.issues }, { status: 400 });
      }
      return Response.json({ error: e.message || "Internal Error" }, { status: e.status || 500 });
    }
  },
  __signature: undefined as unknown as FormDataFn
};

// ==========================================
// 6. HTML Handler (HTML Responses)
// ==========================================
/**
 * HTML handler function signature.
 * Returns HTML string or Response.
 */
export type HTMLFn<I = any> = (input: I, ctx: ServerContext) => string | Response | Promise<string | Response>;
export type HTMLHandler = HandlerRuntime<HTMLFn>;

export const HTMLHandler: HTMLHandler = {
  async execute(req, def, handle, ctx) {
    // HTML routes typically use GET, but support POST for form submissions
    if (req.method !== "GET" && req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      // Parse input from query params (GET) or body (POST)
      let body: any = {};
      if (req.method === "POST") {
        const contentType = req.headers.get("Content-Type") || "";
        if (contentType.includes("application/json")) {
          try {
            body = await req.json();
          } catch {
            return Response.json({ error: "Invalid JSON" }, { status: 400 });
          }
        } else if (contentType.includes("application/x-www-form-urlencoded")) {
          const formData = await req.formData();
          for (const [key, value] of formData.entries()) {
            if (typeof value === "string") {
              try {
                body[key] = JSON.parse(value);
              } catch {
                body[key] = value;
              }
            }
          }
        }
      } else {
        // Parse query params for GET requests
        const url = new URL(req.url);
        for (const [key, value] of url.searchParams) {
          try {
            body[key] = JSON.parse(value);
          } catch {
            body[key] = value;
          }
        }
      }

      // Validate input
      const input = def.input ? def.input.parse(body) : body;

      // Call handler
      const result = await handle(input, ctx);

      // If handler returns Response, return it directly
      if (result instanceof Response) {
        return result;
      }

      // Return HTML string with proper content-type
      return new Response(result, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
        },
      });
    } catch (e: any) {
      console.error(e);
      if (e instanceof z.ZodError) {
        // Return HTML error for HTML handler
        return new Response(
          `<html><body><h1>Validation Error</h1><pre>${JSON.stringify(e.issues, null, 2)}</pre></body></html>`,
          { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      return new Response(
        `<html><body><h1>Error</h1><p>${e.message || "Internal Error"}</p></body></html>`,
        { status: e.status || 500, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }
  },
  __signature: undefined as unknown as HTMLFn
};

export const Handlers = {
    typed: TypedHandler,
    raw: RawHandler,
    stream: StreamHandler,
    sse: SSEHandler,
    formData: FormDataHandler,
    html: HTMLHandler
};

