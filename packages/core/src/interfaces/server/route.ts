import { z } from "zod";
import { APIErrors } from "../../errors";
import type { RateLimitConfig } from "./rate-limit";

type RequestOptions = {
  headers?: Record<string, string>;
};
type Method = "get" | "post" | "put" | "delete" | "patch";

export const API_VERSION_HEADER = "x-api-version";

export type VersionedRouteDefinition<
  Versions extends Record<string, RouteDefinition<any, any>>,
  DefaultVersion extends keyof Versions,
> = {
  kind: "versioned";
  versions: Versions;
  defaultVersion: DefaultVersion;
};

export const versioned = <
  const Versions extends Record<string, RouteDefinition<any, any>>,
  const DefaultVersion extends keyof Versions,
>(
  versions: Versions,
  defaultVersion: DefaultVersion,
): VersionedRouteDefinition<Versions, DefaultVersion> => ({
  kind: "versioned",
  versions,
  defaultVersion,
});

export type AnyVersionedRouteDefinition = VersionedRouteDefinition<
  Record<string, RouteDefinition<any, any>>,
  string
>;

export type AnyRouteDefinition = RouteDefinition<any, any> | AnyVersionedRouteDefinition;

export const isVersionedRouteDefinition = (
  route: AnyRouteDefinition,
): route is AnyVersionedRouteDefinition =>
  typeof route === "object" && route !== null && (route as AnyVersionedRouteDefinition).kind === "versioned";

export type RouteDefinitionVersions<Route> = Route extends VersionedRouteDefinition<infer Versions, any>
  ? keyof Versions
  : never;

export type DefaultRouteVersion<Route> = Route extends VersionedRouteDefinition<any, infer DefaultVersion>
  ? DefaultVersion
  : never;

export type RouteDefinitionForVersion<Route, Version extends string | undefined = undefined> =
  Route extends VersionedRouteDefinition<infer Versions, infer DefaultVersion>
    ? Version extends keyof Versions
      ? Versions[Version]
      : Versions[DefaultVersion]
    : Route extends RouteDefinition<any, any>
      ? Route
      : never;

export type RequestTypeForRoute<Route, Version extends string | undefined = undefined> =
  RouteDefinitionForVersion<Route, Version> extends RouteDefinition<infer Req, any> ? Req : never;

export type ResponseTypeForRoute<Route, Version extends string | undefined = undefined> =
  RouteDefinitionForVersion<Route, Version> extends RouteDefinition<any, infer Res> ? Res : never;

// Create a configurable API client

export interface RouteDefinitionConfig<RequestType, ResponseType> {
  path: string;
  method: Method;
  requestSchema: z.ZodType<RequestType>;
  responseSchema: z.ZodType<ResponseType>;
  permissions: string[];
  rateLimit?: RateLimitConfig;
}

export class RouteDefinition<RequestType, ResponseType> {
  public path: string;
  public method: Method;
  public requestSchema: z.ZodType<RequestType>;
  public responseSchema: z.ZodType<ResponseType>;
  public permissions: string[];
  public rateLimit?: RateLimitConfig;

  constructor(config: RouteDefinitionConfig<RequestType, ResponseType>) {
    this.path = config.path;
    this.method = config.method;
    this.requestSchema = config.requestSchema;
    this.responseSchema = config.responseSchema;
    this.permissions = config.permissions;
    this.rateLimit = config.rateLimit;
  }

  parseResponse(response: unknown): ResponseType {
    try {
      return this.responseSchema.parse(response);
    } catch (error) {
      throw APIErrors.validationError(
        {
          message: "Error al validar la respuesta",
          response,
          error,
        },
        error,
      );
    }
  }

  parseBody(body: unknown): RequestType {
    try {
      if (this.method === "get" || this.method === "delete") {
        return {} as RequestType;
      }
      return this.requestSchema.parse(body);
    } catch (error) {
      throw APIErrors.validationError(
        {
          body,
          message: "Error al validar el cuerpo de la solicitud",
          error,
        },
        error,
      );
    }
  }

  async runWithFetch(
    baseUrl: string,
    body: RequestType,
    fetch: any,
    options?: RequestOptions & { authToken?: string },
  ): Promise<ResponseType> {
    const res = await fetch(`${baseUrl}${this.path}`, {
      method: this.method,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...(options?.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
      },
      body: this.method == "get" ? null : JSON.stringify(body),
    });

    let response = await res.json();

    if (!res.ok) {
      throw APIErrors.fromResponse(response);
    }

    return this.responseSchema.parse(response) as ResponseType;
  }

  async run(
    baseUrl: string,
    request: RequestType,
    options?: RequestOptions & { authToken?: string },
  ): Promise<ResponseType> {
    const response = await fetch(`${baseUrl}${this.path}`, {
      method: this.method,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...(options?.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
      },
      body: this.method !== "get" ? JSON.stringify(request) : undefined,
    });

    let responseData = await response.json();

    if (!response.ok) {
      throw APIErrors.fromResponse(responseData);
    }

    return this.responseSchema.parse(responseData) as ResponseType;
  }

  // Add this type helper
  public RequestType!: RequestType;
  public ResponseType!: ResponseType;
}
