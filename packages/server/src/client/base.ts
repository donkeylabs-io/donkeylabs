/**
 * API Client Base Runtime
 *
 * This file provides the runtime implementation for the generated API client.
 * It handles HTTP requests, SSE connections, and typed event handling.
 */

// ============================================
// Type Declarations (for environments without DOM types)
// ============================================

type CredentialsMode = "include" | "same-origin" | "omit";

// EventSource type declarations for non-DOM environments
interface SSEMessageEvent {
  data: string;
  lastEventId: string;
  origin: string;
}

type SSEEventHandler = (event: SSEMessageEvent | Event) => void;

declare class EventSource {
  readonly readyState: number;
  readonly url: string;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: SSEMessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  constructor(url: string, eventSourceInitDict?: { withCredentials?: boolean });
  addEventListener(type: string, listener: SSEEventHandler): void;
  removeEventListener(type: string, listener: SSEEventHandler): void;
  close(): void;
}

// ============================================
// Error Types
// ============================================

/**
 * API Error response from the server.
 * Matches the HttpError format from the server.
 */
export interface ApiErrorBody {
  error: string;
  message: string;
  details?: Record<string, any>;
}

/**
 * Base API error class.
 * Thrown when the server returns a non-2xx response.
 */
export class ApiError extends Error {
  /** HTTP status code */
  public readonly status: number;
  /** Error code from server (e.g., "BAD_REQUEST", "NOT_FOUND") */
  public readonly code: string;
  /** Full response body */
  public readonly body: ApiErrorBody | any;
  /** Additional error details */
  public readonly details?: Record<string, any>;

  constructor(
    status: number,
    body: ApiErrorBody | any,
    message?: string
  ) {
    super(message || body?.message || `API Error: ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.code = body?.error || "UNKNOWN_ERROR";
    this.details = body?.details;
  }

  /**
   * Check if this is a specific error type
   */
  is(code: string): boolean {
    return this.code === code;
  }
}

/**
 * Validation error (400 Bad Request with validation details).
 * Contains detailed information about what failed validation.
 */
export class ValidationError extends ApiError {
  /** Validation issue details */
  public readonly validationDetails: Array<{ path: (string | number)[]; message: string }>;

  constructor(details: Array<{ path: (string | number)[]; message: string }>) {
    super(400, { error: "BAD_REQUEST", message: "Validation Failed", details }, "Validation Failed");
    this.name = "ValidationError";
    this.validationDetails = details;
  }

  /**
   * Get errors for a specific field path
   */
  getFieldErrors(fieldPath: string | string[]): string[] {
    const path = Array.isArray(fieldPath) ? fieldPath : [fieldPath];
    return this.validationDetails
      .filter((issue) => {
        if (issue.path.length !== path.length) return false;
        return issue.path.every((p, i) => p === path[i]);
      })
      .map((issue) => issue.message);
  }

  /**
   * Check if a specific field has errors
   */
  hasFieldError(fieldPath: string | string[]): boolean {
    return this.getFieldErrors(fieldPath).length > 0;
  }
}

/**
 * Convenience error type checks
 */
export const ErrorCodes = {
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  CONFLICT: "CONFLICT",
  GONE: "GONE",
  UNPROCESSABLE_ENTITY: "UNPROCESSABLE_ENTITY",
  TOO_MANY_REQUESTS: "TOO_MANY_REQUESTS",
  INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  BAD_GATEWAY: "BAD_GATEWAY",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  GATEWAY_TIMEOUT: "GATEWAY_TIMEOUT",
} as const;

// ============================================
// Request Options
// ============================================

export interface RequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  /** Default headers to include in all requests */
  headers?: Record<string, string>;
  /** Credentials mode for fetch (default: 'include' for HTTP-only cookies) */
  credentials?: CredentialsMode;
  /** Called when authentication state changes (login/logout) */
  onAuthChange?: (authenticated: boolean) => void;
  /** Custom fetch implementation (for testing or Node.js polyfills) */
  fetch?: typeof fetch;
}

// ============================================
// SSE Types
// ============================================

export interface SSEOptions {
  /** Endpoint path for SSE connection (default: '/sse') */
  endpoint?: string;
  /** Channels to subscribe to on connect */
  channels?: string[];
  /** Called when connection is established */
  onConnect?: () => void;
  /** Called when connection is lost */
  onDisconnect?: () => void;
  /** Called on connection error */
  onError?: (error: Event) => void;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Reconnect delay in ms (default: 3000) */
  reconnectDelay?: number;
}

/**
 * SSE subscription returned by route-specific SSE methods.
 * Provides typed event handling for the route's defined events.
 */
export interface SSESubscription<TEvents extends Record<string, any>> {
  /** Subscribe to a typed event. Returns unsubscribe function. */
  on<E extends keyof TEvents>(event: E, handler: (data: TEvents[E]) => void): () => void;
  /** Subscribe to an event once. Returns unsubscribe function. */
  once<E extends keyof TEvents>(event: E, handler: (data: TEvents[E]) => void): () => void;
  /** Remove all handlers for an event. */
  off<E extends keyof TEvents>(event: E): void;
  /** Close the SSE connection. */
  close(): void;
  /** Whether the connection is currently open. */
  readonly connected: boolean;
}

// ============================================
// Base Client Implementation
// ============================================

/**
 * Base API client with HTTP request handling and SSE support.
 * Extended by the generated client with typed routes and events.
 */
export class ApiClientBase<TEvents extends Record<string, any> = Record<string, any>> {
  protected readonly baseUrl: string;
  protected readonly options: ApiClientOptions;
  private eventSource: EventSource | null = null;
  private eventHandlers: Map<string, Set<(data: any) => void>> = new Map();
  private sseOptions: SSEOptions = {};
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(baseUrl: string, options: ApiClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.options = {
      credentials: "include",
      ...options,
    };
  }

  // ==========================================
  // HTTP Request Methods
  // ==========================================

  /**
   * Make a typed POST request to a route
   */
  protected async request<TInput, TOutput>(
    route: string,
    input: TInput,
    options: RequestOptions = {}
  ): Promise<TOutput> {
    const fetchFn = this.options.fetch || fetch;

    const response = await fetchFn(`${this.baseUrl}/${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.options.headers,
        ...options.headers,
      },
      credentials: this.options.credentials,
      body: JSON.stringify(input),
      signal: options.signal,
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as Record<string, any>;

      // Check for validation errors (from Zod validation)
      // Server sends: { error: "BAD_REQUEST", message: "Validation Failed", details: { issues: [...] } }
      if (response.status === 400 && body.details?.issues) {
        throw new ValidationError(body.details.issues);
      }

      throw new ApiError(response.status, body, body.message);
    }

    // Handle empty responses (204 No Content)
    if (response.status === 204) {
      return undefined as TOutput;
    }

    return response.json() as Promise<TOutput>;
  }

  /**
   * Make a raw request (for non-JSON endpoints like streaming)
   */
  protected async rawRequest(
    route: string,
    init?: RequestInit
  ): Promise<Response> {
    const fetchFn = this.options.fetch || fetch;
    const requestInit = init ?? {};

    return fetchFn(`${this.baseUrl}/${route}`, {
      method: "POST",
      ...requestInit,
      headers: {
        ...this.options.headers,
        ...requestInit.headers,
      },
      credentials: this.options.credentials,
    });
  }

  /**
   * Make a stream/html request with validated input, returns raw Response
   */
  protected async streamRequest<TInput>(
    route: string,
    input: TInput
  ): Promise<Response> {
    const fetchFn = this.options.fetch || fetch;

    return fetchFn(`${this.baseUrl}/${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.options.headers,
      },
      credentials: this.options.credentials,
      body: JSON.stringify(input),
    });
  }

  /**
   * Upload form data with files
   */
  protected async uploadFormData<TFields, TOutput>(
    route: string,
    fields: TFields,
    files?: File[]
  ): Promise<TOutput> {
    const fetchFn = this.options.fetch || fetch;
    const formData = new FormData();

    // Add fields as JSON values
    for (const [key, value] of Object.entries(fields as Record<string, any>)) {
      formData.append(key, typeof value === "string" ? value : JSON.stringify(value));
    }

    // Add files
    if (files) {
      for (const file of files) {
        formData.append("file", file);
      }
    }

    const response = await fetchFn(`${this.baseUrl}/${route}`, {
      method: "POST",
      headers: {
        ...this.options.headers,
        // Don't set Content-Type - browser will set it with boundary
      },
      credentials: this.options.credentials,
      body: formData,
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as Record<string, any>;
      if (response.status === 400 && body.details?.issues) {
        throw new ValidationError(body.details.issues);
      }
      throw new ApiError(response.status, body, body.message);
    }

    if (response.status === 204) {
      return undefined as TOutput;
    }

    return response.json() as Promise<TOutput>;
  }

  // ==========================================
  // SSE Connection Methods
  // ==========================================

  /**
   * Connect to a specific SSE route endpoint.
   * Used by generated client methods for .sse() routes.
   * @returns SSE subscription with typed event handlers
   */
  protected connectToSSERoute<TEvents extends Record<string, any>>(
    route: string,
    input: Record<string, any> = {},
    options: Omit<SSEOptions, "endpoint" | "channels"> = {}
  ): SSESubscription<TEvents> {
    const url = new URL(`${this.baseUrl}/${route}`);

    // Add input as query params
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    }

    const eventSource = new EventSource(url.toString(), {
      withCredentials: true,
    });

    const handlers = new Map<string, Set<(data: any) => void>>();
    let onConnectCallback: (() => void) | undefined = options.onConnect;
    let onDisconnectCallback: (() => void) | undefined = options.onDisconnect;
    let onErrorCallback: ((error: Event) => void) | undefined = options.onError;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    const autoReconnect = options.autoReconnect ?? true;
    const reconnectDelay = options.reconnectDelay ?? 3000;

    const dispatchEvent = (eventName: string, rawData: string) => {
      const eventHandlers = handlers.get(eventName);
      if (!eventHandlers?.size) return;

      let data: any;
      try {
        data = JSON.parse(rawData);
      } catch {
        data = rawData;
      }

      for (const handler of eventHandlers) {
        try {
          handler(data);
        } catch (error) {
          console.error(`Error in SSE event handler for "${eventName}":`, error);
        }
      }
    };

    const scheduleReconnect = () => {
      if (reconnectTimeout) return;
      reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        // Reconnect by creating new subscription
        const newSub = this.connectToSSERoute<TEvents>(route, input, options);
        // Transfer handlers
        for (const [event, eventHandlers] of handlers) {
          for (const handler of eventHandlers) {
            newSub.on(event as keyof TEvents, handler);
          }
        }
      }, reconnectDelay);
    };

    eventSource.onopen = () => {
      onConnectCallback?.();
    };

    eventSource.onerror = (event) => {
      onErrorCallback?.(event);
      if (eventSource.readyState === 2) {
        onDisconnectCallback?.();
        if (autoReconnect) {
          scheduleReconnect();
        }
      }
    };

    eventSource.onmessage = (event) => {
      dispatchEvent("message", event.data);
    };

    const subscription: SSESubscription<TEvents> = {
      on: <E extends keyof TEvents>(event: E, handler: (data: TEvents[E]) => void) => {
        const eventName = String(event);
        let eventHandlers = handlers.get(eventName);
        if (!eventHandlers) {
          eventHandlers = new Set();
          handlers.set(eventName, eventHandlers);
          // Add listener to EventSource
          if (eventName !== "message") {
            eventSource.addEventListener(eventName, (e) => {
              if ("data" in e) {
                dispatchEvent(eventName, (e as SSEMessageEvent).data);
              }
            });
          }
        }
        eventHandlers.add(handler as (data: any) => void);
        return () => {
          eventHandlers?.delete(handler as (data: any) => void);
        };
      },
      once: <E extends keyof TEvents>(event: E, handler: (data: TEvents[E]) => void) => {
        const unsubscribe = subscription.on(event, (data) => {
          unsubscribe();
          handler(data);
        });
        return unsubscribe;
      },
      off: <E extends keyof TEvents>(event: E) => {
        handlers.delete(String(event));
      },
      close: () => {
        if (reconnectTimeout) {
          clearTimeout(reconnectTimeout);
          reconnectTimeout = null;
        }
        eventSource.close();
        onDisconnectCallback?.();
      },
      get connected() {
        return eventSource.readyState === 1;
      },
    };

    return subscription;
  }

  /**
   * Connect to SSE endpoint for real-time updates
   */
  connect(options: SSEOptions = {}): void {
    if (this.eventSource) {
      this.disconnect();
    }

    this.sseOptions = {
      endpoint: "/sse",
      autoReconnect: true,
      reconnectDelay: 3000,
      ...options,
    };

    const url = new URL(`${this.baseUrl}${this.sseOptions.endpoint}`);

    // Add channel subscriptions as query params
    if (this.sseOptions.channels?.length) {
      for (const channel of this.sseOptions.channels) {
        url.searchParams.append("channel", channel);
      }
    }

    this.eventSource = new EventSource(url.toString(), {
      withCredentials: true,
    });

    this.eventSource.onopen = () => {
      this.sseOptions.onConnect?.();
    };

    this.eventSource.onerror = (event) => {
      this.sseOptions.onError?.(event);

      // Handle reconnection (readyState 2 = CLOSED)
      if (this.eventSource?.readyState === 2) {
        this.sseOptions.onDisconnect?.();

        if (this.sseOptions.autoReconnect) {
          this.scheduleReconnect();
        }
      }
    };

    // Listen for all events and dispatch to handlers
    this.eventSource.onmessage = (event) => {
      this.dispatchEvent("message", event.data);
    };

    // Set up listeners for specific event types
    for (const eventName of this.eventHandlers.keys()) {
      if (eventName !== "message") {
        this.eventSource.addEventListener(eventName, (event) => {
          if ("data" in event) {
            this.dispatchEvent(eventName, event.data);
          }
        });
      }
    }
  }

  /**
   * Disconnect from SSE endpoint
   */
  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
      this.sseOptions.onDisconnect?.();
    }
  }

  /**
   * Check if SSE is connected
   */
  get connected(): boolean {
    // readyState 1 = OPEN
    return this.eventSource?.readyState === 1;
  }

  // ==========================================
  // Event Handling
  // ==========================================

  /**
   * Subscribe to a typed SSE event
   * @returns Unsubscribe function
   */
  on<E extends keyof TEvents>(
    event: E,
    handler: (data: TEvents[E]) => void
  ): () => void {
    const eventName = String(event);
    let handlers = this.eventHandlers.get(eventName);

    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(eventName, handlers);

      // If already connected, add event listener
      if (this.eventSource && eventName !== "message") {
        this.eventSource.addEventListener(eventName, (event) => {
          if ("data" in event) {
            this.dispatchEvent(eventName, event.data);
          }
        });
      }
    }

    handlers.add(handler as (data: any) => void);

    // Return unsubscribe function
    return () => {
      handlers?.delete(handler as (data: any) => void);
      if (handlers?.size === 0) {
        this.eventHandlers.delete(eventName);
      }
    };
  }

  /**
   * Subscribe to an event once
   */
  once<E extends keyof TEvents>(
    event: E,
    handler: (data: TEvents[E]) => void
  ): () => void {
    const unsubscribe = this.on(event, (data) => {
      unsubscribe();
      handler(data);
    });
    return unsubscribe;
  }

  /**
   * Remove all handlers for an event
   */
  off<E extends keyof TEvents>(event: E): void {
    this.eventHandlers.delete(String(event));
  }

  // ==========================================
  // Private Helpers
  // ==========================================

  private dispatchEvent(eventName: string, rawData: string): void {
    const handlers = this.eventHandlers.get(eventName);
    if (!handlers?.size) return;

    let data: any;
    try {
      data = JSON.parse(rawData);
    } catch {
      data = rawData;
    }

    for (const handler of handlers) {
      try {
        handler(data);
      } catch (error) {
        console.error(`Error in event handler for "${eventName}":`, error);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect(this.sseOptions);
    }, this.sseOptions.reconnectDelay);
  }
}

// ============================================
// Type Helpers for Generated Client
// ============================================

/**
 * Extract the input type from a Zod schema
 */
export type ZodInput<T> = T extends { _input: infer I } ? I : never;

/**
 * Extract the output type from a Zod schema
 */
export type ZodOutput<T> = T extends { _output: infer O } ? O : never;

/**
 * Create a typed route method
 */
export type RouteMethod<TInput, TOutput> = (
  input: TInput,
  options?: RequestOptions
) => Promise<TOutput>;

/**
 * Create a route namespace from route definitions
 */
export type RouteNamespace<TRoutes extends Record<string, { input: any; output: any }>> = {
  [K in keyof TRoutes]: RouteMethod<TRoutes[K]["input"], TRoutes[K]["output"]>;
};
