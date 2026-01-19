import { sql, type Kysely } from "kysely";
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
import type { Workflows } from "./core/workflows";
import type { Processes } from "./core/processes";

export interface PluginRegistry {}

export interface ClientConfig {
  credentials?: "include" | "same-origin" | "omit";
}

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

export interface PluginHandlerRegistry {}

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
  workflows: Workflows;
  processes: Processes;
}

/**
 * Global context interface used in route handlers.
 * The `plugins` property is typed via PluginRegistry augmentation.
 */
export interface GlobalContext {
  /** Database instance */
  db: Kysely<any>;
  /** Plugin services - typed via PluginRegistry augmentation */
  plugins: {
    [K in keyof PluginRegistry]: PluginRegistry[K]["service"];
  };
  /** Core services (logger, cache, events, etc.) */
  core: Omit<CoreServices, "db" | "config" | "errors">;
  /** Error factories (BadRequest, NotFound, etc.) */
  errors: Errors;
  /** Application config */
  config: Record<string, any>;
  /** Client IP address */
  ip: string;
  /** Unique request ID */
  requestId: string;
  /** Authenticated user (set by auth middleware) */
  user?: any;
}

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

type UnionToIntersection<U> =
  (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;

type ExtractPluginSchema<K> = K extends keyof PluginRegistry
  ? PluginRegistry[K] extends { schema: infer S } ? S : {}
  : {};

type ExtractServices<T extends readonly (keyof PluginRegistry)[] | undefined> =
  T extends readonly []
    ? {}
    : T extends readonly (infer K)[]
      ? K extends keyof PluginRegistry
        ? { [P in K]: PluginRegistry[P] extends { service: infer S } ? S : unknown }
        : {}
      : {};

type ExtractSchemas<T extends readonly (keyof PluginRegistry)[] | undefined> =
  T extends readonly []
    ? {}
    : T extends readonly (infer K)[]
      ? UnionToIntersection<ExtractPluginSchema<K>>
      : {};

type SelfDependencyError<Name extends string> =
  `Error: Plugin '${Name}' cannot depend on itself`;

type PluginDependsOn<
  PluginName extends keyof PluginRegistry,
  Target extends string
> = PluginRegistry[PluginName] extends { _dependencies: readonly (infer D)[] }
  ? Target extends D
    ? true
    : false
  : false;

type FindCircularDep<
  Name extends string,
  Deps extends readonly (keyof PluginRegistry)[]
> = {
  [K in Deps[number]]: PluginDependsOn<K, Name> extends true ? K : never
}[Deps[number]];

type CircularDependencyError<Name extends string, CircularDep extends string> =
  `Error: Circular dependency - '${CircularDep}' already depends on '${Name}'`;

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

export type PluginFactory<Config, P extends Plugin = Plugin> = ((config: Config) => P) & {
  _configType: Config;
};

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
      /** Middleware function - receives typed context and service, returns middleware definitions */
      middleware?: (
        ctx: PluginContext<ExtractServices<Deps>, LocalSchema & ExtractSchemas<Deps>, void>,
        service: Service
      ) => Middleware;
      events?: Events;
      client?: ClientConfig;
      customErrors?: CustomErrors;
      service: (
        ctx: PluginContext<ExtractServices<Deps>, LocalSchema & ExtractSchemas<Deps>, void>
      ) => Promise<Service> | Service;
      /** Called after service is created - use for registering crons, events, etc. */
      init?: (
        ctx: PluginContext<ExtractServices<Deps>, LocalSchema & ExtractSchemas<Deps>, void>,
        service: Service
      ) => void | Promise<void>;
    }
  ): Plugin & {
    name: Name;
    _dependencies: Deps;
    _schema: LocalSchema;
    _fullSchema: LocalSchema & ExtractSchemas<Deps>;
    /** Typed service function - preserves Service type for InferService */
    service: (ctx: PluginContext<ExtractServices<Deps>, LocalSchema & ExtractSchemas<Deps>, void>) => Promise<Service> | Service;
    /** Typed service return for direct access */
    _service: Service;
    handlers?: Handlers;
    middleware?: (ctx: PluginContext<ExtractServices<Deps>, LocalSchema & ExtractSchemas<Deps>, void>, service: Service) => Middleware;
    events?: Events;
    client?: ClientConfig;
    customErrors?: CustomErrors;
  } {
    return config as any;
  }
}

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
      /** Middleware function - receives typed context and service, returns middleware definitions */
      middleware?: (
        ctx: PluginContext<ExtractServices<Deps>, LocalSchema & ExtractSchemas<Deps>, Config>,
        service: Service
      ) => Middleware;
      events?: Events;
      client?: ClientConfig;
      customErrors?: CustomErrors;
      service: (
        ctx: PluginContext<ExtractServices<Deps>, LocalSchema & ExtractSchemas<Deps>, Config>
      ) => Promise<Service> | Service;
      /** Called after service is created - use for registering crons, events, etc. */
      init?: (
        ctx: PluginContext<ExtractServices<Deps>, LocalSchema & ExtractSchemas<Deps>, Config>,
        service: Service
      ) => void | Promise<void>;
    }
  ): PluginFactory<Config, Plugin & {
    name: Name;
    _dependencies: Deps;
    _schema: LocalSchema;
    _fullSchema: LocalSchema & ExtractSchemas<Deps>;
    _config: Config;
    /** Typed service function - preserves Service type for InferService */
    service: (ctx: PluginContext<ExtractServices<Deps>, LocalSchema & ExtractSchemas<Deps>, Config>) => Promise<Service> | Service;
    /** Typed service return for direct access */
    _service: Service;
    handlers?: Handlers;
    middleware?: (ctx: PluginContext<ExtractServices<Deps>, LocalSchema & ExtractSchemas<Deps>, Config>, service: Service) => Middleware;
    events?: Events;
    client?: ClientConfig;
    customErrors?: CustomErrors;
  }> {
    const factory = (config: Config) => ({
      ...pluginDef,
      _boundConfig: config,
    });
    return factory as any;
  }
}

export const createPlugin: PluginBuilder<{}> = new PluginBuilder();

type UnwrapPluginFactory<T> = T extends (config: any) => infer P ? P : T;

export type InferService<T> = UnwrapPluginFactory<T> extends { _service: infer S }
  ? S
  : never;
export type InferSchema<T> = UnwrapPluginFactory<T> extends { _schema: infer S } ? S : never;
export type InferHandlers<T> = UnwrapPluginFactory<T> extends { handlers?: infer H } ? H : {};
export type InferMiddleware<T> = UnwrapPluginFactory<T> extends { middleware?: (ctx: any) => infer M } ? M : {};
export type InferDependencies<T> = UnwrapPluginFactory<T> extends { _dependencies: infer D } ? D : readonly [];
export type InferConfig<T> = T extends (config: infer C) => any ? C : void;
export type InferEvents<T> = UnwrapPluginFactory<T> extends { events?: infer E } ? E : {};
export type InferClientConfig<T> = UnwrapPluginFactory<T> extends { client?: infer C } ? C : undefined;
export type InferCustomErrors<T> = UnwrapPluginFactory<T> extends { customErrors?: infer E } ? E : {};

export type { ExtractServices, ExtractSchemas };

export type Plugin = {
    name: string;
    version?: string;
    dependencies?: readonly string[];
    handlers?: Record<string, any>;
    /** Middleware function - receives PluginContext and service, returns middleware definitions */
    middleware?: (ctx: any, service: any) => Record<string, any>;
    events?: Record<string, any>;
    client?: ClientConfig;
    customErrors?: CustomErrorRegistry;
    service: (ctx: any) => any;
    /** Called after service is created - use for registering crons, events, etc. */
    init?: (ctx: any, service: any) => void | Promise<void>;
};

export type PluginWithConfig<Config = void> = Plugin & {
    _config?: Config;
};

export type ConfiguredPlugin = Plugin & { _boundConfig?: any };

export class PluginManager {
  private plugins: Map<string, ConfiguredPlugin> = new Map();
  private services: Record<string, any> = {};
  private core: CoreServices;

  constructor(core: CoreServices) {
    this.core = core;
  }

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

  /**
   * Ensures the migrations tracking table exists.
   * This table tracks which migrations have been applied for each plugin.
   */
  private async ensureMigrationsTable(): Promise<void> {
    await this.core.db.schema
      .createTable("__donkeylabs_migrations__")
      .ifNotExists()
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("plugin_name", "text", (col) => col.notNull())
      .addColumn("migration_name", "text", (col) => col.notNull())
      .addColumn("executed_at", "text", (col) => col.defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();

    // Create unique index for plugin_name + migration_name (if not exists)
    // Using raw SQL since Kysely doesn't have ifNotExists for indexes
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_migrations_unique
              ON __donkeylabs_migrations__(plugin_name, migration_name)`.execute(this.core.db);
  }

  /**
   * Checks if a migration has already been applied for a specific plugin.
   */
  private async isMigrationApplied(pluginName: string, migrationName: string): Promise<boolean> {
    const result = await sql<{ count: number }>`
      SELECT COUNT(*) as count FROM __donkeylabs_migrations__
      WHERE plugin_name = ${pluginName} AND migration_name = ${migrationName}
    `.execute(this.core.db);
    return (result.rows[0]?.count ?? 0) > 0;
  }

  /**
   * Records that a migration has been applied for a specific plugin.
   */
  private async recordMigration(pluginName: string, migrationName: string): Promise<void> {
    await sql`
      INSERT INTO __donkeylabs_migrations__ (plugin_name, migration_name)
      VALUES (${pluginName}, ${migrationName})
    `.execute(this.core.db);
  }

  async migrate(): Promise<void> {
    console.log("Running migrations (File-System Based)...");

    // Ensure the migrations tracking table exists
    await this.ensureMigrationsTable();

    const sortedPlugins = this.resolveOrder();

    for (const plugin of sortedPlugins) {
        const pluginName = plugin.name;
        const possibleMigrationDirs = [
          // SvelteKit adapter location
          join(process.cwd(), "src/server/plugins", pluginName, "migrations"),
          // Standard locations
          join(process.cwd(), "src/plugins", pluginName, "migrations"),
          join(process.cwd(), "plugins", pluginName, "migrations"),
          // Legacy/example location
          join(process.cwd(), "examples/basic-server/src/plugins", pluginName, "migrations"),
        ];

        let migrationDir = "";
        for (const dir of possibleMigrationDirs) {
          try {
            await readdir(dir);
            migrationDir = dir;
            break;
          } catch {
            continue;
          }
        }

        if (!migrationDir) continue;

        try {
             const files = await readdir(migrationDir);
             const migrationFiles = files.filter(f => f.endsWith(".ts"));

             if (migrationFiles.length > 0) {
                 console.log(`[Migration] checking plugin: ${pluginName} at ${migrationDir}`);

                 for (const file of migrationFiles.sort()) {
                     // Check if this migration has already been applied
                     const isApplied = await this.isMigrationApplied(pluginName, file);
                     if (isApplied) {
                         console.log(`  - Skipping (already applied): ${file}`);
                         continue;
                     }

                     console.log(`  - Executing migration: ${file}`);
                     const migrationPath = join(migrationDir, file);

                     let migration;
                     try {
                         migration = await import(migrationPath);
                     } catch (importError) {
                         const err = importError instanceof Error ? importError : new Error(String(importError));
                         throw new Error(`Failed to import migration ${file}: ${err.message}`);
                     }

                     if (migration.up) {
                         try {
                              await migration.up(this.core.db);
                              // Record successful migration
                              await this.recordMigration(pluginName, file);
                              console.log(`    Success`);
                         } catch (e) {
                             console.error(`    Failed to run ${file}:`, e);
                             throw e; // Stop on migration failure - don't continue with inconsistent state
                         }
                     }
                 }
             }
        } catch (e) {
            // Re-throw migration execution errors (they've already been logged)
            // Only silently catch directory read errors (ENOENT)
            const isDirectoryError = e instanceof Error &&
              ((e as NodeJS.ErrnoException).code === 'ENOENT' ||
               (e as NodeJS.ErrnoException).code === 'ENOTDIR');
            if (!isDirectoryError) {
                throw e;
            }
        }
    }
  }

  async init(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      const deps = plugin.dependencies || [];
      for (const dep of deps) {
        if (!this.plugins.has(dep)) {
          throw new Error(`Plugin '${plugin.name}' depends on '${dep}', but it is not registered.`);
        }
      }
    }

    const sortedPlugins = this.resolveOrder();

    for (const plugin of sortedPlugins) {
        console.log(`Initializing plugin: ${plugin.name}`);

        if (plugin.customErrors) {
            for (const [errorName, errorDef] of Object.entries(plugin.customErrors)) {
                this.core.errors.register(errorName, errorDef);
                console.log(`[${plugin.name}] Registered custom error: ${errorName}`);
            }
        }

        const pluginDeps: Record<string, unknown> = {};
        if (plugin.dependencies) {
            for (const depName of plugin.dependencies) {
                pluginDeps[depName] = this.services[depName];
            }
        }

        const pluginConfig = (plugin as ConfiguredPlugin)._boundConfig;
        const ctx = new PluginContext(this.core, pluginDeps, pluginConfig);
        const service = await plugin.service(ctx);

        if (service) {
            this.services[plugin.name] = service;
            console.log(`[${plugin.name}] Service registered.`);
        }

        // Resolve middleware function if present (pass service so middleware can use it)
        if (plugin.middleware && typeof plugin.middleware === "function") {
            const resolvedMiddleware = plugin.middleware(ctx, service);
            // Store resolved middleware back on plugin for server to access
            (plugin as any)._resolvedMiddleware = resolvedMiddleware;
        }

        // Call init hook for registering crons, events, etc.
        if (plugin.init) {
            await plugin.init(ctx, service);
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
