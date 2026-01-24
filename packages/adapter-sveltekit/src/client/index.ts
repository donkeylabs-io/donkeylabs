/**
 * Unified API client for @donkeylabs/adapter-sveltekit
 *
 * Auto-detects environment:
 * - SSR: Direct service calls through locals (no HTTP)
 * - Browser: HTTP calls to API routes
 */

export interface RequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ClientOptions {
  /** Base URL for HTTP calls. Defaults to empty string (relative URLs). */
  baseUrl?: string;
  /** SvelteKit locals object for SSR direct calls. */
  locals?: any;
  /** Custom fetch function. In SSR, pass event.fetch to handle relative URLs. */
  fetch?: typeof fetch;
}

export interface SSESubscription {
  unsubscribe: () => void;
}

/**
 * SSE options for connection configuration.
 * Compatible with @donkeylabs/server/client SSEOptions.
 */
export interface SSEOptions {
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
 * Options for SSE connection behavior.
 */
export interface SSEConnectionOptions {
  /** Enable automatic reconnection on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Delay in ms before attempting reconnect (default: 3000) */
  reconnectDelay?: number;
  /** Called when connection is established */
  onConnect?: () => void;
  /** Called when connection is lost */
  onDisconnect?: () => void;
}

/**
 * Type-safe SSE connection wrapper.
 * Provides typed event handlers with automatic JSON parsing.
 *
 * @example
 * ```ts
 * // With auto-reconnect (default)
 * const connection = api.notifications.subscribe({ userId: "123" });
 *
 * // Disable auto-reconnect for manual control
 * const connection = api.notifications.subscribe({ userId: "123" }, {
 *   autoReconnect: false
 * });
 *
 * // Custom reconnect delay
 * const connection = api.notifications.subscribe({ userId: "123" }, {
 *   reconnectDelay: 5000 // 5 seconds
 * });
 *
 * // Typed event handler - returns unsubscribe function
 * const unsubscribe = connection.on("notification", (data) => {
 *   console.log(data.message); // Fully typed!
 * });
 *
 * // Later: unsubscribe from this specific handler
 * unsubscribe();
 *
 * // Close entire connection
 * connection.close();
 * ```
 */
export class SSEConnection<TEvents extends Record<string, any> = Record<string, any>> {
  private eventSource: EventSource | null;
  private handlers = new Map<string, Set<(data: any) => void>>();
  private url: string;
  private options: SSEConnectionOptions;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(url: string, options: SSEConnectionOptions = {}) {
    this.url = url;
    this.options = {
      autoReconnect: true,
      reconnectDelay: 3000,
      ...options,
    };
    this.eventSource = this.createEventSource();
  }

  private createEventSource(): EventSource {
    const es = new EventSource(this.url);

    es.onopen = () => {
      this.options.onConnect?.();
    };

    es.onerror = () => {
      // Native EventSource auto-reconnects, but we want control
      // Close it and handle reconnection ourselves
      if (this.options.autoReconnect && !this.closed) {
        this.options.onDisconnect?.();
        es.close();
        this.scheduleReconnect();
      }
    };

    // Re-attach existing handlers to new EventSource
    for (const [event] of this.handlers) {
      es.addEventListener(event, (e: MessageEvent) => {
        this.dispatchEvent(event, e.data);
      });
    }

    return es;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout || this.closed) return;

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (!this.closed) {
        this.eventSource = this.createEventSource();
      }
    }, this.options.reconnectDelay);
  }

  private dispatchEvent(event: string, rawData: string): void {
    const handlers = this.handlers.get(event);
    if (!handlers) return;

    let data: any;
    try {
      data = JSON.parse(rawData);
    } catch {
      data = rawData;
    }

    for (const h of handlers) {
      h(data);
    }
  }

  /**
   * Register a typed event handler.
   * @returns Unsubscribe function to remove this specific handler
   */
  on<K extends keyof TEvents>(
    event: K & string,
    handler: (data: TEvents[K]) => void
  ): () => void {
    const isNewEvent = !this.handlers.has(event);

    if (isNewEvent) {
      this.handlers.set(event, new Set());

      // Add EventSource listener for this event type
      this.eventSource?.addEventListener(event, (e: MessageEvent) => {
        this.dispatchEvent(event, e.data);
      });
    }

    this.handlers.get(event)!.add(handler);

    // Return unsubscribe function
    return () => {
      const handlers = this.handlers.get(event);
      if (handlers) {
        handlers.delete(handler);
      }
    };
  }

  /**
   * Register a typed event handler that fires only once.
   * @returns Unsubscribe function to remove this specific handler
   */
  once<K extends keyof TEvents>(
    event: K & string,
    handler: (data: TEvents[K]) => void
  ): () => void {
    const wrappedHandler = (data: TEvents[K]) => {
      unsubscribe();
      handler(data);
    };
    const unsubscribe = this.on(event, wrappedHandler);
    return unsubscribe;
  }

  /**
   * Remove all handlers for an event.
   */
  off<K extends keyof TEvents>(event: K & string): void {
    this.handlers.delete(event);
  }

  /**
   * Register error handler.
   * Note: With autoReconnect enabled, errors trigger automatic reconnection.
   */
  onError(handler: (event: Event) => void): () => void {
    const wrappedHandler = (e: Event) => {
      handler(e);
    };
    if (this.eventSource) {
      const existingHandler = this.eventSource.onerror;
      this.eventSource.onerror = (e) => {
        // Call existing handler (for reconnection logic)
        if (existingHandler) (existingHandler as (e: Event) => void)(e);
        wrappedHandler(e);
      };
    }
    return () => {
      // Can't easily remove, but handler will be replaced on reconnect
    };
  }

  /**
   * Register open handler (connection established)
   */
  onOpen(handler: (event: Event) => void): () => void {
    if (this.eventSource) {
      const existingHandler = this.eventSource.onopen;
      this.eventSource.onopen = (e) => {
        if (existingHandler) (existingHandler as (e: Event) => void)(e);
        handler(e);
      };
    }
    return () => {
      if (this.eventSource) this.eventSource.onopen = null;
    };
  }

  /**
   * Get connection state
   */
  get readyState(): number {
    return this.eventSource?.readyState ?? EventSource.CLOSED;
  }

  /**
   * Check if connected
   */
  get connected(): boolean {
    return this.eventSource?.readyState === EventSource.OPEN;
  }

  /**
   * Check if reconnecting
   */
  get reconnecting(): boolean {
    return this.reconnectTimeout !== null;
  }

  /**
   * Close the SSE connection and stop reconnection attempts
   */
  close(): void {
    this.closed = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.eventSource?.close();
    this.eventSource = null;
    this.handlers.clear();
  }
}

/**
 * Base class for unified API clients.
 * Extend this class with your generated route methods.
 */
export class UnifiedApiClientBase {
  protected baseUrl: string;
  protected locals?: any;
  protected isSSR: boolean;
  protected customFetch?: typeof fetch;

  constructor(options?: ClientOptions) {
    this.baseUrl = options?.baseUrl ?? "";
    this.locals = options?.locals;
    this.isSSR = typeof window === "undefined";
    this.customFetch = options?.fetch;
  }

  /**
   * Make a request to an API route.
   * Automatically uses direct calls in SSR (when locals.handleRoute is available), HTTP otherwise.
   */
  protected async request<TInput, TOutput>(
    route: string,
    input: TInput,
    options?: RequestOptions
  ): Promise<TOutput> {
    // Use direct route handler if available (SSR with locals)
    if (this.locals?.handleRoute) {
      return this.locals.handleRoute(route, input);
    }
    // Fall back to HTTP (browser or SSR without locals)
    return this.httpCall<TInput, TOutput>(route, input, options);
  }

  /**
   * HTTP call to API endpoint (browser or SSR with event.fetch).
   */
  private async httpCall<TInput, TOutput>(
    route: string,
    input: TInput,
    options?: RequestOptions
  ): Promise<TOutput> {
    const url = `${this.baseUrl}/${route}`;
    const fetchFn = this.customFetch ?? fetch;

    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
      body: JSON.stringify(input),
      signal: options?.signal,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(error.message || error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Make a raw request (for non-JSON endpoints like streaming).
   * Returns the raw Response object without processing.
   */
  protected async rawRequest(
    route: string,
    init?: RequestInit
  ): Promise<Response> {
    const url = `${this.baseUrl}/${route}`;
    const fetchFn = this.customFetch ?? fetch;

    return fetchFn(url, {
      method: "POST",
      ...init,
    });
  }

  /**
   * Make a stream request (validated input, Response output).
   * For streaming, binary data, or custom content-type responses.
   *
   * By default uses POST with JSON body. For browser compatibility
   * (video src, image src, download links), use streamUrl() instead.
   */
  protected async streamRequest<TInput>(
    route: string,
    input: TInput,
    options?: RequestOptions
  ): Promise<Response> {
    const url = `${this.baseUrl}/${route}`;
    const fetchFn = this.customFetch ?? fetch;

    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
      body: JSON.stringify(input),
      signal: options?.signal,
    });

    // Unlike typed requests, we return the raw Response
    // Error handling is left to the caller
    return response;
  }

  /**
   * Get the URL for a stream endpoint (for browser src attributes).
   * Returns a URL with query params that can be used in:
   * - <video src={url}>
   * - <img src={url}>
   * - <a href={url} download>
   * - window.open(url)
   */
  protected streamUrl<TInput>(route: string, input?: TInput): string {
    let url = `${this.baseUrl}/${route}`;

    if (input && typeof input === "object") {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(input)) {
        params.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
      url += `?${params.toString()}`;
    }

    return url;
  }

  /**
   * Fetch a stream via GET with query params.
   * Alternative to streamRequest() for cases where GET is preferred.
   */
  protected async streamGet<TInput>(
    route: string,
    input?: TInput,
    options?: RequestOptions
  ): Promise<Response> {
    const url = this.streamUrl(route, input);
    const fetchFn = this.customFetch ?? fetch;

    return fetchFn(url, {
      method: "GET",
      headers: options?.headers,
      signal: options?.signal,
    });
  }

  /**
   * Connect to an SSE endpoint.
   * Returns a typed SSEConnection for handling server-sent events.
   */
  protected sseConnect<TInput, TEvents extends Record<string, any> = Record<string, any>>(
    route: string,
    input?: TInput,
    options?: SSEConnectionOptions
  ): SSEConnection<TEvents> {
    let url = `${this.baseUrl}/${route}`;

    // Add input as query params for GET request
    if (input && typeof input === "object") {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(input)) {
        params.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
      url += `?${params.toString()}`;
    }

    return new SSEConnection<TEvents>(url, options);
  }

  /**
   * Connect to a specific SSE route endpoint.
   * Alias for sseConnect() - provides compatibility with @donkeylabs/server generated clients.
   * @returns SSE connection with typed event handlers
   */
  protected connectToSSERoute<TEvents extends Record<string, any>>(
    route: string,
    input: Record<string, any> = {},
    options?: Omit<SSEOptions, "endpoint" | "channels">
  ): SSEConnection<TEvents> {
    // Map SSEOptions to SSEConnectionOptions
    const connectionOptions: SSEConnectionOptions | undefined = options ? {
      autoReconnect: options.autoReconnect,
      reconnectDelay: options.reconnectDelay,
      onConnect: options.onConnect,
      onDisconnect: options.onDisconnect,
    } : undefined;
    return this.sseConnect<Record<string, any>, TEvents>(route, input, connectionOptions);
  }

  /**
   * Make a formData request (file uploads with validated fields).
   */
  protected async formDataRequest<TFields, TOutput>(
    route: string,
    fields: TFields,
    files: File[],
    options?: RequestOptions
  ): Promise<TOutput> {
    const url = `${this.baseUrl}/${route}`;
    const fetchFn = this.customFetch ?? fetch;

    const formData = new FormData();

    // Add fields
    if (fields && typeof fields === "object") {
      for (const [key, value] of Object.entries(fields)) {
        formData.append(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    }

    // Add files
    for (const file of files) {
      formData.append("file", file);
    }

    const response = await fetchFn(url, {
      method: "POST",
      headers: options?.headers,
      body: formData,
      signal: options?.signal,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(error.message || error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Make an HTML request (returns HTML string).
   */
  protected async htmlRequest<TInput>(
    route: string,
    input?: TInput,
    options?: RequestOptions
  ): Promise<string> {
    let url = `${this.baseUrl}/${route}`;
    const fetchFn = this.customFetch ?? fetch;

    // Add input as query params for GET request
    if (input && typeof input === "object") {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(input)) {
        params.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
      url += `?${params.toString()}`;
    }

    const response = await fetchFn(url, {
      method: "GET",
      headers: {
        Accept: "text/html",
        ...options?.headers,
      },
      signal: options?.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.text();
  }

  /**
   * SSE (Server-Sent Events) subscription.
   * Only works in the browser.
   */
  sse = {
    /**
     * Subscribe to SSE channels.
     * Returns a function to unsubscribe.
     *
     * @example
     * const unsub = api.sse.subscribe(["notifications"], (event, data) => {
     *   console.log(event, data);
     * });
     * // Later: unsub();
     */
    subscribe: (
      channels: string[],
      callback: (event: string, data: any) => void,
      options?: { reconnect?: boolean }
    ): (() => void) => {
      if (typeof window === "undefined") {
        // SSR - return no-op
        return () => {};
      }

      const url = `${this.baseUrl}/sse?channels=${channels.join(",")}`;
      let eventSource: EventSource | null = new EventSource(url);
      let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

      // Known event types from the server
      const eventTypes = [
        'cron-event', 'job-completed', 'internal-event', 'manual', 'message',
        // Workflow events
        'workflow.started', 'workflow.progress', 'workflow.completed',
        'workflow.failed', 'workflow.cancelled',
        'workflow.step.started', 'workflow.step.completed', 'workflow.step.failed',
      ];

      const handleMessage = (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          callback(e.type || "message", data);
        } catch {
          callback(e.type || "message", e.data);
        }
      };

      const handleError = () => {
        if (options?.reconnect !== false && eventSource) {
          eventSource.close();
          reconnectTimeout = setTimeout(() => {
            eventSource = new EventSource(url);
            // Re-attach all listeners on reconnect
            eventSource.onmessage = handleMessage;
            eventSource.onerror = handleError;
            for (const type of eventTypes) {
              eventSource.addEventListener(type, handleMessage);
            }
          }, 1000);
        }
      };

      // Listen for unnamed messages
      eventSource.onmessage = handleMessage;
      eventSource.onerror = handleError;

      // Listen for named event types (SSE sends "event: type-name")
      for (const type of eventTypes) {
        eventSource.addEventListener(type, handleMessage);
      }

      // Return unsubscribe function
      return () => {
        if (reconnectTimeout) {
          clearTimeout(reconnectTimeout);
        }
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
      };
    },
  };
}

/**
 * Create an API client instance.
 * Call with locals and fetch in SSR, without in browser.
 *
 * @example
 * // +page.server.ts (SSR)
 * const api = createApiClient({ locals, fetch });
 *
 * // +page.svelte (browser)
 * const api = createApiClient();
 */
export function createApiClient<T extends UnifiedApiClientBase>(
  ClientClass: new (options?: ClientOptions) => T,
  options?: ClientOptions
): T {
  return new ClientClass(options);
}
