// Workflow Proxy Utilities
// Provides transparent access to plugins and core services from isolated workflow subprocess via IPC

import type { Socket } from "node:net";
import type { ProxyRequest, ProxyResponse } from "./workflow-socket";

// ============================================
// Types
// ============================================

export interface ProxyConnection {
  /** Send a proxy request and wait for response */
  call(target: "plugin" | "core", service: string, method: string, args: any[]): Promise<any>;
  /** Close the connection */
  close(): void;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// ============================================
// Proxy Connection Implementation
// ============================================

/**
 * Creates a proxy connection that sends requests over a socket and handles responses.
 * Used by the workflow executor subprocess to communicate with the main process.
 */
export class WorkflowProxyConnection implements ProxyConnection {
  private socket: Socket;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private timeoutMs: number;
  private buffer = "";

  constructor(socket: Socket, timeoutMs = 30000) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;

    // Handle incoming data (proxy responses)
    socket.on("data", (data) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    socket.on("error", (err) => {
      // Reject all pending requests on socket error
      for (const [requestId, pending] of this.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Socket error: ${err.message}`));
      }
      this.pendingRequests.clear();
    });

    socket.on("close", () => {
      // Reject all pending requests on socket close
      for (const [requestId, pending] of this.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Socket closed"));
      }
      this.pendingRequests.clear();
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const response = JSON.parse(line) as ProxyResponse;
        this.handleResponse(response);
      } catch {
        // Ignore invalid JSON - might be other message types
      }
    }
  }

  private handleResponse(response: ProxyResponse): void {
    const pending = this.pendingRequests.get(response.requestId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.requestId);

    if (response.type === "proxy.result") {
      pending.resolve(response.result);
    } else {
      pending.reject(new Error(response.error ?? "Proxy call failed"));
    }
  }

  async call(target: "plugin" | "core", service: string, method: string, args: any[]): Promise<any> {
    const requestId = `req_${++this.requestCounter}_${Date.now()}`;

    const request: ProxyRequest = {
      type: "proxy.call",
      requestId,
      target,
      service,
      method,
      args,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Proxy call timed out: ${target}.${service}.${method}`));
      }, this.timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      // Send request
      this.socket.write(JSON.stringify(request) + "\n", (err) => {
        if (err) {
          clearTimeout(timeout);
          this.pendingRequests.delete(requestId);
          reject(new Error(`Failed to send proxy request: ${err.message}`));
        }
      });
    });
  }

  close(): void {
    // Cancel all pending requests
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Connection closed"));
    }
    this.pendingRequests.clear();
  }
}

// ============================================
// Proxy Factories
// ============================================

/**
 * Creates a proxy object for accessing a plugin service.
 * Method calls are intercepted and forwarded via IPC to the main process.
 *
 * @example
 * const usersProxy = createPluginProxy(connection, "users");
 * const user = await usersProxy.getById("user_123"); // Calls main process
 */
export function createPluginProxy<T = Record<string, any>>(
  connection: ProxyConnection,
  pluginName: string
): T {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;

      // Return a function that calls the method via IPC
      return async (...args: any[]) => {
        return connection.call("plugin", pluginName, prop as string, args);
      };
    },
  }) as T;
}

/**
 * Creates a proxy object for accessing a core service.
 * Method calls are intercepted and forwarded via IPC to the main process.
 *
 * @example
 * const cacheProxy = createCoreProxy(connection, "cache");
 * await cacheProxy.set("key", "value"); // Calls main process
 */
export function createCoreProxy<T = Record<string, any>>(
  connection: ProxyConnection,
  serviceName: string
): T {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;

      // Return a function that calls the method via IPC
      return async (...args: any[]) => {
        return connection.call("core", serviceName, prop as string, args);
      };
    },
  }) as T;
}

/**
 * Creates a full plugins proxy that lazily creates plugin proxies on access.
 *
 * @example
 * const plugins = createPluginsProxy(connection);
 * const user = await plugins.users.getById("user_123");
 * const order = await plugins.orders.create({ ... });
 */
export function createPluginsProxy(connection: ProxyConnection): Record<string, any> {
  const cache = new Map<string, any>();

  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;

      const pluginName = prop as string;
      if (!cache.has(pluginName)) {
        cache.set(pluginName, createPluginProxy(connection, pluginName));
      }
      return cache.get(pluginName);
    },
  });
}

/**
 * Creates a full core services proxy that lazily creates service proxies on access.
 * Note: Some services like db require special handling as they can't be fully proxied.
 *
 * @example
 * const core = createCoreServicesProxy(connection);
 * await core.cache.set("key", "value");
 * await core.events.emit("user.created", { userId: "123" });
 */
export function createCoreServicesProxy(connection: ProxyConnection): Record<string, any> {
  const cache = new Map<string, any>();

  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;

      const serviceName = prop as string;
      if (!cache.has(serviceName)) {
        cache.set(serviceName, createCoreProxy(connection, serviceName));
      }
      return cache.get(serviceName);
    },
  });
}
