# External Jobs

External jobs extend the built-in Jobs service to support processes written in any language (Python, Go, Rust, shell scripts, etc.) with bidirectional communication, server restart resilience, and SSE progress updates.

## Overview

External jobs allow you to:
- Run long-running tasks in any language
- Report progress back to the server in real-time
- Survive server restarts (jobs continue running)
- Broadcast progress updates via SSE to clients
- Monitor job health via heartbeats

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    @donkeylabs/server                           │
│                                                                 │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐       │
│  │   Jobs      │────▶│   Events    │────▶│    SSE      │───────┼──▶ Client
│  │   Service   │     │   Service   │     │   Service   │       │
│  └─────────────┘     └─────────────┘     └─────────────┘       │
│        │                                                        │
│        │ spawn + Unix socket                                    │
│        ▼                                                        │
│  ┌─────────────────────────────────────────────────────┐       │
│  │              External Job Manager                    │       │
│  │  - Spawn processes                                   │       │
│  │  - Unix socket communication                         │       │
│  │  - Heartbeat monitoring                              │       │
│  │  - State persistence for restart resilience          │       │
│  └─────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
          │
          │ bidirectional (Unix socket)
          ▼
    ┌───────────────┐
    │ External Job  │  (Python, Go, Rust, Shell, etc.)
    │ - Wrapper lib │
    │ - Heartbeat   │
    │ - Progress    │
    └───────────────┘
```

## Quick Start

### 1. Register an External Job

```typescript
import { AppServer } from "@donkeylabs/server";

const server = new AppServer({
  db: createDatabase(),
  port: 3000,
});

// Register an external job that runs a Python script
server.getCore().jobs.registerExternal("process-video", {
  command: "python",
  args: ["-m", "video_processor"],
  cwd: "./workers",
  heartbeatTimeout: 60000, // 60 seconds
  timeout: 3600000, // 1 hour max
});

await server.start();
```

### 2. Enqueue the Job

```typescript
// Same API as regular jobs
const jobId = await ctx.core.jobs.enqueue("process-video", {
  videoId: "abc123",
  operations: ["transcode", "thumbnail"],
});
```

### 3. Listen for Progress (Optional)

```typescript
// In your server setup
ctx.core.events.on("job.external.progress", (data) => {
  // Broadcast to SSE clients
  ctx.core.sse.broadcast(`job:${data.jobId}`, "progress", data);
});
```

### 4. Write the Worker (Python)

```python
# workers/video_processor.py
from donkeylabs_job import DonkeylabsJob, run_job

def process_video(job: DonkeylabsJob):
    video_id = job.data["videoId"]
    operations = job.data["operations"]

    for i, op in enumerate(operations):
        progress = (i / len(operations)) * 100
        job.progress(progress, f"Running {op}")

        # Do the actual work...
        if op == "transcode":
            transcode_video(video_id)
        elif op == "thumbnail":
            generate_thumbnail(video_id)

    return {"videoId": video_id, "processed": True}

if __name__ == "__main__":
    run_job(process_video)
```

## External Job Configuration

```typescript
interface ExternalJobConfig {
  /** Command to execute (e.g., "python", "node", "./script.sh") */
  command: string;

  /** Arguments to pass to the command */
  args?: string[];

  /** Working directory for the process */
  cwd?: string;

  /** Environment variables to set */
  env?: Record<string, string>;

  /** Heartbeat timeout in milliseconds (default: 30000) */
  heartbeatTimeout?: number;

  /** Job timeout in milliseconds (optional) */
  timeout?: number;
}
```

## Global External Jobs Configuration

Configure external jobs behavior in `ServerConfig`:

```typescript
const server = new AppServer({
  db: createDatabase(),
  jobs: {
    concurrency: 5,
    external: {
      /** Directory for Unix sockets (default: /tmp/donkeylabs-jobs) */
      socketDir: "/tmp/donkeylabs-jobs",

      /** TCP port range for Windows fallback (default: [49152, 65535]) */
      tcpPortRange: [49152, 65535],

      /** Default heartbeat timeout in ms (default: 30000) */
      defaultHeartbeatTimeout: 30000,

      /** Heartbeat check interval in ms (default: 10000) */
      heartbeatCheckInterval: 10000,
    },
  },
});
```

## Communication Protocol

External jobs communicate with the server via Unix sockets (or TCP on Windows) using newline-delimited JSON messages.

### Message Types

| Type | Direction | Description |
|------|-----------|-------------|
| `started` | Job → Server | Job has initialized and is ready |
| `progress` | Job → Server | Progress update |
| `heartbeat` | Job → Server | Health check (auto-sent by wrappers) |
| `log` | Job → Server | Log message |
| `completed` | Job → Server | Job finished successfully |
| `failed` | Job → Server | Job encountered an error |

### Message Format

```json
{
  "type": "progress",
  "jobId": "job_123_1234567890",
  "timestamp": 1234567890123,
  "percent": 50,
  "message": "Processing step 5 of 10",
  "data": { "currentStep": "resize" }
}
```

## Events

External jobs emit the following events:

| Event | Data | Description |
|-------|------|-------------|
| `job.external.spawned` | `{ jobId, name }` | Process started |
| `job.external.progress` | `{ jobId, name, percent, message, data }` | Progress update |
| `job.external.log` | `{ jobId, name, level, message, data }` | Log message |
| `job.completed` | `{ jobId, name, result }` | Job completed |
| `job.failed` | `{ jobId, name, error, stack }` | Job failed |
| `job.stale` | `{ jobId, name, timeSinceHeartbeat }` | No heartbeat |
| `job.reconnected` | `{ jobId, name }` | Reconnected after restart |
| `job.lost` | `{ jobId, name }` | Lost job after restart |

### Listening for Events

```typescript
// Subscribe to all job progress
ctx.core.events.on("job.external.progress", (data) => {
  console.log(`Job ${data.jobId}: ${data.percent}% - ${data.message}`);
});

// Subscribe to specific job completion
ctx.core.events.on("job.process-video.completed", (data) => {
  console.log(`Video processing completed: ${data.result}`);
});

// Handle stale jobs
ctx.core.events.on("job.stale", (data) => {
  console.warn(`Job ${data.jobId} hasn't sent heartbeat in ${data.timeSinceHeartbeat}ms`);
});
```

## SSE Integration

Broadcast job progress to clients via Server-Sent Events:

```typescript
// Server setup
ctx.core.events.on("job.external.progress", (data) => {
  // Broadcast to channel "job:<jobId>"
  ctx.core.sse.broadcast(`job:${data.jobId}`, "progress", {
    percent: data.percent,
    message: data.message,
  });
});

// In route handler - subscribe client to job updates
router.route("subscribe-job").raw({
  handle: async (req, ctx) => {
    const url = new URL(req.url);
    const jobId = url.searchParams.get("jobId");

    // Get SSE response
    const { client, response } = ctx.core.sse.addClient();

    // Subscribe to job channel
    ctx.core.sse.subscribe(client.id, `job:${jobId}`);

    return response;
  },
});
```

## Wrapper Libraries

After installing `@donkeylabs/server`, copy the wrapper to your project:

```bash
# Python
cp node_modules/@donkeylabs/server/examples/external-jobs/python/donkeylabs_job.py ./workers/

# Shell
cp node_modules/@donkeylabs/server/examples/external-jobs/shell/donkeylabs-job.sh ./workers/
```

### Python Wrapper

```python
from donkeylabs_job import DonkeylabsJob, run_job

def my_job(job: DonkeylabsJob):
    # Access job data
    data = job.data

    # Report progress
    job.progress(50, "Halfway done", extra_key="value")

    # Log messages
    job.info("Processing...")
    job.debug("Debug info")
    job.warn("Warning!")
    job.error("Error occurred")

    # Return result (auto-completes)
    return {"result": "success"}

# Or manually complete/fail:
def manual_job(job: DonkeylabsJob):
    try:
        result = do_work()
        job.complete(result)
    except Exception as e:
        job.fail(str(e))

if __name__ == "__main__":
    run_job(my_job)
```

### Shell Wrapper

Located at `examples/external-jobs/shell/donkeylabs-job.sh`:

```bash
#!/bin/bash
source /path/to/donkeylabs-job.sh

# Initialize (reads stdin, starts heartbeat)
job_init 5  # 5 second heartbeat interval

# Report progress
job_progress 0 "Starting..."

# Log messages
job_info "Processing data..."
job_debug "Debug info"
job_warn "Warning!"
job_error "Error!"

# Access job data (requires jq)
STEPS=$(job_data_get '.steps // 5')

# Do work...
for i in $(seq 1 $STEPS); do
    job_progress $((i * 100 / STEPS)) "Step $i"
    sleep 1
done

# Complete
job_complete '{"result": "success"}'

# Or fail
# job_fail "Something went wrong"
```

## Server Restart Resilience

External jobs automatically survive server restarts through built-in SQLite persistence.

### Default Behavior (SQLite Persistence)

Jobs are automatically persisted to `.donkeylabs/jobs.db` by default:

```typescript
import { AppServer } from "@donkeylabs/server";

const server = new AppServer({
  db: createDatabase(),
  // Jobs automatically use SQLite persistence - no config needed!
});

server.getCore().jobs.registerExternal("process-video", {
  command: "python",
  args: ["-m", "video_processor"],
});
```

### Configuration Options

```typescript
const server = new AppServer({
  db: createDatabase(),
  jobs: {
    // SQLite is used by default (persist: true)
    persist: true,                    // Set to false for in-memory only
    dbPath: ".donkeylabs/jobs.db",    // Custom database path
    external: {
      socketDir: "/tmp/donkeylabs-jobs",
    },
  },
});
```

### Custom Adapter

For Postgres, MySQL, or other databases, provide your own adapter:

```typescript
import { AppServer, SqliteJobAdapter } from "@donkeylabs/server";
import { MyPostgresJobAdapter } from "./adapters/postgres";

const server = new AppServer({
  db: createDatabase(),
  jobs: {
    adapter: new MyPostgresJobAdapter(db), // Custom adapter
  },
});
```

### What Gets Persisted

The adapter must persist these fields for external jobs:

| Field | Description |
|-------|-------------|
| `id` | Unique job ID |
| `name` | Job name |
| `data` | Job payload (JSON) |
| `status` | pending, running, completed, failed |
| `pid` | External process ID |
| `socketPath` | Unix socket path |
| `tcpPort` | TCP port (Windows) |
| `lastHeartbeat` | Last heartbeat timestamp |
| `processState` | spawning, running, orphaned |

### How Reconnection Works

1. **On Server Shutdown**: Job state is already persisted in the database
2. **On Server Restart**:
   - Server queries for jobs where `status = 'running'` and `external = true`
   - Checks if the process is still alive (via PID)
   - Checks if heartbeat hasn't expired
   - **Reserves** the socket path/port to prevent new jobs from using it
   - Recreates the socket server on the **same path/port**
   - External process detects disconnection and retries connecting
3. **Reconnection**: Once reconnected, the job resumes normal operation
4. **Cleanup**: When the job completes, fails, or is killed, the reservation is released

### Socket/Port Reservation

The server prevents new jobs from accidentally using socket paths or TCP ports that are reserved for orphaned jobs awaiting reconnection:

- When an orphaned job is detected on startup, its socket path/port is **reserved**
- New jobs cannot use reserved paths/ports (an error is thrown if attempted)
- Reservations are automatically released when:
  - The job completes successfully
  - The job fails
  - The job is killed due to stale heartbeat
  - The process is confirmed dead

This ensures that running external processes can always reconnect to their original socket path/port even if the server restarts multiple times.

### Python Wrapper Reconnection

The Python wrapper automatically handles reconnection:

```python
# Default reconnection settings
job = DonkeylabsJob(
    job_id=job_id,
    name=name,
    data=data,
    socket_path=socket_path,
    heartbeat_interval=5.0,      # Heartbeat every 5 seconds
    reconnect_interval=2.0,      # Retry every 2 seconds
    max_reconnect_attempts=30,   # Try for up to 60 seconds
)
```

When the connection is lost:
1. Heartbeat/progress messages fail to send
2. Background reconnection thread starts
3. Retries connecting to the same socket path
4. Once reconnected, sends "started" message to server
5. Normal operation resumes

### Best Practices

- **Always use a persistent adapter in production**
- External workers should be idempotent when possible
- Set `heartbeatTimeout` appropriately (longer = more time to reconnect)
- Consider longer `max_reconnect_attempts` for critical jobs

## Error Handling

### Heartbeat Timeout

If a job stops sending heartbeats:

1. After `heartbeatTimeout`: Emits `job.stale` event
2. After `2 * heartbeatTimeout`: Kills process, marks job as failed

### Process Exit

If the external process exits:

- Exit code 0 without completion message: Warning logged
- Non-zero exit code: Job marked as failed

### Job Timeout

If configured, jobs are killed after `timeout` milliseconds.

## API Reference

### Jobs Service

```typescript
interface Jobs {
  // Register external job configuration
  registerExternal(name: string, config: ExternalJobConfig): void;

  // Enqueue (works for both internal and external)
  enqueue<T>(name: string, data: T, options?: { maxAttempts?: number }): Promise<string>;

  // Schedule for later
  schedule<T>(name: string, data: T, runAt: Date, options?: { maxAttempts?: number }): Promise<string>;

  // Get job by ID
  get(jobId: string): Promise<Job | null>;

  // Cancel a job (kills external process if running)
  cancel(jobId: string): Promise<boolean>;

  // Get all running external jobs
  getRunningExternal(): Promise<Job[]>;
}
```

### Extended Job Interface

```typescript
interface Job {
  id: string;
  name: string;
  data: any;
  status: JobStatus;
  // ... standard fields ...

  // External job fields
  external?: boolean;
  pid?: number;
  socketPath?: string;
  tcpPort?: number;
  lastHeartbeat?: Date;
  processState?: "spawning" | "running" | "orphaned" | "reconnecting";
}
```

## Examples

See the `examples/external-jobs/` directory for complete examples:

- `python/donkeylabs_job.py` - Python wrapper library
- `shell/donkeylabs-job.sh` - Shell wrapper library
- `shell/example-job.sh` - Example shell script job
