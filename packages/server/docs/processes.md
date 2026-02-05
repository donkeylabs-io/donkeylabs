# Processes Service

The Processes service manages long-running daemon processes that communicate with the server via typed events. Unlike Jobs (which have a defined end), Processes can run indefinitely - perfect for services like FFmpeg encoders, file watchers, or background workers.

## Overview

Processes provide:
- Long-running daemon management (start, stop, restart)
- Typed event communication from process to server
- Automatic heartbeat monitoring
- Watchdog termination for unresponsive processes
- Connection resilience with auto-reconnection
- Metadata passing to spawned processes
- Cross-platform support (Unix sockets / TCP on Windows)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    @donkeylabs/server                           │
│                                                                 │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐       │
│  │  Processes  │────▶│   Events    │────▶│    SSE      │───────┼──▶ Client
│  │   Service   │     │   Service   │     │   Service   │       │
│  └─────────────┘     └─────────────┘     └─────────────┘       │
│        │                                                        │
│        │ spawn + Unix socket/TCP                                │
│        ▼                                                        │
│  ┌─────────────────────────────────────────────────────┐       │
│  │              Process Socket Server                   │       │
│  │  - Listens for connections                          │       │
│  │  - Receives typed events                            │       │
│  │  - Heartbeat monitoring                             │       │
│  └─────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
          │
          │ bidirectional (Unix socket / TCP)
          ▼
    ┌───────────────┐
    │ Wrapper Script│  (TypeScript/Node)
    │ - ProcessClient│
    │ - Heartbeat    │
    │ - Typed events │
    └───────────────┘
          │
          │ spawns/controls
          ▼
    ┌───────────────┐
    │ Actual Process│  (FFmpeg, Python, etc.)
    └───────────────┘
```

## Quick Start

### 1. Define a Process

```typescript
import { z } from "zod";

// In your server setup
server.getCore().processes.define("video-encoder", {
  // Command to run (your wrapper script)
  command: "bun",
  args: ["./workers/video-encoder.ts"],

  // Working directory
  cwd: "./workers",

  // Environment variables
  env: {
    NODE_ENV: "production",
  },

  // Typed events the process can emit
  events: {
    progress: z.object({
      percent: z.number(),
      fps: z.number().optional(),
      currentFrame: z.number().optional(),
    }),
    error: z.object({
      message: z.string(),
      code: z.string().optional(),
    }),
    complete: z.object({
      outputPath: z.string(),
      duration: z.number(),
    }),
  },

  // Heartbeat configuration
  heartbeatTimeout: 30000, // 30 seconds

  // Optional hard limits (requires stats for memory/CPU)
  limits: {
    maxRuntimeMs: 60_000,
    maxMemoryMb: 512,
    maxCpuPercent: 90,
  },
});
```

### 2. Write the Wrapper Script

```typescript
// workers/video-encoder.ts
import { ProcessClient } from "@donkeylabs/server/process-client";

// Connect using environment variables (auto-configured by server)
const client = await ProcessClient.connect();

// Access metadata passed during spawn
const { inputPath, outputPath, options } = client.metadata;

console.log(`Starting encode: ${inputPath} -> ${outputPath}`);

// Spawn FFmpeg and monitor progress
const ffmpeg = Bun.spawn([
  "ffmpeg", "-i", inputPath,
  "-c:v", "libx264",
  "-preset", options.preset ?? "medium",
  outputPath
], {
  stderr: "pipe",
});

// Parse FFmpeg output for progress
const reader = ffmpeg.stderr.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const output = decoder.decode(value);

  // Parse frame/fps from FFmpeg output
  const frameMatch = output.match(/frame=\s*(\d+)/);
  const fpsMatch = output.match(/fps=\s*([\d.]+)/);

  if (frameMatch) {
    // Emit typed progress event
    await client.emit("progress", {
      percent: calculatePercent(parseInt(frameMatch[1])),
      fps: fpsMatch ? parseFloat(fpsMatch[1]) : undefined,
      currentFrame: parseInt(frameMatch[1]),
    });
  }
}

// Wait for process to complete
const exitCode = await ffmpeg.exited;

if (exitCode === 0) {
  // Emit completion event
  await client.emit("complete", {
    outputPath,
    duration: Date.now() - startTime,
  });
} else {
  // Emit error event
  await client.emit("error", {
    message: `FFmpeg exited with code ${exitCode}`,
    code: `EXIT_${exitCode}`,
  });
}

// Disconnect when done
client.disconnect();
```

### 3. Spawn the Process

```typescript
// In a route handler or service
const process = await ctx.core.processes.spawn("video-encoder", {
  // Metadata passed to the wrapper
  metadata: {
    inputPath: "/uploads/video.mp4",
    outputPath: "/outputs/video-encoded.mp4",
    options: { preset: "fast" },
  },
});

console.log(`Spawned process: ${process.id}`);
```

### 4. Listen for Events

```typescript
// Subscribe to process events
ctx.core.events.on("process.video-encoder.progress", (data) => {
  console.log(`Encoding: ${data.percent}% at ${data.fps} fps`);

  // Broadcast to SSE clients
  ctx.core.sse.broadcast(`encode:${data.processId}`, "progress", data);
});

ctx.core.events.on("process.video-encoder.complete", (data) => {
  console.log(`Encoding complete: ${data.outputPath}`);
});

ctx.core.events.on("process.video-encoder.error", (data) => {
  console.error(`Encoding error: ${data.message}`);
});
```

## ProcessClient API

The `ProcessClient` is used inside wrapper scripts to communicate with the server.

### Connecting

```typescript
import { ProcessClient } from "@donkeylabs/server/process-client";

// Auto-connect using environment variables (recommended)
const client = await ProcessClient.connect();

// Or with custom options
const client = await ProcessClient.connect({
  heartbeatInterval: 5000,      // Send heartbeat every 5s (default)
  reconnectInterval: 2000,      // Retry connection every 2s
  maxReconnectAttempts: 30,     // Max reconnection attempts
  stats: {
    enabled: true,              // Enable CPU/memory stats emission
    interval: 2000,             // Emit stats every 2s (default: 5000)
  },
});
```

---

## Hard Limits

Processes can be terminated automatically when limits are exceeded:

- `maxRuntimeMs` always enforced by the server watchdog
- `maxMemoryMb` and `maxCpuPercent` require `ProcessClient` stats enabled

```ts
const client = await ProcessClient.connect({
  stats: { enabled: true, interval: 5000 },
});
```

Watchdog events:
- `process.watchdog.stale`
- `process.watchdog.killed`

When `watchdog.enabled` is true, heartbeat monitoring runs in the watchdog subprocess.

### Properties

```typescript
// Process ID assigned by server
client.processId; // "proc_abc123"

// Metadata passed during spawn
client.metadata; // { inputPath: "...", outputPath: "..." }

// Connection status
client.connected; // true | false
```

### Methods

```typescript
// Emit a typed event to the server
await client.emit("progress", { percent: 50, fps: 30 });

// Disconnect when done
client.disconnect();
```

### Environment Variables

The server automatically sets these environment variables when spawning:

| Variable | Description |
|----------|-------------|
| `DONKEYLABS_PROCESS_ID` | Unique process identifier |
| `DONKEYLABS_SOCKET_PATH` | Unix socket path (Linux/macOS) |
| `DONKEYLABS_TCP_PORT` | TCP port (Windows) |
| `DONKEYLABS_METADATA` | JSON-encoded metadata |

### Manual Configuration

If you need manual control:

```typescript
import { createProcessClient } from "@donkeylabs/server/process-client";

const client = createProcessClient({
  processId: "custom-id",
  socketPath: "/tmp/my-socket.sock",
  // OR for Windows:
  // tcpPort: 49152,
  metadata: { custom: "data" },
});

await client.connect();
```

## Process Definition

```typescript
interface ProcessDefinition {
  /** Command to execute */
  command: string;

  /** Command arguments */
  args?: string[];

  /** Working directory */
  cwd?: string;

  /** Environment variables */
  env?: Record<string, string>;

  /** Typed events the process can emit */
  events?: Record<string, ZodSchema>;

  /** Heartbeat timeout in ms (default: 30000) */
  heartbeatTimeout?: number;

  /** Auto-restart on crash (default: false) */
  autoRestart?: boolean;

  /** Max restart attempts (default: 3) */
  maxRestarts?: number;

  /** Callbacks */
  onMessage?: (process, message) => void;
  onCrash?: (process, exitCode) => void;
  onUnhealthy?: (process) => void;
  onRestart?: (oldProcess, newProcess, attempt) => void;
  onStats?: (process, stats: ProcessStats) => void;
}
```

## Processes Service API

```typescript
interface Processes {
  /** Define a process type */
  define(name: string, config: ProcessDefinition): void;

  /** Spawn a new process instance */
  spawn(name: string, options?: SpawnOptions): Promise<ManagedProcess>;

  /** Get a running process by ID */
  get(processId: string): ManagedProcess | undefined;

  /** Get all running processes */
  getAll(): ManagedProcess[];

  /** Get processes by name */
  getByName(name: string): ManagedProcess[];

  /** Stop a process */
  stop(processId: string, signal?: NodeJS.Signals): Promise<void>;

  /** Stop all processes */
  stopAll(signal?: NodeJS.Signals): Promise<void>;
}
```

### SpawnOptions

```typescript
interface SpawnOptions {
  /** Metadata passed to the process */
  metadata?: Record<string, any>;

  /** Override environment variables */
  env?: Record<string, string>;

  /** Override working directory */
  cwd?: string;
}
```

### ManagedProcess

```typescript
interface ManagedProcess {
  /** Unique process ID */
  id: string;

  /** Process definition name */
  name: string;

  /** Current status */
  status: ProcessStatus;

  /** OS process ID */
  pid: number;

  /** Spawn timestamp */
  startedAt: Date;

  /** Last heartbeat timestamp */
  lastHeartbeat: Date;

  /** Metadata passed during spawn */
  metadata: Record<string, any>;
}

type ProcessStatus = "starting" | "running" | "stopping" | "stopped" | "crashed";
```

## Events

The server emits these events for process lifecycle:

| Event | Data | Description |
|-------|------|-------------|
| `process.spawned` | `{ processId, name }` | Process started |
| `process.connected` | `{ processId, name }` | Client connected |
| `process.{name}.{event}` | Event data | Custom process event |
| `process.heartbeat` | `{ processId, name }` | Heartbeat received |
| `process.stats` | `{ processId, name, stats }` | CPU/memory stats (if enabled) |
| `process.{name}.stats` | `{ processId, name, stats }` | Stats for specific process type |
| `process.stale` | `{ processId, name, timeSince }` | No heartbeat |
| `process.stopped` | `{ processId, name, exitCode }` | Process stopped |
| `process.crashed` | `{ processId, name, error }` | Process crashed |

### Listening Examples

```typescript
// All progress events from video-encoder processes
ctx.core.events.on("process.video-encoder.progress", (data) => {
  console.log(`Process ${data.processId}: ${data.percent}%`);
});

// Any process crash
ctx.core.events.on("process.crashed", (data) => {
  console.error(`Process ${data.name} crashed: ${data.error}`);
});
```

## SSE Integration

Broadcast process events to clients:

```typescript
// Server setup
ctx.core.events.on("process.video-encoder.progress", (data) => {
  ctx.core.sse.broadcast(`encode:${data.processId}`, "progress", {
    percent: data.percent,
    fps: data.fps,
  });
});

// Route for SSE subscription
router.route("subscribe").sse({
  channels: (input) => [`encode:${input.processId}`],
});
```

```svelte
<!-- Client -->
<script lang="ts">
  import { api } from "$lib/api";

  let progress = $state(0);

  $effect(() => {
    const unsubscribe = api.sse.subscribe(
      ["encoding.subscribe", { processId }],
      {
        onProgress: (data) => {
          progress = data.percent;
        },
      }
    );

    return unsubscribe;
  });
</script>

<progress value={progress} max="100">{progress}%</progress>
```

## Real-time Stats Monitoring

ProcessClient can emit CPU and memory stats at regular intervals for monitoring.

### Enable Stats in Wrapper

```typescript
// workers/my-worker.ts
import { ProcessClient } from "@donkeylabs/server/process-client";

const client = await ProcessClient.connect({
  stats: {
    enabled: true,     // Enable stats emission
    interval: 2000,    // Emit every 2 seconds (default: 5000)
  },
});

// Your process logic...
```

### Stats Shape

```typescript
interface ProcessStats {
  cpu: {
    user: number;      // User CPU time in microseconds
    system: number;    // System CPU time in microseconds
    percent: number;   // CPU usage percentage (0-100, can exceed on multi-core)
  };
  memory: {
    rss: number;       // Resident set size in bytes
    heapTotal: number; // V8 heap total in bytes
    heapUsed: number;  // V8 heap used in bytes
    external: number;  // External memory (C++ objects) in bytes
  };
  uptime: number;      // Process uptime in seconds
}
```

### Listen for Stats on Server

```typescript
// Option 1: Use onStats callback in process definition
processes.define("video-encoder", {
  command: "bun",
  args: ["./workers/encoder.ts"],
  onStats: (proc, stats) => {
    console.log(`[${proc.name}] CPU: ${stats.cpu.percent.toFixed(1)}%`);
    console.log(`[${proc.name}] Memory: ${(stats.memory.rss / 1e6).toFixed(1)}MB`);
  },
});

// Option 2: Listen via events
ctx.core.events.on("process.video-encoder.stats", ({ processId, stats }) => {
  // Store in time-series DB, send to monitoring dashboard, etc.
  metrics.gauge("process.cpu", stats.cpu.percent, { processId });
  metrics.gauge("process.memory", stats.memory.rss, { processId });
});

// Option 3: Listen to all process stats
ctx.core.events.on("process.stats", ({ processId, name, stats }) => {
  console.log(`${name} (${processId}): ${stats.cpu.percent}% CPU`);
});
```

### Broadcast Stats to Dashboard

```typescript
// Forward stats to SSE for real-time dashboard
ctx.core.events.on("process.stats", ({ processId, name, stats }) => {
  ctx.core.sse.broadcast("admin:processes", "stats", {
    processId,
    name,
    cpu: stats.cpu.percent,
    memory: stats.memory.rss,
    uptime: stats.uptime,
  });
});
```

## Heartbeat Monitoring

The ProcessClient automatically sends heartbeats. If heartbeats stop:

1. After `heartbeatTimeout`: Server emits `process.stale` event
2. After `2 * heartbeatTimeout`: Process considered crashed

```typescript
// Monitor stale processes
ctx.core.events.on("process.stale", async (data) => {
  console.warn(`Process ${data.processId} is stale`);

  // Optionally restart
  await ctx.core.processes.stop(data.processId);
  await ctx.core.processes.spawn(data.name, { metadata: data.metadata });
});
```

## Reconnection

If the server restarts, running processes will attempt to reconnect:

1. ProcessClient detects disconnection
2. Retries connecting every `reconnectInterval` ms
3. After `maxReconnectAttempts`, gives up and exits
4. Server recreates socket on same path for seamless reconnection

Configure reconnection in the wrapper:

```typescript
const client = await ProcessClient.connect({
  reconnectInterval: 2000,      // 2 seconds between attempts
  maxReconnectAttempts: 30,     // Try for up to 60 seconds
});
```

## Differences from External Jobs

| Feature | Processes | External Jobs |
|---------|-----------|---------------|
| Duration | Long-running / forever | Finite task |
| Completion | Optional | Required |
| Restart | Auto-restart support | Retry on failure |
| Use case | Daemons, watchers, encoders | Batch tasks, emails |

## Example: File Watcher

```typescript
// Define process
server.getCore().processes.define("file-watcher", {
  command: "bun",
  args: ["./workers/file-watcher.ts"],
  events: {
    fileChanged: z.object({
      path: z.string(),
      event: z.enum(["create", "modify", "delete"]),
    }),
  },
  autoRestart: true,
});

// Wrapper script (workers/file-watcher.ts)
import { ProcessClient } from "@donkeylabs/server/process-client";
import { watch } from "fs";

const client = await ProcessClient.connect();
const { watchPath } = client.metadata;

console.log(`Watching: ${watchPath}`);

watch(watchPath, { recursive: true }, async (event, filename) => {
  await client.emit("fileChanged", {
    path: filename,
    event: event === "rename" ? "create" : "modify",
  });
});

// Keep process running
process.on("SIGTERM", () => client.disconnect());
```

## Best Practices

1. **Always disconnect** - Call `client.disconnect()` before process exits
2. **Handle signals** - Listen for SIGTERM/SIGINT for graceful shutdown
3. **Use typed events** - Define event schemas for type safety
4. **Monitor heartbeats** - Set appropriate timeout for your use case
5. **Keep wrappers thin** - Business logic should be in the actual process
