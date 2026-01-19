# @donkeylabs/server

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
