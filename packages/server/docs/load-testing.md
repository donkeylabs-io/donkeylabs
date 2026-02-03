# Load Testing Guide

Performance testing for DonkeyLabs applications using k6 and Artillery.

## Table of Contents

- [Getting Started with k6](#getting-started-with-k6)
- [Basic Load Tests](#basic-load-tests)
- [Advanced Scenarios](#advanced-scenarios)
- [Testing DonkeyLabs Specifics](#testing-donkeylabs-specifics)
- [Performance Benchmarks](#performance-benchmarks)
- [Continuous Load Testing](#continuous-load-testing)
- [Troubleshooting Performance Issues](#troubleshooting-performance-issues)

---

## Getting Started with k6

### Installation

```bash
# macOS
brew install k6

# Linux
curl -s https://packagecloud.io/install/repositories/loadimpact/stable/script.deb.sh | sudo bash
sudo apt-get install k6

# Docker
docker pull grafana/k6

# Verify
k6 version
```

### Your First Test

```javascript
// load-tests/smoke-test.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,           // Virtual users
  duration: '30s',   // Test duration
  thresholds: {
    http_req_duration: ['p(95)<500'], // 95% under 500ms
    http_req_failed: ['rate<0.1'],    // Error rate < 10%
  },
};

export default function () {
  const res = http.get('http://localhost:3000/health');
  
  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });
  
  sleep(1);
}
```

```bash
# Run smoke test
k6 run load-tests/smoke-test.js
```

---

## Basic Load Tests

### 1. Smoke Test (Validate System)

```javascript
// load-tests/smoke.js
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 1,
  iterations: 1,
};

export default function () {
  // Test critical endpoints
  const checks = [
    http.get('http://localhost:3000/health'),
    http.get('http://localhost:3000/users.list'),
    http.post('http://localhost:3000/users.create', {
      email: 'test@example.com',
      name: 'Test User',
    }),
  ];
  
  checks.forEach((res, i) => {
    check(res, {
      [`endpoint ${i} status 200`]: (r) => r.status === 200,
    });
  });
}
```

### 2. Load Test (Normal Traffic)

```javascript
// load-tests/load.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 50 },    // Ramp up
    { duration: '5m', target: 50 },    // Stay at 50
    { duration: '2m', target: 100 },   // Ramp up
    { duration: '5m', target: 100 },   // Stay at 100
    { duration: '2m', target: 0 },     // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.1'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  // Simulate user flow
  
  // 1. List users
  const listRes = http.get(`${BASE_URL}/users.list`);
  check(listRes, {
    'list status 200': (r) => r.status === 200,
    'list response time < 500ms': (r) => r.timings.duration < 500,
  });
  
  sleep(2);
  
  // 2. Get specific user
  const userId = 'user-123'; // In real test, get from list response
  const getRes = http.get(`${BASE_URL}/users.get?id=${userId}`);
  check(getRes, {
    'get status 200': (r) => r.status === 200,
  });
  
  sleep(3);
}
```

### 3. Stress Test (Find Breaking Point)

```javascript
// load-tests/stress.js
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 100 },   // Below normal
    { duration: '5m', target: 100 },   // Normal
    { duration: '2m', target: 200 },   // Above normal
    { duration: '5m', target: 200 },   // Stress
    { duration: '2m', target: 300 },   // Breaking point
    { duration: '5m', target: 300 },   // Stay there
    { duration: '2m', target: 0 },     // Recovery
  ],
  thresholds: {
    http_req_duration: ['p(95)<1000'],
  },
};

export default function () {
  const res = http.get('http://localhost:3000/users.list');
  
  check(res, {
    'status is 200 or 503': (r) => [200, 503].includes(r.status),
  });
}
```

### 4. Spike Test (Sudden Traffic)

```javascript
// load-tests/spike.js
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 100 },  // Baseline
    { duration: '1m', target: 100 },   // Stay
    { duration: '10s', target: 1000 }, // Spike!
    { duration: '3m', target: 1000 },  // Stay
    { duration: '10s', target: 100 },  // Drop
    { duration: '3m', target: 100 },   // Recovery
    { duration: '10s', target: 0 },    // Done
  ],
};

export default function () {
  const res = http.get('http://localhost:3000/users.list');
  check(res, {
    'status is acceptable': (r) => [200, 429, 503].includes(r.status),
  });
}
```

### 5. Soak Test (Endurance)

```javascript
// load-tests/soak.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 100 },   // Ramp up
    { duration: '4h', target: 100 },   // Stay for 4 hours
    { duration: '2m', target: 0 },     // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.1'],
  },
};

export default function () {
  // Mix of operations
  const scenarios = [
    () => http.get('http://localhost:3000/users.list'),
    () => http.get('http://localhost:3000/users.get?id=user-1'),
    () => http.post('http://localhost:3000/users.create', {
      email: `user-${Date.now()}@test.com`,
      name: 'Test',
    }),
  ];
  
  const randomScenario = scenarios[Math.floor(Math.random() * scenarios.length)];
  const res = randomScenario();
  
  check(res, {
    'request successful': (r) => r.status === 200,
  });
  
  sleep(Math.random() * 2 + 1); // Random sleep 1-3s
}
```

---

## Advanced Scenarios

### Authentication Flow

```javascript
// load-tests/auth-flow.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 50,
  duration: '5m',
};

let authToken = null;

export function setup() {
  // Login and get token
  const loginRes = http.post('http://localhost:3000/auth.login', {
    email: 'loadtest@example.com',
    password: 'testpass123',
  });
  
  check(loginRes, {
    'login successful': (r) => r.status === 200,
  });
  
  return { token: loginRes.json('token') };
}

export default function (data) {
  const headers = {
    Authorization: `Bearer ${data.token}`,
    'Content-Type': 'application/json',
  };
  
  // Authenticated request
  const res = http.get('http://localhost:3000/users.me', { headers });
  
  check(res, {
    'authenticated request success': (r) => r.status === 200,
    'has user data': (r) => r.json('id') !== undefined,
  });
  
  sleep(1);
}
```

### Data-Driven Tests

```javascript
// load-tests/data-driven.js
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';

// Load test data
const users = new SharedArray('users', function () {
  return JSON.parse(open('./data/users.json'));
});

export const options = {
  vus: 10,
  iterations: users.length,
};

export default function () {
  const user = users[__ITER];
  
  const res = http.post('http://localhost:3000/users.create', {
    email: user.email,
    name: user.name,
  });
  
  check(res, {
    'user created': (r) => r.status === 200 || r.status === 409, // 409 if exists
  });
}
```

### WebSocket Testing

```javascript
// load-tests/websocket.js
import ws from 'k6/ws';
import { check } from 'k6';

export const options = {
  vus: 10,
  duration: '1m',
};

export default function () {
  const url = 'ws://localhost:3000/ws';
  
  const res = ws.connect(url, null, function (socket) {
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe', channel: 'updates' }));
    });
    
    socket.on('message', (data) => {
      const msg = JSON.parse(data);
      check(msg, {
        'received message': () => msg.type !== undefined,
      });
    });
    
    socket.setTimeout(function () {
      socket.close();
    }, 30000);
  });
  
  check(res, { 'status is 101': (r) => r && r.status === 101 });
}
```

### SSE (Server-Sent Events) Testing

```javascript
// load-tests/sse.js
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 50,
  duration: '2m',
};

export default function () {
  // Connect to SSE endpoint
  const res = http.get('http://localhost:3000/sse?channels=updates', {
    headers: {
      Accept: 'text/event-stream',
    },
    responseType: 'text',
    timeout: '120s',
  });
  
  check(res, {
    'SSE connection established': (r) => r.status === 200,
    'content-type is event-stream': (r) =>
      r.headers['Content-Type'] === 'text/event-stream',
  });
  
  // Parse SSE data
  const events = res.body.split('\n\n');
  check(events, {
    'received events': (e) => e.length > 0,
  });
}
```

---

## Testing DonkeyLabs Specifics

### Testing with Generated Client

```javascript
// load-tests/using-client.js
import http from 'k6/http';
import { check } from 'k6';

// Simulate the API client structure
class DonkeyLabsClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }
  
  users = {
    list: () => http.get(`${this.baseUrl}/users.list`),
    get: (id) => http.get(`${this.baseUrl}/users.get?id=${id}`),
    create: (data) =>
      http.post(`${this.baseUrl}/users.create`, JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' },
      }),
  };
  
  orders = {
    list: () => http.get(`${this.baseUrl}/orders.list`),
    create: (data) =>
      http.post(`${this.baseUrl}/orders.create`, JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' },
      }),
  };
}

const api = new DonkeyLabsClient(__ENV.BASE_URL || 'http://localhost:3000');

export const options = {
  vus: 100,
  duration: '5m',
};

export default function () {
  // Create a user
  const createRes = api.users.create({
    email: `user-${__VU}-${__ITER}@test.com`,
    name: 'Load Test User',
  });
  
  check(createRes, {
    'user created': (r) => r.status === 200,
  });
  
  if (createRes.status === 200) {
    const userId = createRes.json('id');
    
    // Get the user
    const getRes = api.users.get(userId);
    check(getRes, {
      'user retrieved': (r) => r.status === 200,
    });
    
    // Create an order for the user
    const orderRes = api.orders.create({
      userId,
      items: [{ productId: 'prod-1', quantity: 2 }],
    });
    
    check(orderRes, {
      'order created': (r) => r.status === 200,
    });
  }
}
```

### Plugin Service Testing

```javascript
// load-tests/plugin-test.js
import http from 'k6/http';
import { check } from 'k6';

// Test specific plugin functionality
export const options = {
  scenarios: {
    cache_test: {
      executor: 'constant-vus',
      vus: 50,
      duration: '2m',
      exec: 'cacheTest',
    },
    rate_limit_test: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 100 },
        { duration: '1m', target: 100 },
        { duration: '1m', target: 200 },
      ],
      exec: 'rateLimitTest',
    },
  },
};

export function cacheTest() {
  // Test cache hit performance
  const res = http.get('http://localhost:3000/users.list');
  
  check(res, {
    'cache response fast': (r) => r.timings.duration < 50,
    'status 200': (r) => r.status === 200,
  });
}

export function rateLimitTest() {
  // Test rate limiting
  const res = http.get('http://localhost:3000/api.heavy');
  
  check(res, {
    'rate limited or success': (r) =>
      [200, 429].includes(r.status),
  });
}
```

### Database Load Testing

```javascript
// load-tests/db-heavy.js
import http from 'k6/http';
import { check } from 'k6';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

export const options = {
  vus: 20,
  duration: '5m',
  thresholds: {
    http_req_duration: ['p(95)<1000'], // DB ops can be slower
  },
};

export default function () {
  // Heavy database operations
  
  // Complex query with joins
  const reportRes = http.post(
    'http://localhost:3000/reports.generate',
    JSON.stringify({
      type: 'user_activity',
      dateRange: {
        start: '2024-01-01',
        end: '2024-12-31',
      },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  
  check(reportRes, {
    'report generated': (r) => r.status === 200,
    'report not too slow': (r) => r.timings.duration < 5000,
  });
  
  // Bulk insert operation
  const bulkRes = http.post(
    'http://localhost:3000/users.bulkCreate',
    JSON.stringify({
      users: Array.from({ length: 10 }, (_, i) => ({
        email: `bulk-${__VU}-${__ITER}-${i}@test.com`,
        name: `User ${i}`,
      })),
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  
  check(bulkRes, {
    'bulk insert succeeded': (r) => r.status === 200,
  });
}
```

---

## Performance Benchmarks

### Establishing Baselines

```javascript
// load-tests/benchmark.js
import http from 'k6/http';
import { check, group } from 'k6';

export const options = {
  vus: 1,
  iterations: 100,
  thresholds: {
    'http_req_duration{group:::health}': ['avg<10'],
    'http_req_duration{group:::list}': ['avg<100'],
    'http_req_duration{group:::create}': ['avg<200'],
  },
};

export default function () {
  group('health', () => {
    const res = http.get('http://localhost:3000/health');
    check(res, {
      'health check': (r) => r.status === 200,
    });
  });
  
  group('list', () => {
    const res = http.get('http://localhost:3000/users.list');
    check(res, {
      'list users': (r) => r.status === 200,
    });
  });
  
  group('create', () => {
    const res = http.post(
      'http://localhost:3000/users.create',
      JSON.stringify({
        email: `bench-${Date.now()}@test.com`,
        name: 'Benchmark',
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    check(res, {
      'create user': (r) => r.status === 200,
    });
  });
}
```

### Run Benchmarks

```bash
# Run and output to JSON for analysis
k6 run --out json=benchmark-results.json load-tests/benchmark.js

# Run with custom thresholds
k6 run -e THRESHOLD_P95=200 load-tests/benchmark.js

# Compare against previous run
k6 run --out influxdb=http://localhost:8086/k6 load-tests/benchmark.js
```

### Performance Regression Testing

```javascript
// load-tests/regression.js
import http from 'k6/http';
import { check, fail } from 'k6';

// Baseline metrics from previous runs
const BASELINE = {
  health_p95: 10,
  list_p95: 100,
  create_p95: 200,
};

// Allow 20% regression
const THRESHOLD = 1.2;

export const options = {
  vus: 50,
  duration: '2m',
};

export default function () {
  const results = {
    health: [],
    list: [],
    create: [],
  };
  
  // Collect metrics
  results.health.push(http.get('http://localhost:3000/health').timings.duration);
  results.list.push(http.get('http://localhost:3000/users.list').timings.duration);
  results.create.push(
    http.post('http://localhost:3000/users.create', {
      email: `reg-${Date.now()}@test.com`,
      name: 'Test',
    }).timings.duration
  );
  
  // Check for regression (simplified, normally done in handleSummary)
}

export function handleSummary(data) {
  const checks = {
    health: data.metrics.http_req_duration.percentiles['95'] < BASELINE.health_p95 * THRESHOLD,
    list: data.metrics.http_req_duration.percentiles['95'] < BASELINE.list_p95 * THRESHOLD,
    create: data.metrics.http_req_duration.percentiles['95'] < BASELINE.create_p95 * THRESHOLD,
  };
  
  if (!Object.values(checks).every(Boolean)) {
    return {
      stdout: JSON.stringify({
        status: 'FAIL',
        message: 'Performance regression detected',
        checks,
      }),
    };
  }
  
  return {
    stdout: JSON.stringify({
      status: 'PASS',
      message: 'No regression detected',
      checks,
    }),
  };
}
```

---

## Continuous Load Testing

### GitHub Actions Integration

```yaml
# .github/workflows/load-test.yml
name: Load Test

on:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM
  workflow_dispatch:

jobs:
  load-test:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Setup k6
      run: |
        curl -s https://packagecloud.io/install/repositories/loadimpact/stable/script.deb.sh | sudo bash
        sudo apt-get install k6
    
    - name: Start test server
      run: |
        docker-compose up -d
        sleep 10  # Wait for startup
    
    - name: Run smoke test
      run: k6 run load-tests/smoke.js
    
    - name: Run load test
      run: k6 run --out json=results.json load-tests/load.js
    
    - name: Upload results
      uses: actions/upload-artifact@v3
      with:
        name: load-test-results
        path: results.json
    
    - name: Stop test server
      run: docker-compose down
```

### Performance Budget

```javascript
// load-tests/budget.js
import http from 'k6/http';
import { check } from 'k6';

// Performance budget
const BUDGET = {
  requests: {
    count: 100000,      // Max 100k requests
    errorRate: 0.01,    // Max 1% errors
  },
  timing: {
    median: 100,        // Median < 100ms
    p95: 500,           // 95th < 500ms
    p99: 1000,          // 99th < 1s
  },
  data: {
    download: 1000000,  // Max 1MB download per request
  },
};

export const options = {
  vus: 100,
  duration: '5m',
  thresholds: {
    http_req_duration: [
      `med<${BUDGET.timing.median}`,
      `p(95)<${BUDGET.timing.p95}`,
      `p(99)<${BUDGET.timing.p99}`,
    ],
    http_req_failed: [`rate<${BUDGET.requests.errorRate}`],
    data_received: [`avg<${BUDGET.data.download}`],
  },
};

export default function () {
  const res = http.get('http://localhost:3000/users.list');
  
  check(res, {
    'response time within budget': (r) => r.timings.duration < BUDGET.timing.p95,
  });
}
```

---

## Troubleshooting Performance Issues

### Common Issues

**1. High Response Times**

```javascript
// Debug slow requests
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const slowRequests = new Counter('slow_requests');

export default function () {
  const start = Date.now();
  const res = http.get('http://localhost:3000/users.list');
  const duration = Date.now() - start;
  
  if (duration > 1000) {
    slowRequests.add(1);
    console.log(`Slow request: ${duration}ms - ${res.url}`);
  }
  
  check(res, {
    'status 200': (r) => r.status === 200,
  });
}
```

**2. Memory Leaks**

```javascript
// Monitor memory over time
import exec from 'k6/execution';

export const options = {
  vus: 50,
  duration: '30m',  // Long test to detect leaks
};

export function setup() {
  return { startTime: Date.now() };
}

export default function (data) {
  // Run normal test
  http.get('http://localhost:3000/users.list');
  
  // Log progress
  if (__ITER % 1000 === 0) {
    const elapsed = (Date.now() - data.startTime) / 1000 / 60;
    console.log(`Running for ${elapsed.toFixed(1)} minutes, iteration ${__ITER}`);
  }
}
```

**3. Database Connection Issues**

```javascript
// Test connection pool exhaustion
export const options = {
  vus: 200,  // High concurrency to test pool
  duration: '2m',
};

export default function () {
  // Rapid sequential requests
  for (let i = 0; i < 10; i++) {
    const res = http.get('http://localhost:3000/users.list');
    
    check(res, {
      'no connection errors': (r) => r.status !== 503,
    });
  }
}
```

### Analysis Tools

```bash
# Generate HTML report
k6 run --out html=report.html load-tests/load.js

# Export to InfluxDB for Grafana
k6 run --out influxdb=http://localhost:8086/k6 load-tests/load.js

# Export to Prometheus
k6 run --out experimental-prometheus-rw load-tests/load.js

# Compare runs
k6 compare run1.json run2.json
```

### Interpreting Results

**Good Performance:**
```
http_req_duration..............: avg=45ms   min=10ms   med=40ms   max=150ms  p(90)=80ms   p(95)=100ms
http_req_failed................: 0.00%
http_reqs......................: 50000    1000/s
```

**Performance Issues:**
```
http_req_duration..............: avg=500ms  min=50ms   med=450ms  max=3000ms p(90)=1200ms p(95)=2000ms
http_req_failed................: 5.00%
http_reqs......................: 5000     100/s  ← Low throughput
```

**Actions for Bad Performance:**
1. Check database connection pool
2. Review slow query logs
3. Check for N+1 queries
4. Verify caching is working
5. Monitor server resources (CPU, memory)
6. Check for blocking operations

---

## Quick Reference

### Run Commands

```bash
# Basic test
k6 run load-tests/smoke.js

# With environment variables
k6 run -e BASE_URL=https://api.example.com load-tests/load.js

# Cloud execution
k6 cloud run load-tests/load.js

# With custom options
k6 run --vus 100 --duration 5m load-tests/load.js

# Verbose output
k6 run --verbose load-tests/smoke.js
```

### Key Metrics

| Metric | Good | Warning | Bad |
|--------|------|---------|-----|
| http_req_duration (p95) | < 200ms | 200-500ms | > 500ms |
| http_req_failed | < 0.1% | 0.1-1% | > 1% |
| http_reqs (throughput) | > 1000/s | 100-1000/s | < 100/s |
| vus | Scalable | Limited by resources | System overloaded |

### Testing Checklist

Before production:
- [ ] Smoke test passes
- [ ] Load test meets performance budget
- [ ] Stress test identifies breaking point
- [ ] Spike test handles sudden traffic
- [ ] Soak test stable for 4+ hours
- [ ] All error rates < 1%
- [ ] Database handles concurrent connections
- [ ] Memory usage stable over time
- [ ] Cache hit rates acceptable
