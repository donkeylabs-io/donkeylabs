// Core Services - Re-export all services

export {
  type Logger,
  type LogLevel,
  type LogEntry,
  type LogTransport,
  type LoggerConfig,
  ConsoleTransport,
  createLogger,
} from "./logger";

export {
  type Cache,
  type CacheAdapter,
  type CacheConfig,
  MemoryCacheAdapter,
  createCache,
} from "./cache";

export {
  type Events,
  type EventHandler,
  type EventMetadata,
  type Subscription,
  type EventRecord,
  type EventAdapter,
  type EventsConfig,
  MemoryEventAdapter,
  createEvents,
} from "./events";

export {
  type Cron,
  type CronTask,
  type CronRunContext,
  type CronConfig,
  createCron,
} from "./cron";

export {
  type Jobs,
  type Job,
  type JobStatus,
  type JobHandler,
  type JobHandlerContext,
  type JobAdapter,
  type JobsConfig,
  type GetAllJobsOptions,
  MemoryJobAdapter,
  createJobs,
} from "./jobs";

export {
  SqliteJobAdapter,
  type SqliteJobAdapterConfig,
} from "./job-adapter-sqlite";

export {
  KyselyJobAdapter,
  type KyselyJobAdapterConfig,
} from "./job-adapter-kysely";

export {
  type ExternalJobConfig,
  type ExternalJob,
  type ExternalJobProcessState,
  type ExternalJobsConfig,
  type ExternalJobManager,
  type ExternalJobMessage,
  type ExternalJobMessageType,
  type AnyExternalJobMessage,
  type StartedMessage,
  type ProgressMessage,
  type HeartbeatMessage,
  type LogMessage,
  type CompletedMessage,
  type FailedMessage,
  isExternalJob,
  isProgressMessage,
  isHeartbeatMessage,
  isLogMessage,
  isCompletedMessage,
  isFailedMessage,
  isStartedMessage,
  isProcessAlive,
} from "./external-jobs";

export {
  type SSE,
  type SSEClient,
  type SSEConfig,
  createSSE,
} from "./sse";

export {
  type RateLimiter,
  type RateLimitResult,
  type RateLimitAdapter,
  type RateLimiterConfig,
  MemoryRateLimitAdapter,
  createRateLimiter,
  extractClientIP,
  parseDuration,
  createRateLimitKey,
} from "./rate-limiter";

export {
  type Errors,
  type ErrorsConfig,
  type ErrorFactory,
  type BaseErrorFactories,
  type ErrorFactories,
  type CustomErrorDefinition,
  type CustomErrorRegistry,
  HttpError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  MethodNotAllowedError,
  ConflictError,
  GoneError,
  UnprocessableEntityError,
  TooManyRequestsError,
  InternalServerError,
  NotImplementedError,
  BadGatewayError,
  ServiceUnavailableError,
  GatewayTimeoutError,
  createErrors,
  createValidationError,
} from "./errors";

export {
  type Workflows,
  type WorkflowsConfig,
  type SqlitePragmaConfig,
  type WorkflowDatabaseConfig,
  type WorkflowRegisterOptions,
  type WorkflowDefinition,
  type WorkflowInstance,
  type WorkflowStatus,
  type WorkflowContext,
  type WorkflowAdapter,
  type StepDefinition,
  type StepType,
  type StepStatus,
  type StepResult,
  type TaskStepDefinition,
  type ParallelStepDefinition,
  type ChoiceStepDefinition,
  type ChoiceCondition,
  type PassStepDefinition,
  type PollStepDefinition,
  type PollStepResult,
  type LoopStepDefinition,
  type RetryConfig,
  type GetAllWorkflowsOptions,
  type PluginMetadata,
  WorkflowBuilder,
  MemoryWorkflowAdapter,
  workflow,
  createWorkflows,
} from "./workflows";

export {
  type WorkflowSocketServer,
  type WorkflowSocketServerOptions,
  type WorkflowSocketConfig,
  type WorkflowEvent,
  type WorkflowEventType,
  type ProxyRequest,
  type ProxyResponse,
  type WorkflowMessage,
  createWorkflowSocketServer,
  isWorkflowEvent,
  isProxyRequest,
  parseWorkflowMessage,
} from "./workflow-socket";

export {
  type ProxyConnection,
  WorkflowProxyConnection,
  createPluginProxy,
  createCoreProxy,
  createPluginsProxy,
  createCoreServicesProxy,
} from "./workflow-proxy";

export {
  type Processes,
  type ProcessesConfig,
  type ProcessStatus,
  type ProcessConfig,
  type ProcessDefinition,
  type ManagedProcess,
  type SpawnOptions,
  createProcesses,
} from "./processes";

export {
  SqliteProcessAdapter,
  type SqliteProcessAdapterConfig,
  type ProcessAdapter,
} from "./process-adapter-sqlite";

// Process Client - for use in wrapper scripts
export {
  ProcessClient,
  type ProcessClient as ProcessClientType,
  type ProcessClientConfig,
  connect as connectProcess,
  createProcessClient,
} from "./process-client";

export {
  KyselyProcessAdapter,
  type KyselyProcessAdapterConfig,
} from "./process-adapter-kysely";

export {
  type ProcessSocketServer,
  type ProcessMessage,
  type ProcessSocketConfig,
  createProcessSocketServer,
} from "./process-socket";

export {
  WorkflowStateMachine,
  type StateMachineEvents,
  type StateMachineConfig,
} from "./workflow-state-machine";

export {
  KyselyWorkflowAdapter,
  type KyselyWorkflowAdapterConfig,
} from "./workflow-adapter-kysely";

export {
  type Audit,
  type AuditEntry,
  type AuditQueryFilters,
  type AuditAdapter,
  type AuditConfig,
  type KyselyAuditAdapterConfig,
  KyselyAuditAdapter,
  MemoryAuditAdapter,
  createAudit,
} from "./audit";

export {
  type WebSocketService,
  type WebSocketClient,
  type WebSocketData,
  type WebSocketMessage,
  type WebSocketMessageHandler,
  type WebSocketConfig,
  createWebSocket,
} from "./websocket";

export {
  type Storage,
  type StorageAdapter,
  type StorageConfig,
  type StorageFile,
  type UploadOptions,
  type UploadResult,
  type DownloadResult,
  type ListOptions,
  type ListResult,
  type GetUrlOptions,
  type CopyOptions,
  type StorageVisibility,
  type S3ProviderConfig,
  type LocalProviderConfig,
  type MemoryProviderConfig,
  MemoryStorageAdapter,
  createStorage,
} from "./storage";

export { LocalStorageAdapter } from "./storage-adapter-local";
export { S3StorageAdapter } from "./storage-adapter-s3";

export {
  RedisCacheAdapter,
  type RedisCacheAdapterConfig,
} from "./cache-adapter-redis";

export {
  RedisRateLimitAdapter,
  type RedisRateLimitAdapterConfig,
} from "./rate-limit-adapter-redis";

export {
  type Logs,
  type LogSource,
  type PersistentLogEntry,
  type LogsQueryFilters,
  type LogsRetentionConfig,
  type LogsConfig,
  type LogsAdapter,
  MemoryLogsAdapter,
  createLogs,
} from "./logs";

export {
  KyselyLogsAdapter,
  type KyselyLogsAdapterConfig,
} from "./logs-adapter-kysely";

export {
  PersistentTransport,
  type PersistentTransportConfig,
} from "./logs-transport";

export {
  type Health,
  type HealthCheck,
  type HealthCheckResult,
  type HealthConfig,
  type HealthResponse,
  type HealthStatus,
  createHealth,
  createDbHealthCheck,
} from "./health";
