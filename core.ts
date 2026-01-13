import type { Kysely } from "kysely";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import type { Logger } from "./core/logger";
import type { Cache } from "./core/cache";
import type { Events } from "./core/events";
import type { Cron } from "./core/cron";
import type { Jobs } from "./core/jobs";
import type { SSE } from "./core/sse";
import type { RateLimiter } from "./core/rate-limiter";
import type { Errors, CustomErrorRegistry } from "./core/errors";

// ==========================================
// 1. Global Registry & Type Definitions
// ==========================================

export interface PluginRegistry {}

// Client-side configuration for plugins
export interface ClientConfig {
  credentials?: "include" | "same-origin" | "omit";
}

// SSE Event definition (name -> Zod schema)
export type EventSchemas = Record<string, z.ZodType<any>>;

export type Register<
  Service = void,
  Schema = {},
  Handlers = {},
  Dependencies extends readonly string[] = readonly [],
  Middleware = {},
  Config = void,
  Events extends EventSchemas = {}
> = {
  service: Service;
  schema: Schema;
  handlers: Handlers;
  _dependencies: Dependencies;
  middleware: Middleware;
  config: Config;
  events: Events;
};

// Interface for plugins to inject handlers into.
// router.ts will extend this.
export interface PluginHandlerRegistry {}

// Interface for plugins to inject middleware into.
// router.ts will extend this.
export interface PluginMiddlewareRegistry {}

export interface CoreServices {
  db: Kysely<any>;
  config: Record<string, any>;
  logger: Logger;
  cache: Cache;
  events: Events;
  cron: Cron;
  jobs: Jobs;
  sse: SSE;
  rateLimiter: RateLimiter;
  errors: Errors;
}

// ==========================================
// 2. Plugin Context
// ==========================================

export class PluginContext<Deps = any, Schema = any, Config = void> {
  constructor(
    public readonly core: CoreServices,
    public readonly deps: Deps,
    public readonly config: Config
  ) {}

  get db(): Kysely<Schema> {
    return this.core.db as unknown as Kysely<Schema>;
  }
}

// ==========================================
// 3. Functional Plugin Definition (Builder Pattern)
// ==========================================

// Helper: Convert union to intersection
type UnionToIntersection<U> =
  (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;

// Extract a single plugin's schema
type ExtractPluginSchema<K> = K extends keyof PluginRegistry
  ? PluginRegistry[K] extends { schema: infer S } ? S : {}
  : {};

// Extract services from dependencies
type ExtractServices<T extends readonly (keyof PluginRegistry)[] | undefined> =
  T extends readonly []
    ? {}
    : T extends readonly (infer K)[]
      ? K extends keyof PluginRegistry
        ? { [P in K]: PluginRegistry[P] extends { service: infer S } ? S : unknown }
        : {}
      : {};

// Extract and merge schemas from dependencies (intersection, not union)
type ExtractSchemas<T extends readonly (keyof PluginRegistry)[] | undefined> =
  T extends readonly []
    ? {}
    : T extends readonly (infer K)[]
      ? UnionToIntersection<ExtractPluginSchema<K>>
      : {};

// ==========================================
// Dependency Validation Types
// ==========================================

// Error type for self-dependency
type SelfDependencyError<Name extends string> =
  `Error: Plugin '${Name}' cannot depend on itself`;

// Check if a plugin depends on another plugin
type PluginDependsOn<
  PluginName extends keyof PluginRegistry,
  Target extends string
> = PluginRegistry[PluginName] extends { _dependencies: readonly (infer D)[] }
  ? Target extends D
    ? true
    : false
  : false;

// Find which dependency creates a circular reference
type FindCircularDep<
  Name extends string,
  Deps extends readonly (keyof PluginRegistry)[]
> = {
  [K in Deps[number]]: PluginDependsOn<K, Name> extends true ? K : never
}[Deps[number]];

// Error type for circular dependency
type CircularDependencyError<Name extends string, CircularDep extends string> =
  `Error: Circular dependency - '${CircularDep}' already depends on '${Name}'`;

// Validate dependencies don't include self or create circular refs
type ValidateDeps<
  Name extends string,
  Deps extends readonly (keyof PluginRegistry)[]
> = Name extends Deps[number]
  ? SelfDependencyError<Name>
  : FindCircularDep<Name, Deps> extends never
    ? Deps
    : CircularDependencyError<Name, FindCircularDep<Name, Deps> & string>;

export interface PluginConfig<
  Name extends keyof PluginRegistry,
  Deps extends readonly (keyof PluginRegistry)[] | undefined,
  LocalSchema,
  Service,
  Handlers = {},
  Middleware = {},
  Config = void,
  FullSchema = LocalSchema & ExtractSchemas<Deps>
> {
  name: Name;
  version?: string;
  dependencies?: Deps;
  service: (ctx: PluginContext<ExtractServices<Deps>, FullSchema, Config>) => Promise<Service> | Service;
  handlers?: Handlers;
  middleware?: Middleware;
}

// Plugin factory type - a function that takes config and returns a configured plugin
export type PluginFactory<Config, P extends Plugin = Plugin> = ((config: Config) => P) & {
  _configType: Config;
};

// Builder for plugins WITHOUT config - returns plugin directly
export class PluginBuilder<LocalSchema = {}> {
  withSchema<S>(): PluginBuilder<S> {
    return new PluginBuilder<S>();
  }

  withConfig<C>(): ConfiguredPluginBuilder<LocalSchema, C> {
    return new ConfiguredPluginBuilder<LocalSchema, C>();
  }

  define<
    Name extends string,
    const Deps extends readonly (keyof PluginRegistry)[] = readonly [],
    const Handlers extends object = {},
    const Middleware extends object = {},
    const Events extends EventSchemas = {},
    const CustomErrors extends CustomErrorRegistry = {},
    Service = void
  >(
    config: {
      name: Name;
      version?: string;
      dependencies?: ValidateDeps<Name, Deps> extends Deps ? Deps : ValidateDeps<Name, Deps>;
      handlers?: Handlers;
      middleware?: Middleware;
      events?: Events;
      client?: ClientConfig;
      /** Custom HTTP errors this plugin provides (e.g., PaymentRequired, UserSuspended) */
      customErrors?: CustomErrors;
      service: (
        ctx: PluginContext<ExtractServices<Deps>, LocalSchema & ExtractSchemas<Deps>, void>
      ) => Promise<Service> | Service;
    }
  ): Plugin & {
    name: Name;
    _dependencies: Deps;
    _schema: LocalSchema;
    _fullSchema: LocalSchema & ExtractSchemas<Deps>;
    handlers?: Handlers;
    middleware?: Middleware;
    events?: Events;
    client?: ClientConfig;
    customErrors?: CustomErrors;
  } {
    return config as any;
  }
}

// Builder for plugins WITH config - returns factory function
export class ConfiguredPluginBuilder<LocalSchema, Config> {
  withSchema<S>(): ConfiguredPluginBuilder<S, Config> {
    return new ConfiguredPluginBuilder<S, Config>();
  }

  define<
    Name extends string,
    const Deps extends readonly (keyof PluginRegistry)[] = readonly [],
    const Handlers extends object = {},
    const Middleware extends object = {},
    const Events extends EventSchemas = {},
    const CustomErrors extends CustomErrorRegistry = {},
    Service = void
  >(
    pluginDef: {
      name: Name;
      version?: string;
      dependencies?: ValidateDeps<Name, Deps> extends Deps ? Deps : ValidateDeps<Name, Deps>;
      handlers?: Handlers;
      middleware?: Middleware;
      events?: Events;
      client?: ClientConfig;
      /** Custom HTTP errors this plugin provides (e.g., PaymentRequired, UserSuspended) */
      customErrors?: CustomErrors;
      service: (
        ctx: PluginContext<ExtractServices<Deps>, LocalSchema & ExtractSchemas<Deps>, Config>
      ) => Promise<Service> | Service;
    }
  ): PluginFactory<Config, Plugin & {
    name: Name;
    _dependencies: Deps;
    _schema: LocalSchema;
    _fullSchema: LocalSchema & ExtractSchemas<Deps>;
    _config: Config;
    handlers?: Handlers;
    middleware?: Middleware;
    events?: Events;
    client?: ClientConfig;
    customErrors?: CustomErrors;
  }> {
    // Return a factory function that binds config to the plugin
    const factory = (config: Config) => ({
      ...pluginDef,
      _boundConfig: config,
    });
    return factory as any;
  }
}

export const createPlugin: PluginBuilder<{}> = new PluginBuilder();

// Helper to unwrap plugin factory to get the plugin type
type UnwrapPluginFactory<T> = T extends (config: any) => infer P ? P : T;

// Type inference helpers - work with both direct plugins and factory functions
export type InferService<T> = UnwrapPluginFactory<T> extends { service: (ctx: any) => Promise<infer S> | infer S }
  ? S
  : UnwrapPluginFactory<T> extends { service: (...args: any[]) => infer S }
  ? Awaited<S>
  : never;
export type InferSchema<T> = UnwrapPluginFactory<T> extends { _schema: infer S } ? S : never;
export type InferHandlers<T> = UnwrapPluginFactory<T> extends { handlers?: infer H } ? H : {};
export type InferMiddleware<T> = UnwrapPluginFactory<T> extends { middleware?: infer M } ? M : {};
export type InferDependencies<T> = UnwrapPluginFactory<T> extends { _dependencies: infer D } ? D : readonly [];
export type InferConfig<T> = T extends (config: infer C) => any ? C : void;
export type InferEvents<T> = UnwrapPluginFactory<T> extends { events?: infer E } ? E : {};
export type InferClientConfig<T> = UnwrapPluginFactory<T> extends { client?: infer C } ? C : undefined;
export type InferCustomErrors<T> = UnwrapPluginFactory<T> extends { customErrors?: infer E } ? E : {};

// Export helper types for debugging/testing
export type { ExtractServices, ExtractSchemas };

// Valid runtime plugin structure (erased types)
export type Plugin = {
    name: string;
    version?: string;
    dependencies?: readonly string[];
    handlers?: Record<string, any>;
    middleware?: Record<string, any>;
    events?: Record<string, any>;
    client?: ClientConfig;
    customErrors?: CustomErrorRegistry;
    service: (ctx: any) => any;
};

// Plugin with config type information preserved
export type PluginWithConfig<Config = void> = Plugin & {
    _config?: Config;
};

// ==========================================
// 4. Plugin Manager
// ==========================================

// Plugin with bound config (returned by factory function)
export type ConfiguredPlugin = Plugin & { _boundConfig?: any };

export class PluginManager {
  private plugins: Map<string, ConfiguredPlugin> = new Map();
  private services: Record<string, any> = {};
  private core: CoreServices;

  constructor(core: CoreServices) {
    this.core = core;
  }

  // Public accessor for services (used by ServerContext)
  getServices(): any {
      return this.services;
  }

  getCore(): CoreServices {
      return this.core;
  }

  getPlugins(): Plugin[] {
      return Array.from(this.plugins.values());
  }

  register(plugin: ConfiguredPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin ${plugin.name} is already registered.`);
    }
    this.plugins.set(plugin.name, plugin);
  }

  async migrate() {
    console.log("Running migrations (File-System Based)...");
    const sortedPlugins = this.resolveOrder();

    for (const plugin of sortedPlugins) {
        const pluginName = plugin.name;
        const migrationDir = join(process.cwd(), "plugins", pluginName, "migrations");

        try {
             const files = await readdir(migrationDir);
             const migrationFiles = files.filter(f => f.endsWith(".ts"));

             if (migrationFiles.length > 0) {
                 console.log(`[Migration] checking plugin: ${pluginName} at ${migrationDir}`);

                 for (const file of migrationFiles.sort()) {
                     console.log(`  - Executing migration: ${file}`);
                     const migrationPath = join(migrationDir, file);
                     const migration = await import(migrationPath);

                     if (migration.up) {
                         try {
                              await migration.up(this.core.db);
                              console.log(`    ✅ Success`);
                         } catch (e) {
                             console.error(`    ❌ Failed to run ${file}:`, e);
                         }
                     }
                 }
             }
        } catch (e) {
            // Ignore missing dir
        }
    }
  }

  async init() {
    // 1. Validate dependencies exist
    for (const port of this.plugins.values()) {
      const deps = port.dependencies || [];
      for (const dep of deps) {
        if (!this.plugins.has(dep)) {
          throw new Error(`Plugin '${port.name}' depends on '${dep}', but it is not registered.`);
        }
      }
    }

    // 2. Sort plugins
    const sortedPlugins = this.resolveOrder();

    // 3. Init each
    for (const plugin of sortedPlugins) {
        console.log(`Initializing plugin: ${plugin.name}`);

        // Register custom errors from this plugin
        if (plugin.customErrors) {
            for (const [errorName, errorDef] of Object.entries(plugin.customErrors)) {
                this.core.errors.register(errorName, errorDef);
                console.log(`[${plugin.name}] Registered custom error: ${errorName}`);
            }
        }

        // Build the dependency object dynamically
        const pluginDeps: any = {};
        if (plugin.dependencies) {
            for (const depName of plugin.dependencies) {
                pluginDeps[depName] = this.services[depName];
            }
        }

        // Get config from bound plugin (if using factory pattern)
        const pluginConfig = (plugin as ConfiguredPlugin)._boundConfig;

        const ctx = new PluginContext(this.core, pluginDeps, pluginConfig);
        const service = await plugin.service(ctx);

        // Register the returned service
        if (service) {
            this.services[plugin.name] = service;
            console.log(`[${plugin.name}] Service registered.`);
        }
    }

    console.log("All plugins initialized.");
  }

  private resolveOrder(): Plugin[] {
    const visited = new Set<string>();
    const sorted: Plugin[] = [];
    const visiting = new Set<string>();

    const visit = (plugin: Plugin) => {
        const name = plugin.name;
        if (visited.has(name)) return;
        if (visiting.has(name)) throw new Error(`Circular dependency detected: ${name}`);

        visiting.add(name);

        const deps = plugin.dependencies || [];
        for (const depName of deps) {
            const depPlugin = this.plugins.get(depName);
            if (depPlugin) visit(depPlugin);
        }

        visiting.delete(name);
        visited.add(name);
        sorted.push(plugin);
    };

    for (const plugin of this.plugins.values()) {
        visit(plugin);
    }

    return sorted;
  }
}
