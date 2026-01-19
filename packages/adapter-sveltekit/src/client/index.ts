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
      const eventTypes = ['cron-event', 'job-completed', 'internal-event', 'manual', 'message'];

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
