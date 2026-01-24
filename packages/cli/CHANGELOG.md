# @donkeylabs/cli

## 2.0.3

### Patch Changes

- @donkeylabs/server@2.0.3

## 2.0.2

### Patch Changes

- @donkeylabs/server@2.0.2

## 2.0.1

### Patch Changes

- @donkeylabs/server@2.0.1

## 2.0.0

### Minor Changes

- d273351: Add server-level events with typed emit/on

  - Add `defineEvents()` helper for declaring typed events at server level
  - Add `EventRegistry` interface for module augmentation
  - Update Events interface with typed overloads for emit/on/once
  - Generate events.ts with namespace-nested types (Order.Created, User.Signup)
  - Fix missing RequestOptions import in SvelteKit adapter client generator

### Patch Changes

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
