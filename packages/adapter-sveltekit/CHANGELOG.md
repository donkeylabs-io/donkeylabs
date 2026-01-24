# @donkeylabs/adapter-sveltekit

## 2.0.7

### Patch Changes

- Internalize file watcher for auto type regeneration in vite plugin

  - Vite plugin now automatically watches server files and regenerates types on changes
  - Removed need for external scripts/dev.ts and scripts/watch-server.ts
  - Added watchTypes (default: true) and watchDir (default: "./src/server") options
  - Simplified template dev script to just "bun --bun vite dev"

## 2.0.6

### Patch Changes

- Updated dependencies
  - @donkeylabs/server@2.0.6

## 2.0.5

### Patch Changes

- Updated dependencies
  - @donkeylabs/server@2.0.5

## 2.0.4

### Patch Changes

- Updated dependencies
  - @donkeylabs/server@2.0.4

## 2.0.3

### Patch Changes

- Add autoReconnect and reconnectDelay options to SSEConnection

  - SSEConnection now accepts options to control reconnection behavior
  - `autoReconnect` (default: true) - enable/disable automatic reconnection
  - `reconnectDelay` (default: 3000ms) - delay before reconnect attempts
  - `onConnect` / `onDisconnect` callbacks for connection state tracking
  - New `reconnecting` property to check if currently waiting to reconnect
  - Properly closes EventSource and cancels reconnect on `close()`

  This allows users to disable native EventSource auto-reconnect cycling and implement custom reconnection logic.

  - @donkeylabs/server@2.0.3

## 2.0.2

### Patch Changes

- Fix production handler to support GET requests for API routes

  The production runtime handler was only handling POST requests, which broke `stream`, `html`, and SSE routes that use GET. Now matches the dev handler behavior by accepting both GET and POST for API routes.

  - @donkeylabs/server@2.0.2

## 2.0.1

### Patch Changes

- a926a1a: Fix SSE method compatibility with @donkeylabs/server generated clients

  - Add `connectToSSERoute` method to `UnifiedApiClientBase` as alias for `sseConnect`
  - Add `SSEOptions` interface for compatibility with server's SSE options
  - Add `once()` and `off()` methods to `SSEConnection` for full `SSESubscription` interface compatibility

  This fixes a bug where generated API clients using `AppServer.generateClientCode()` would fail at runtime because they called `this.connectToSSERoute()` which didn't exist on the adapter's base class.

  - @donkeylabs/server@2.0.1

## 2.0.0

### Patch Changes

- d273351: Add server-level events with typed emit/on

  - Add `defineEvents()` helper for declaring typed events at server level
  - Add `EventRegistry` interface for module augmentation
  - Update Events interface with typed overloads for emit/on/once
  - Generate events.ts with namespace-nested types (Order.Created, User.Signup)
  - Fix missing RequestOptions import in SvelteKit adapter client generator

- Updated dependencies [d273351]
  - @donkeylabs/server@2.0.0

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

### Patch Changes

- Updated dependencies [5357516]
  - @donkeylabs/server@1.0.0
