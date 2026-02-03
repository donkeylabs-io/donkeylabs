import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context as LambdaContext } from "aws-lambda";
import { AppServer, type ServerConfig } from "@donkeylabs/server";

export interface ServerlessConfig extends Omit<ServerConfig, "port"> {
  /** Warmup routes (pre-load on cold start) */
  warmupRoutes?: string[];
  
  /** Connection pool size for serverless */
  connectionPoolSize?: number;
}

let serverInstance: AppServer | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Create a serverless handler for AWS Lambda / Vercel
 * 
 * Usage:
 * ```typescript
 * // api/index.ts (Vercel)
 * import { createServerlessHandler } from "@donkeylabs/adapter-serverless";
 * import { server } from "../server";
 * 
 * export default createServerlessHandler(server);
 * ```
 */
export function createServerlessHandler(
  serverFactory: () => AppServer | Promise<AppServer>
): (event: APIGatewayProxyEventV2, context: LambdaContext) => Promise<APIGatewayProxyResultV2> {
  return async (event: APIGatewayProxyEventV2, context: LambdaContext) => {
    // Initialize server on first invocation (cold start)
    if (!serverInstance && !initPromise) {
      initPromise = initializeServer(serverFactory);
    }
    
    if (initPromise) {
      await initPromise;
    }
    
    if (!serverInstance) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Server initialization failed" }),
      };
    }
    
    // Convert Lambda event to Request
    const request = convertEventToRequest(event);
    
    // Handle the request
    try {
      const response = await serverInstance.handleRequest(
        request,
        extractRouteName(event),
        event.requestContext?.http?.sourceIp || "unknown"
      );
      
      if (!response) {
        return {
          statusCode: 404,
          body: JSON.stringify({ error: "Route not found" }),
        };
      }
      
      return await convertResponseToResult(response);
    } catch (error) {
      console.error("Request handler error:", error);
      return {
        statusCode: 500,
        body: JSON.stringify({ 
          error: "Internal server error",
          message: process.env.NODE_ENV === "development" ? String(error) : undefined,
        }),
      };
    }
  };
}

async function initializeServer(
  serverFactory: () => AppServer | Promise<AppServer>
): Promise<void> {
  try {
    serverInstance = await serverFactory();
    
    // Initialize without starting HTTP server
    await serverInstance.initialize();
    
    console.log("Server initialized (serverless mode)");
  } catch (error) {
    console.error("Server initialization failed:", error);
    throw error;
  } finally {
    initPromise = null;
  }
}

function convertEventToRequest(event: APIGatewayProxyEventV2): Request {
  const url = new URL(
    event.rawPath + (event.rawQueryString ? `?${event.rawQueryString}` : ""),
    `https://${event.headers?.host || "localhost"}`
  );
  
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (value) {
      headers.set(key, value);
    }
  }
  
  const method = event.requestContext?.http?.method || "GET";
  
  if (event.body) {
    const body = event.isBase64Encoded 
      ? Buffer.from(event.body, "base64")
      : event.body;
    
    return new Request(url, {
      method,
      headers,
      body,
    });
  }
  
  return new Request(url, { method, headers });
}

function extractRouteName(event: APIGatewayProxyEventV2): string {
  // Extract route name from path
  // /api/users.list -> api.users.list
  const path = event.rawPath || "/";
  
  if (path === "/" || path === "/api") {
    return "health.check";
  }
  
  // Remove /api prefix and convert to dot notation
  const route = path
    .replace(/^\/api\//, "")
    .replace(/\//g, ".");
  
  return route || "health.check";
}

async function convertResponseToResult(
  response: Response
): Promise<APIGatewayProxyResultV2> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  
  const body = await response.text();
  
  return {
    statusCode: response.status,
    headers,
    body,
  };
}

/**
 * Vercel-specific handler wrapper
 * Handles Vercel's specific request/response format
 */
export function createVercelHandler(
  serverFactory: () => AppServer | Promise<AppServer>
) {
  const handler = createServerlessHandler(serverFactory);
  
  return async (req: Request): Promise<Response> => {
    // Convert Vercel Request to Lambda-like event
    const url = new URL(req.url);
    const event: APIGatewayProxyEventV2 = {
      version: "2.0",
      routeKey: `${req.method} ${url.pathname}`,
      rawPath: url.pathname,
      rawQueryString: url.search.slice(1),
      headers: Object.fromEntries(req.headers.entries()),
      requestContext: {
        http: {
          method: req.method,
          path: url.pathname,
          protocol: "HTTPS",
          sourceIp: "unknown",
          userAgent: req.headers.get("user-agent") || "",
        },
        requestId: crypto.randomUUID(),
        time: new Date().toISOString(),
        timeEpoch: Date.now(),
      },
      body: req.body ? await req.text() : undefined,
      isBase64Encoded: false,
    };
    
    const context: LambdaContext = {
      callbackWaitsForEmptyEventLoop: false,
      functionName: "vercel-function",
      functionVersion: "1",
      invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789:function:vercel",
      memoryLimitInMB: "1024",
      awsRequestId: event.requestContext.requestId,
      logGroupName: "/aws/lambda/vercel",
      logStreamName: "2024/01/01/[$LATEST]abc123",
      getRemainingTimeInMillis: () => 30000,
      done: () => {},
      fail: () => {},
      succeed: () => {},
    };
    
    const result = await handler(event, context);
    
    return new Response(result.body, {
      status: result.statusCode || 200,
      headers: result.headers as Record<string, string>,
    });
  };
}
