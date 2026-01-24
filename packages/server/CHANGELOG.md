# @donkeylabs/server

## 2.0.6

### Patch Changes

- Add tagged loggers with colored prefixes and auto-tagging for plugins

  - Logger now supports `tag(name: string)` method to create tagged child loggers
  - Tags appear as colored `[tagName]` prefixes in pretty format
  - Each tag gets a consistent color (cycles through cyan, magenta, green, yellow, blue, red)
  - Plugins automatically get a logger tagged with the plugin name
  - Tags are included as an array in JSON format

## 2.0.5

### Patch Changes

- Send immediate heartbeat on SSE client connect

  Previously, new SSE clients had to wait up to 30 seconds for the first heartbeat. This could cause connections to timeout on proxies with aggressive timeout settings. Now sends an immediate heartbeat when a client connects.

## 2.0.4

### Patch Changes

- Fix SSE client cleanup on connection abort

  The SSE handler now registers a cleanup listener on `req.signal.abort` to properly remove the SSE client when the connection is closed. This prevents orphaned SSE clients from accumulating and ensures proper resource cleanup.

## 2.0.3

## 2.0.2

## 2.0.1

## 2.0.0

### Minor Changes

- d273351: Add server-level events with typed emit/on

  - Add `defineEvents()` helper for declaring typed events at server level
  - Add `EventRegistry` interface for module augmentation
  - Update Events interface with typed overloads for emit/on/once
  - Generate events.ts with namespace-nested types (Order.Created, User.Signup)
  - Fix missing RequestOptions import in SvelteKit adapter client generator

## 1.0.0

### Minor Changes

- 5357516: Add audit and websocket core services, refactor to use shared database

  - Add new audit service for compliance and tracking with KyselyAuditAdapter and MemoryAuditAdapter
  - Add new websocket service for bidirectional real-time communication
  - Refactor jobs, processes, and workflows to use Kysely adapters with shared app database
  - Add workflow persistence (previously in-memory only)
  - Core migrations now tracked with @core/ prefix and run before plugin migrations
  - Add comprehensive tests for new services and Kysely adapters
  - Update SvelteKit template demo with audit and websocket examples
  - Add type checking to CI workflow
