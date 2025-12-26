import {
  API_VERSION_HEADER,
  type RouteDefinition,
  type RequestTypeForRoute,
  type ResponseTypeForRoute,
  type RouteDefinitionVersions,
  isVersionedRouteDefinition,
} from "../interfaces/server/route";
import type { RouterDefinition } from "../interfaces/server/router";
import { ApiError, APIErrors, ErrorType, type ApiErrorResponse } from "../errors";
import { type RawSession, type UserSession } from "../jwt";

import { SessionUtil, type APIClientPersistance } from "./persistance";
import { APIStorage } from "./persistance/local-storage/api-storage";
import {
  type BatchResult,
  type BatchResults,
  type ParallelResults,
  type BatchRequestPayload,
  type BatchResponsePayload,
  type BatchOptions,
  BATCH_MAX_SIZE,
  BATCH_ENDPOINT,
} from "./batch";

// Generic types for any API definition
type AnyAPIRoutes = Record<string, RouterDefinition<Record<string, string>, any>>;

export type RouterNameFor<API extends AnyAPIRoutes> = keyof API & string;
export type RouteNameFor<API extends AnyAPIRoutes, R extends RouterNameFor<API>> = keyof API[R]["routes"] & string;

type RouteSpecFor<API extends AnyAPIRoutes, R extends RouterNameFor<API>, M extends RouteNameFor<API, R>> = API[R]["routes"][M];
type RouteVersionsFor<API extends AnyAPIRoutes, R extends RouterNameFor<API>, M extends RouteNameFor<API, R>> = RouteDefinitionVersions<RouteSpecFor<API, R, M>>;

export type ApiVersionsFor<API extends AnyAPIRoutes> = {
  [R in RouterNameFor<API>]: {
    [M in RouteNameFor<API, R>]: RouteVersionsFor<API, R, M>;
  }[RouteNameFor<API, R>];
}[RouterNameFor<API>];

type RoutesWithVersionFor<API extends AnyAPIRoutes, R extends RouterNameFor<API>, V extends ApiVersionsFor<API>> = {
  [M in RouteNameFor<API, R>]: V extends RouteVersionsFor<API, R, M> ? M : never;
}[RouteNameFor<API, R>];

// Helper types to extract Request and Response types from RouteDefinition
export type ExtractRequestType<Route> = RequestTypeForRoute<Route>;
export type ExtractResponseType<Route> = ResponseTypeForRoute<Route>;

export type RequestConfig = {
  fetchFn?: typeof fetch;
};

/**
 * Creates a type-safe API request builder for your API definition.
 *
 * @example
 * ```typescript
 * import { API } from "./your-routes";
 * import { createAPIRequestBuilder } from "@donkeylabs/core";
 *
 * export const APIRequest = createAPIRequestBuilder(API);
 *
 * // Now use it with full type safety:
 * const request = APIRequest.router("user").route("list").input({}).build();
 * ```
 */
export function createAPIRequestBuilder<API extends AnyAPIRoutes>(api: API) {
  return {
    version<V extends ApiVersionsFor<API>>(version: V): VersionedRouterBuilder<API, V> {
      return new VersionedRouterBuilder<API, V>(api, version);
    },

    router<R extends RouterNameFor<API>>(routerName: R): RouterBuilder<API, R> {
      const router = api[routerName];
      return new RouterBuilder<API, R>(api, routerName, router.routes);
    },
  };
}

export class APIClient {
  private requestConfig: RequestConfig = {};
  private persistance: APIClientPersistance;
  private onError: (error: Error) => void = (error) => {
    console.error(error);
  };
  private onSessionExpired: () => void = () => {
    console.log("Session expired");
  };

  private onSessionRequired: () => void = () => {
    console.log("Session required");
  };

  private refreshTokenFn?: (client: APIClient, refreshToken: string) => Promise<RawSession>;

  constructor(
    private baseUrl: string,
    private storage: "local-storage" | "in-memory" = "local-storage",
  ) {
    this.persistance = new APIStorage(storage);
  }

  /**
   * Set a custom refresh token function.
   * This allows the client to refresh tokens using your API's auth routes.
   *
   * @example
   * ```typescript
   * client.setRefreshTokenFn(async (client, refreshToken) => {
   *   const request = APIRequest.router("auth").route("refreshToken").input({ refreshToken }).build();
   *   return await new APIClient(baseUrl, "in-memory").run(request);
   * });
   * ```
   */
  setRefreshTokenFn(fn: (client: APIClient, refreshToken: string) => Promise<RawSession>): void {
    this.refreshTokenFn = fn;
  }

  getSession(): UserSession | null {
    return this.persistance.getSession();
  }

  setOnSessionRequired(onSessionRequired: () => void): void {
    this.onSessionRequired = onSessionRequired;
  }

  setUserSession(session: RawSession): void {
    this.persistance.setSession(SessionUtil.getTokenData(session));
  }

  setOnError(onError: (error: Error) => void): void {
    this.onError = onError;
  }

  setOnSessionExpired(onSessionExpired: () => void): void {
    this.onSessionExpired = onSessionExpired;
  }

  async run<Req, Res>(
    { routeDef, input, noCache, version }: RouteRequest<Req, Res>,
    config: RequestConfig = this.requestConfig,
  ): Promise<Res> {
    if (!input && routeDef.method !== "get") {
      throw new Error("Input data is required.");
    }

    const session = await this.useSession();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
      ...(noCache
        ? {
            "Cache-Control": "no-cache, no-store, must-revalidate",
            Pragma: "no-cache",
            Expires: "0",
          }
        : {}),
    };
    if (version) {
      headers[API_VERSION_HEADER] = version;
    }

    const url = `${this.baseUrl}${routeDef.path}`;

    const options: RequestInit = {
      method: routeDef.method,
      headers,
      body: routeDef.method !== "get" ? JSON.stringify(input) : undefined,
    };

    let response: Response;

    if (config.fetchFn) {
      response = await config.fetchFn(url, options);
    } else {
      response = await fetch(url, options);
    }

    if (!response.ok) {
      const errorData = await response.json();

      try {
        const error = APIErrors.fromResponse(errorData);
        this.onError(error);
        throw error;
      } catch (parseError) {
        // Fallback: create error from raw data if parsing fails
        const fallbackError = new ApiError(
          errorData.type || ErrorType.INTERNAL_SERVER_ERROR,
          errorData.message || "Server error",
          errorData.details,
          parseError,
        );

        this.onError(fallbackError);
        throw fallbackError;
      }
    }

    const contentType = response.headers.get("Content-Type");
    if (contentType === "application/pdf") {
      return (await response.blob()) as Res;
    }

    const responseData = await response.json();
    return routeDef.parseResponse(responseData);
  }

  /**
   * Execute multiple requests in a single batch call.
   * Each result is wrapped in BatchResult<T> with ok/error status.
   * Never throws on individual request failures.
   */
  async batch<T extends readonly RouteRequest<any, any>[]>(
    requests: T,
    config: RequestConfig = this.requestConfig,
  ): Promise<BatchResults<T>> {
    if (requests.length === 0) {
      return [] as unknown as BatchResults<T>;
    }

    if (requests.length > BATCH_MAX_SIZE) {
      throw new Error(`Batch size exceeds maximum of ${BATCH_MAX_SIZE}`);
    }

    const session = await this.useSession();
    const traceId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const payload: BatchRequestPayload = {
      traceId,
      failFast: false,
      requests: requests.map((req, index) => ({
        id: `req_${index}`,
        router: req.routerName || "",
        route: req.routeName || "",
        params: req.input,
        version: req.version,
      })),
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
    };

    const url = `${this.baseUrl}${BATCH_ENDPOINT}`;
    const fetchFn = config.fetchFn || fetch;

    const response = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = await response.json();
      const error = APIErrors.fromResponse(errorData);
      this.onError(error);
      throw error;
    }

    const batchResponse: BatchResponsePayload = await response.json();

    // Map results back, parsing successful responses with their route's schema
    const results = batchResponse.results.map((result, index) => {
      if (result.ok) {
        const routeDef = requests[index].routeDef;
        try {
          const parsedData = routeDef.parseResponse(result.data);
          return { ok: true as const, data: parsedData, cached: result.cached, ms: result.ms };
        } catch (parseError) {
          return {
            ok: false as const,
            error: {
              type: ErrorType.VALIDATION_ERROR,
              message: "Failed to parse response",
              details: { parseError },
            },
            ms: result.ms,
          };
        }
      } else {
        return { ok: false as const, error: result.error, ms: result.ms };
      }
    });

    return results as BatchResults<T>;
  }

  /**
   * Execute multiple requests in parallel. Throws on first failure.
   * Returns unwrapped response types directly.
   */
  async parallel<T extends readonly RouteRequest<any, any>[]>(
    requests: T,
    config: RequestConfig = this.requestConfig,
  ): Promise<ParallelResults<T>> {
    if (requests.length === 0) {
      return [] as unknown as ParallelResults<T>;
    }

    if (requests.length > BATCH_MAX_SIZE) {
      throw new Error(`Batch size exceeds maximum of ${BATCH_MAX_SIZE}`);
    }

    const session = await this.useSession();
    const traceId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const payload: BatchRequestPayload = {
      traceId,
      failFast: true,
      requests: requests.map((req, index) => ({
        id: `req_${index}`,
        router: req.routerName || "",
        route: req.routeName || "",
        params: req.input,
        version: req.version,
      })),
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
    };

    const url = `${this.baseUrl}${BATCH_ENDPOINT}`;
    const fetchFn = config.fetchFn || fetch;

    const response = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = await response.json();
      const error = APIErrors.fromResponse(errorData);
      this.onError(error);
      throw error;
    }

    const batchResponse: BatchResponsePayload = await response.json();

    // Check for any failures and throw the first one
    const firstError = batchResponse.results.find((r) => !r.ok);
    if (firstError && !firstError.ok) {
      const error = new ApiError(
        (firstError.error.type as ErrorType) || ErrorType.INTERNAL_SERVER_ERROR,
        firstError.error.message,
        firstError.error.details as Record<string, any> | undefined,
      );
      this.onError(error);
      throw error;
    }

    // Parse and return unwrapped results
    const results = batchResponse.results.map((result, index) => {
      if (!result.ok) {
        throw new Error("Unexpected error in parallel results");
      }
      const routeDef = requests[index].routeDef;
      return routeDef.parseResponse(result.data);
    });

    return results as ParallelResults<T>;
  }

  async useSession(): Promise<UserSession | null> {
    let session = this.persistance.getSession();
    if (session) {
      if (session.accessTokenExpiration < new Date()) {
        session = await this.refreshSession(session.refreshToken);
      }
    }

    return session;
  }

  handleSessionExpired() {
    this.persistance.clearSession();
    this.onSessionExpired();
  }

  logout() {
    this.handleSessionExpired();
  }

  private async refreshSession(refreshToken: string): Promise<UserSession> {
    if (!this.refreshTokenFn) {
      throw new Error(
        "No refresh token function configured. Use client.setRefreshTokenFn() to configure token refresh."
      );
    }

    try {
      const response = await this.refreshTokenFn(this, refreshToken);
      const session = SessionUtil.getTokenData(response);
      this.persistance.setSession(session);
      return session;
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.toResponse().type === ErrorType.REFRESH_TOKEN_EXPIRED) {
          this.handleSessionExpired();
        }
      } else {
        this.onError(error as Error);
      }

      throw error;
    }
  }
}

export class VersionedRouterBuilder<API extends AnyAPIRoutes, V extends ApiVersionsFor<API>> {
  constructor(
    private api: API,
    private version: V,
  ) {}

  router<R extends RouterNameFor<API>>(routerName: R): VersionedRouteBuilder<API, R, V> {
    return new VersionedRouteBuilder<API, R, V>(this.api, this.version, routerName, this.api[routerName].routes);
  }
}

export class RouterBuilder<API extends AnyAPIRoutes, R extends RouterNameFor<API>> {
  constructor(
    private api: API,
    private routerName: R,
    private routes: API[R]["routes"],
  ) {}

  route<M extends RouteNameFor<API, R>>(
    routeName: M,
  ): RouteBuilder<
    API,
    R,
    M,
    ExtractRequestType<API[R]["routes"][M]>,
    ExtractResponseType<API[R]["routes"][M]>
  > {
    const routeSpec = this.routes[routeName];
    const routeDef = isVersionedRouteDefinition(routeSpec)
      ? routeSpec.versions[routeSpec.defaultVersion]
      : routeSpec;
    const version = isVersionedRouteDefinition(routeSpec) ? String(routeSpec.defaultVersion) : undefined;

    return new RouteBuilder<
      API,
      R,
      M,
      ExtractRequestType<API[R]["routes"][M]>,
      ExtractResponseType<API[R]["routes"][M]>
    >(routeDef, this.routerName, routeName as string, version);
  }
}

export class RouteRequest<Req, Res> {
  constructor(
    public routeDef: RouteDefinition<Req, Res>,
    public input?: Req,
    public noCache: boolean = false,
    public routerName?: string,
    public routeName?: string,
    public version?: string,
  ) {}
}

class VersionedRouteBuilder<API extends AnyAPIRoutes, R extends RouterNameFor<API>, V extends ApiVersionsFor<API>> {
  constructor(
    private api: API,
    private version: V,
    private routerName: R,
    private routes: API[R]["routes"],
  ) {}

  route<M extends RoutesWithVersionFor<API, R, V>>(
    routeName: M,
  ): RouteBuilder<
    API,
    R,
    M,
    RequestTypeForRoute<API[R]["routes"][M], V>,
    ResponseTypeForRoute<API[R]["routes"][M], V>
  > {
    const routeSpec = this.routes[routeName];
    if (!isVersionedRouteDefinition(routeSpec)) {
      throw new Error(`Route ${String(routeName)} is not versioned`);
    }

    const routeDef = routeSpec.versions[this.version as keyof typeof routeSpec.versions] as RouteDefinition<
      RequestTypeForRoute<API[R]["routes"][M], V>,
      ResponseTypeForRoute<API[R]["routes"][M], V>
    >;

    return new RouteBuilder<
      API,
      R,
      M,
      RequestTypeForRoute<API[R]["routes"][M], V>,
      ResponseTypeForRoute<API[R]["routes"][M], V>
    >(routeDef, this.routerName, routeName as string, String(this.version));
  }
}

class RouteBuilder<API extends AnyAPIRoutes, R extends RouterNameFor<API>, M extends RouteNameFor<API, R>, Req, Res> {
  private inputData?: Req;
  private cacheDisabled: boolean = false;

  constructor(
    private routeDef: RouteDefinition<Req, Res>,
    private routerName: string,
    private routeName: string,
    private version?: string,
  ) {}

  /**
   * Sets the input data for the API call.
   */
  input(data: Req): this {
    this.inputData = data;
    return this;
  }

  /**
   * Disables caching for this request.
   */
  noCache(): this {
    this.cacheDisabled = true;
    return this;
  }

  build(): RouteRequest<Req, Res> {
    return new RouteRequest(
      this.routeDef,
      this.inputData,
      this.cacheDisabled,
      this.routerName,
      this.routeName,
      this.version,
    );
  }
}

export default APIClient;
