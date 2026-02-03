# Production Deployment Guide

Deploying DonkeyLabs applications to production environments with Docker, monitoring, and best practices.

## Table of Contents

- [Docker Deployment](#docker-deployment)
- [Environment Configuration](#environment-configuration)
- [Database Migrations](#database-migrations)
- [Health Checks](#health-checks)
- [Logging & Monitoring](#logging--monitoring)
- [Performance Optimization](#performance-optimization)
- [Security Hardening](#security-hardening)
- [CI/CD Pipelines](#cicd-pipelines)
- [Scaling Strategies](#scaling-strategies)
- [Troubleshooting Production](#troubleshooting-production)

---

## Docker Deployment

### Basic Dockerfile

```dockerfile
# Dockerfile
FROM oven/bun:1.0-alpine

WORKDIR /app

# Copy package files
COPY package.json bun.lockb ./
COPY packages/server/package.json ./packages/server/
COPY packages/cli/package.json ./packages/cli/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Generate types (if needed for build)
RUN bun run gen:types || true

# Build for production (if using SvelteKit)
RUN bun run build || true

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start server
CMD ["bun", "run", "src/server/index.ts"]
```

### Multi-Stage Build (Optimized)

```dockerfile
# Dockerfile.production
# Stage 1: Dependencies
FROM oven/bun:1.0-alpine AS deps
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

# Stage 2: Builder
FROM oven/bun:1.0-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run gen:types
RUN bun run build

# Stage 3: Production
FROM oven/bun:1.0-alpine AS runner
WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S bunuser -u 1001

# Copy only necessary files
COPY --from=builder --chown=bunuser:bunuser /app/dist ./dist
COPY --from=builder --chown=bunuser:bunuser /app/node_modules ./node_modules
COPY --from=builder --chown=bunuser:bunuser /app/package.json ./package.json

# Switch to non-root user
USER bunuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["bun", "run", "dist/server/index.js"]
```

### Docker Compose

```yaml
# docker-compose.yml
version: '3.8'

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://user:pass@db:5432/app
      - REDIS_URL=redis://redis:6379
      - JWT_SECRET=${JWT_SECRET}
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 3s
      retries: 3

  db:
    image: postgres:15-alpine
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_DB=app
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U user -d app"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl:/etc/nginx/ssl:ro
    depends_on:
      - app
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:
```

### Nginx Configuration

```nginx
# nginx.conf
upstream app {
    server app:3000;
    keepalive 32;
}

server {
    listen 80;
    server_name _;
    
    # Redirect to HTTPS in production
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json application/javascript application/rss+xml;

    # API routes
    location ~ ^/[a-zA-Z][a-zA-Z0-9_.]*$ {
        proxy_pass http://app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        
        # Buffering
        proxy_buffering on;
        proxy_buffer_size 4k;
        proxy_buffers 8 4k;
    }

    # SSE endpoints (no buffering)
    location /sse {
        proxy_pass http://app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }

    # Static files (SvelteKit)
    location / {
        proxy_pass http://app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # Health check endpoint (exposed)
    location /health {
        proxy_pass http://app;
        access_log off;
    }
}
```

---

## Environment Configuration

### Environment Variables

```bash
# .env.production
NODE_ENV=production
PORT=3000

# Database
DATABASE_URL=postgresql://user:password@host:5432/dbname
DATABASE_POOL_SIZE=20
DATABASE_TIMEOUT=30000

# Redis (optional, for distributed cache)
REDIS_URL=redis://localhost:6379
REDIS_POOL_SIZE=10

# Security
JWT_SECRET=your-super-secret-jwt-key-min-32-chars
ENCRYPTION_KEY=your-encryption-key-32-chars-long

# Logging
LOG_LEVEL=info
LOG_FORMAT=json

# Monitoring
METRICS_ENABLED=true
METRICS_PORT=9090
TRACING_ENABLED=true

# Rate Limiting
RATE_LIMIT_ENABLED=true
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100

# Cache
CACHE_TTL_MS=300000
CACHE_MAX_SIZE=10000

# Email (if using email plugin)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=notifications@example.com
SMTP_PASS=your-smtp-password

# External APIs
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

### Configuration Validation

```typescript
// src/server/config.ts
import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),
  PORT: z.string().transform(Number).default("3000"),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_SIZE: z.string().transform(Number).default("20"),
  JWT_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  RATE_LIMIT_ENABLED: z.string().transform(Boolean).default("true"),
  CACHE_TTL_MS: z.string().transform(Number).default("300000"),
});

export const config = configSchema.parse(process.env);
```

### Production Server Setup

```typescript
// src/server/index.ts
import { AppServer } from "@donkeylabs/server";
import { Kysely } from "kysely";
import { PostgresDialect } from "kysely";
import { Pool } from "pg";
import { config } from "./config";

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new Pool({
      connectionString: config.DATABASE_URL,
      max: config.DATABASE_POOL_SIZE,
    }),
  }),
});

const server = new AppServer({
  port: config.PORT,
  db,
  
  // Production logging
  logger: {
    level: config.LOG_LEVEL,
    format: "json", // Structured logging for log aggregation
    redact: ["password", "token", "secret", "authorization"],
  },
  
  // Rate limiting
  rateLimiter: config.RATE_LIMIT_ENABLED ? {
    windowMs: 60000,
    maxRequests: 100,
    keyGenerator: (req) => req.headers.get("x-forwarded-for") || "unknown",
  } : undefined,
  
  // Production cache
  cache: {
    defaultTtlMs: config.CACHE_TTL_MS,
    maxSize: 10000,
  },
  
  // Admin dashboard (disabled in production or protected)
  admin: config.NODE_ENV === "production" ? false : {
    enabled: true,
    auth: {
      username: process.env.ADMIN_USER,
      password: process.env.ADMIN_PASS,
    },
  },
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down gracefully");
  await server.shutdown();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, shutting down gracefully");
  await server.shutdown();
  process.exit(0);
});

await server.start();
```

---

## Database Migrations

### Migration Strategy

**Option 1: Run Migrations on Startup**

```typescript
// src/server/index.ts
const server = new AppServer({ ... });

// Run migrations before starting
await server.migrate();
await server.start();
```

**Option 2: Separate Migration Job (Recommended)**

```typescript
// scripts/migrate.ts
import { Kysely } from "kysely";
import { runMigrations } from "@donkeylabs/server";
import { db } from "./src/server/db";

async function main() {
  console.log("Running migrations...");
  await runMigrations(db, {
    migrationsDir: "./src/server/plugins/**/migrations",
    dryRun: process.env.DRY_RUN === "true",
  });
  console.log("Migrations complete");
  await db.destroy();
}

main().catch(console.error);
```

```bash
# Run migrations
bun scripts/migrate.ts

# Dry run (preview)
DRY_RUN=true bun scripts/migrate.ts
```

### Kubernetes Job

```yaml
# k8s/migration-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migration
spec:
  template:
    spec:
      containers:
      - name: migrate
        image: your-app:latest
        command: ["bun", "scripts/migrate.ts"]
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: database-url
      restartPolicy: Never
  backoffLimit: 3
```

### Migration Rollback

```typescript
// scripts/rollback.ts
import { db } from "./src/server/db";

async function rollback(steps: number = 1) {
  console.log(`Rolling back ${steps} migration(s)...`);
  await db.migration.rollback({ steps });
  console.log("Rollback complete");
  await db.destroy();
}

rollback(parseInt(process.argv[2] || "1"));
```

---

## Health Checks

### Basic Health Check

```typescript
// src/server/routes/health/index.ts
import { createRouter, defineRoute } from "@donkeylabs/server";
import { z } from "zod";

export const healthRouter = createRouter("health");

healthRouter.route("check").typed(defineRoute({
  output: z.object({
    status: z.enum(["healthy", "unhealthy"]),
    timestamp: z.string(),
    version: z.string(),
    checks: z.object({
      database: z.enum(["ok", "error"]),
      cache: z.enum(["ok", "error"]),
    }),
  }),
  handle: async (_, ctx) => {
    const checks = {
      database: "ok" as const,
      cache: "ok" as const,
    };

    // Check database
    try {
      await ctx.db.selectFrom("users").select("id").limit(1).execute();
    } catch {
      checks.database = "error";
    }

    // Check cache
    try {
      await ctx.core.cache.set("health:check", "ok", 1000);
      await ctx.core.cache.get("health:check");
    } catch {
      checks.cache = "error";
    }

    const isHealthy = checks.database === "ok" && checks.cache === "ok";

    return {
      status: isHealthy ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || "unknown",
      checks,
    };
  },
}));
```

### Readiness Probe

```typescript
healthRouter.route("ready").typed(defineRoute({
  output: z.object({ ready: z.boolean() }),
  handle: async (_, ctx) => {
    // Check if server is ready to accept traffic
    const isReady = ctx.core.jobs.isInitialized && 
                   ctx.core.events.isConnected;
    
    return { ready: isReady };
  },
}));
```

### Liveness Probe

```typescript
healthRouter.route("live").typed(defineRoute({
  output: z.object({ alive: z.boolean() }),
  handle: async () => {
    // Simple check - if we can respond, we're alive
    return { alive: true };
  },
}));
```

---

## Logging & Monitoring

### Structured Logging

```typescript
// Production logging configuration
const server = new AppServer({
  logger: {
    level: "info",
    format: "json",
    redact: ["password", "token", "secret", "authorization", "cookie"],
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        headers: {
          "user-agent": req.headers.get("user-agent"),
          "x-request-id": req.headers.get("x-request-id"),
        },
      }),
    },
  },
});
```

### Request Logging

```typescript
// Middleware for request logging
router.middleware.use(createMiddleware(
  async (req, ctx, next) => {
    const start = Date.now();
    const requestId = crypto.randomUUID();
    
    ctx.core.logger.info({
      msg: "Request started",
      requestId,
      method: req.method,
      url: req.url,
    });
    
    const response = await next();
    
    const duration = Date.now() - start;
    ctx.core.logger.info({
      msg: "Request completed",
      requestId,
      status: response.status,
      duration,
    });
    
    return response;
  }
));
```

### Metrics Collection

```typescript
// src/server/metrics.ts
import { createService } from "@donkeylabs/server";

export const metricsService = createService("metrics", async (ctx) => {
  const counters = new Map<string, number>();
  const histograms = new Map<string, number[]>();
  
  return {
    increment(name: string, tags?: Record<string, string>) {
      const key = this.formatKey(name, tags);
      counters.set(key, (counters.get(key) || 0) + 1);
    },
    
    timing(name: string, value: number, tags?: Record<string, string>) {
      const key = this.formatKey(name, tags);
      const values = histograms.get(key) || [];
      values.push(value);
      histograms.set(key, values);
    },
    
    formatKey(name: string, tags?: Record<string, string>): string {
      if (!tags) return name;
      const tagStr = Object.entries(tags)
        .map(([k, v]) => `${k}:${v}`)
        .join(",");
      return `${name}{${tagStr}}`;
    },
    
    getReport() {
      return {
        counters: Object.fromEntries(counters),
        histograms: Object.fromEntries(
          Array.from(histograms.entries()).map(([k, v]) => [
            k,
            {
              count: v.length,
              min: Math.min(...v),
              max: Math.max(...v),
              avg: v.reduce((a, b) => a + b, 0) / v.length,
              p95: v.sort((a, b) => a - b)[Math.floor(v.length * 0.95)],
            },
          ])
        ),
      };
    },
  };
});
```

### Prometheus Endpoint

```typescript
// src/server/routes/metrics/index.ts
import { createRouter, defineRoute } from "@donkeylabs/server";

export const metricsRouter = createRouter("metrics");

metricsRouter.route("prometheus").typed(defineRoute({
  output: z.string(),
  handle: async (_, ctx) => {
    const report = ctx.services.metrics.getReport();
    
    let output = "";
    
    // Counters
    for (const [key, value] of Object.entries(report.counters)) {
      output += `# TYPE ${key.split("{")[0]} counter\n`;
      output += `${key} ${value}\n`;
    }
    
    // Histograms
    for (const [key, stats] of Object.entries(report.histograms)) {
      const baseName = key.split("{")[0];
      output += `# TYPE ${baseName} histogram\n`;
      output += `${key}_count ${stats.count}\n`;
      output += `${key}_sum ${stats.avg * stats.count}\n`;
    }
    
    return output;
  },
}));
```

### Error Tracking (Sentry)

```typescript
// src/server/errors.ts
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  release: process.env.npm_package_version,
  tracesSampleRate: 0.1,
});

const server = new AppServer({
  onError: (error, ctx) => {
    Sentry.captureException(error, {
      extra: {
        user: ctx?.user,
        requestId: ctx?.requestId,
      },
    });
  },
});
```

---

## Performance Optimization

### Database Connection Pooling

```typescript
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                    // Maximum connections
  min: 5,                     // Minimum connections
  acquireTimeoutMillis: 3000, // Timeout for acquiring connection
  idleTimeoutMillis: 30000,   // Close idle connections
  connectionTimeoutMillis: 2000,
});
```

### Response Compression

```typescript
// Enable in nginx (see nginx.conf above)
// Or use middleware
import { createMiddleware } from "@donkeylabs/server";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

const compressionMiddleware = createMiddleware(
  async (req, ctx, next) => {
    const response = await next();
    
    // Only compress JSON responses > 1KB
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      const body = await response.text();
      if (body.length > 1024) {
        const compressed = await gzipAsync(Buffer.from(body));
        return new Response(compressed, {
          status: response.status,
          headers: {
            ...Object.fromEntries(response.headers),
            "content-encoding": "gzip",
            "content-length": compressed.length.toString(),
          },
        });
      }
    }
    
    return response;
  }
);
```

### Caching Strategy

```typescript
// API response caching
router.route("users.list").typed(defineRoute({
  input: z.object({ page: z.number().optional() }),
  output: z.array(userSchema),
  handle: async (input, ctx) => {
    const cacheKey = `users:list:page:${input.page || 1}`;
    
    return ctx.core.cache.getOrSet(
      cacheKey,
      async () => {
        return ctx.db
          .selectFrom("users")
          .selectAll()
          .limit(50)
          .offset((input.page || 0) * 50)
          .execute();
      },
      60000 // 1 minute
    );
  },
}));
```

---

## Security Hardening

### Security Headers

```typescript
// Security headers middleware
import { createMiddleware } from "@donkeylabs/server";

const securityHeadersMiddleware = createMiddleware(
  async (req, ctx, next) => {
    const response = await next();
    
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("X-Frame-Options", "DENY");
    response.headers.set("X-XSS-Protection", "1; mode=block");
    response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    response.headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    
    // CSP (adjust for your needs)
    response.headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';"
    );
    
    return response;
  }
);
```

### Rate Limiting

```typescript
const server = new AppServer({
  rateLimiter: {
    windowMs: 60000,      // 1 minute
    maxRequests: 100,     // 100 requests per window
    keyGenerator: (req) => {
      // Use forwarded IP if behind proxy
      return req.headers.get("x-forwarded-for")?.split(",")[0] || 
             req.headers.get("x-real-ip") || 
             "unknown";
    },
    skip: (req) => {
      // Skip rate limiting for health checks
      return req.url?.includes("/health");
    },
  },
});
```

### Input Validation

```typescript
import { z } from "zod";

// Strict validation schemas
const createUserSchema = z.object({
  email: z.string().email().max(255),
  name: z.string().min(1).max(100).regex(/^[\w\s-]+$/),
  password: z.string().min(8).max(100),
  role: z.enum(["user", "admin"]).default("user"),
});

router.route("users.create").typed(defineRoute({
  input: createUserSchema,
  handle: async (input, ctx) => {
    // Input is already validated
    return ctx.plugins.users.create(input);
  },
}));
```

### SQL Injection Prevention

```typescript
// Always use parameterized queries (Kysely does this automatically)
// NEVER concatenate user input into SQL

// ✅ Good - parameterized
await ctx.db
  .selectFrom("users")
  .where("email", "=", input.email) // Safe
  .execute();

// ❌ Bad - SQL injection risk
await ctx.db.executeQuery(
  sql`SELECT * FROM users WHERE email = '${input.email}'` // Dangerous!
);
```

---

## CI/CD Pipelines

### GitHub Actions

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432

    steps:
    - uses: actions/checkout@v3
    
    - name: Setup Bun
      uses: oven-sh/setup-bun@v1
      with:
        bun-version: latest
    
    - name: Install dependencies
      run: bun install
    
    - name: Type check
      run: bun --bun tsc --noEmit
    
    - name: Run migrations
      env:
        DATABASE_URL: postgres://postgres:postgres@localhost:5432/test
      run: bun scripts/migrate.ts
    
    - name: Run tests
      env:
        DATABASE_URL: postgres://postgres:postgres@localhost:5432/test
      run: bun test

  build:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v2
    
    - name: Login to Container Registry
      uses: docker/login-action@v2
      with:
        registry: ghcr.io
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}
    
    - name: Build and push
      uses: docker/build-push-action@v4
      with:
        context: .
        push: true
        tags: |
          ghcr.io/${{ github.repository }}:latest
          ghcr.io/${{ github.repository }}:${{ github.sha }}
        cache-from: type=gha
        cache-to: type=gha,mode=max

  deploy:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    
    steps:
    - name: Deploy to production
      uses: appleboy/ssh-action@master
      with:
        host: ${{ secrets.SSH_HOST }}
        username: ${{ secrets.SSH_USER }}
        key: ${{ secrets.SSH_KEY }}
        script: |
          cd /opt/app
          docker-compose pull
          docker-compose up -d
          docker system prune -f
```

---

## Scaling Strategies

### Horizontal Scaling

```yaml
# docker-compose.scale.yml
version: '3.8'

services:
  app:
    build: .
    deploy:
      replicas: 3
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://...
    depends_on:
      - db
      - redis

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - app

  db:
    image: postgres:15-alpine
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

### Load Balancing with Nginx

```nginx
upstream app {
    least_conn;  # Least connections load balancing
    server app_1:3000 max_fails=3 fail_timeout=30s;
    server app_2:3000 max_fails=3 fail_timeout=30s;
    server app_3:3000 max_fails=3 fail_timeout=30s;
    keepalive 32;
}
```

### Database Read Replicas

```typescript
// Connection to read replicas
const readDb = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new Pool({
      connectionString: process.env.DATABASE_READ_URL,
      max: 20,
    }),
  }),
});

// Use read replica for read operations
router.route("users.list").typed(defineRoute({
  handle: async (_, ctx) => {
    // Read from replica
    return readDb.selectFrom("users").selectAll().execute();
  },
}));
```

---

## Troubleshooting Production

### Debugging Checklist

```bash
# 1. Check container status
docker-compose ps
docker-compose logs --tail=100 app

# 2. Check health endpoint
curl http://localhost:3000/health

# 3. Check database connectivity
docker-compose exec app bun -e "
  import { db } from './src/server/db';
  await db.selectFrom('users').limit(1).execute();
  console.log('DB OK');
"

# 4. Check resource usage
docker stats

# 5. Check nginx logs
docker-compose logs nginx
```

### Common Issues

**Database connection pool exhausted:**
```typescript
// Increase pool size
const pool = new Pool({
  max: 50, // Increase from default
  // ...
});
```

**Memory leaks:**
```typescript
// Add heap dump endpoint for debugging
if (process.env.NODE_ENV === "production") {
  router.route("debug.heap").typed(defineRoute({
    handle: async () => {
      const heap = require("v8").getHeapStatistics();
      return {
        used: heap.used_heap_size,
        total: heap.total_heap_size,
        limit: heap.heap_size_limit,
      };
    },
  }));
}
```

**Slow queries:**
```typescript
// Enable query logging
const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
  log: (event) => {
    if (event.level === "query" && event.queryDurationMillis > 100) {
      console.warn("Slow query:", event.query.sql, `${event.queryDurationMillis}ms`);
    }
  },
});
```

### Graceful Degradation

```typescript
// Fallback when services are down
router.route("dashboard").typed(defineRoute({
  handle: async (_, ctx) => {
    try {
      const stats = await ctx.core.cache.getOrSet(
        "dashboard:stats",
        () => computeStats(ctx),
        60000
      );
      return { stats };
    } catch (error) {
      // Return stale data or fallback
      const staleStats = await ctx.core.cache.get("dashboard:stats");
      if (staleStats) {
        ctx.core.logger.warn("Using stale dashboard stats");
        return { stats: staleStats, stale: true };
      }
      
      // Ultimate fallback
      return { stats: null, error: "Service temporarily unavailable" };
    }
  },
}));
```

---

## Production Checklist

Before deploying to production:

- [ ] Environment variables configured
- [ ] Database migrations tested
- [ ] Health checks implemented
- [ ] Logging structured (JSON)
- [ ] Error tracking configured (Sentry)
- [ ] Metrics collection enabled
- [ ] Rate limiting enabled
- [ ] Security headers configured
- [ ] SSL/TLS certificates
- [ ] Docker multi-stage build
- [ ] Graceful shutdown handlers
- [ ] Backup strategy
- [ ] Monitoring dashboards
- [ ] Runbook created
- [ ] Load testing completed

---

## Additional Resources

- [Docker Best Practices](https://docs.docker.com/develop/dev-best-practices/)
- [PostgreSQL Tuning](https://wiki.postgresql.org/wiki/Tuning_Your_PostgreSQL_Server)
- [Nginx Load Balancing](https://nginx.org/en/docs/http/load_balancing.html)
- [Kubernetes Deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
