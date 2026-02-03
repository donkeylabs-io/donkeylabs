/**
 * Admin Dashboard HTML Templates
 * Uses htmx for dynamic content and SSE for real-time updates
 */

import { adminStyles } from "./styles";

// Icon SVGs (inline to avoid external dependencies)
const icons = {
  dashboard: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/></svg>`,
  jobs: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>`,
  processes: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>`,
  workflows: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`,
  audit: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`,
  sse: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"/></svg>`,
  websocket: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>`,
  events: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>`,
  cache: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"/></svg>`,
  plugins: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z"/></svg>`,
  routes: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"/></svg>`,
  logs: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"/></svg>`,
  refresh: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>`,
  server: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"/></svg>`,
};

export interface DashboardData {
  prefix: string;
  stats: {
    uptime: number;
    memory: { heapUsed: number; heapTotal: number };
    jobs: { pending: number; running: number; completed: number; failed: number };
    processes: { running: number; total: number };
    workflows: { running: number; total: number };
    sse: { clients: number };
    websocket: { clients: number };
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatRelativeTime(date: Date | string | undefined): string {
  if (!date) return "-";
  const d = typeof date === "string" ? new Date(date) : date;
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function renderDashboardLayout(
  prefix: string,
  content: string,
  activeNav: string = "overview"
): string {
  const navItems = [
    { id: "overview", label: "Overview", icon: icons.dashboard },
    { id: "jobs", label: "Jobs", icon: icons.jobs },
    { id: "processes", label: "Processes", icon: icons.processes },
    { id: "workflows", label: "Workflows", icon: icons.workflows },
    { id: "audit", label: "Audit Logs", icon: icons.audit },
    { id: "logs", label: "Logs", icon: icons.logs },
    { id: "sse", label: "SSE Clients", icon: icons.sse },
    { id: "websocket", label: "WebSocket", icon: icons.websocket },
    { id: "events", label: "Events", icon: icons.events },
    { id: "cache", label: "Cache", icon: icons.cache },
    { id: "plugins", label: "Plugins", icon: icons.plugins },
    { id: "routes", label: "Routes", icon: icons.routes },
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Dashboard | @donkeylabs/server</title>
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <script src="https://unpkg.com/htmx-ext-sse@2.2.2/sse.js"></script>
  <style>${adminStyles}</style>
</head>
<body>
  <div class="admin-container">
    <aside class="sidebar">
      <div class="sidebar-header">
        <h1 class="sidebar-title">
          ${icons.server}
          Admin
        </h1>
      </div>
      <nav class="nav-section">
        <div class="nav-section-title">Dashboard</div>
        ${navItems
          .slice(0, 1)
          .map(
            (item) => `
          <a href="/${prefix}.dashboard?view=${item.id}"
             class="nav-item ${activeNav === item.id ? "active" : ""}"
             hx-get="/${prefix}.dashboard?view=${item.id}&partial=1"
             hx-target="#main-content"
             hx-push-url="/${prefix}.dashboard?view=${item.id}">
            ${item.icon}
            <span>${item.label}</span>
          </a>
        `
          )
          .join("")}
      </nav>
      <nav class="nav-section">
        <div class="nav-section-title">Core Services</div>
        ${navItems
          .slice(1, 6)
          .map(
            (item) => `
          <a href="/${prefix}.dashboard?view=${item.id}"
             class="nav-item ${activeNav === item.id ? "active" : ""}"
             hx-get="/${prefix}.dashboard?view=${item.id}&partial=1"
             hx-target="#main-content"
             hx-push-url="/${prefix}.dashboard?view=${item.id}">
            ${item.icon}
            <span>${item.label}</span>
          </a>
        `
          )
          .join("")}
      </nav>
      <nav class="nav-section">
        <div class="nav-section-title">Connections</div>
        ${navItems
          .slice(6, 9)
          .map(
            (item) => `
          <a href="/${prefix}.dashboard?view=${item.id}"
             class="nav-item ${activeNav === item.id ? "active" : ""}"
             hx-get="/${prefix}.dashboard?view=${item.id}&partial=1"
             hx-target="#main-content"
             hx-push-url="/${prefix}.dashboard?view=${item.id}">
            ${item.icon}
            <span>${item.label}</span>
          </a>
        `
          )
          .join("")}
      </nav>
      <nav class="nav-section">
        <div class="nav-section-title">Configuration</div>
        ${navItems
          .slice(9)
          .map(
            (item) => `
          <a href="/${prefix}.dashboard?view=${item.id}"
             class="nav-item ${activeNav === item.id ? "active" : ""}"
             hx-get="/${prefix}.dashboard?view=${item.id}&partial=1"
             hx-target="#main-content"
             hx-push-url="/${prefix}.dashboard?view=${item.id}">
            ${item.icon}
            <span>${item.label}</span>
          </a>
        `
          )
          .join("")}
      </nav>
    </aside>
    <main class="main-content" id="main-content">
      ${content}
    </main>
  </div>
</body>
</html>`;
}

export function renderOverview(prefix: string, stats: DashboardData["stats"]): string {
  return `
    <div class="page-header">
      <h2 class="page-title">Overview</h2>
      <button class="btn" hx-get="/${prefix}.dashboard?view=overview&partial=1" hx-target="#main-content">
        ${icons.refresh}
        Refresh
      </button>
    </div>

    <div class="stats-grid" hx-ext="sse" sse-connect="/${prefix}.live" sse-swap="stats">
      <div class="stat-card">
        <div class="stat-label">Uptime</div>
        <div class="stat-value blue">${formatUptime(stats.uptime)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Memory (Heap)</div>
        <div class="stat-value">${formatBytes(stats.memory.heapUsed)} / ${formatBytes(stats.memory.heapTotal)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Jobs Running</div>
        <div class="stat-value blue">${stats.jobs.running}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Jobs Pending</div>
        <div class="stat-value yellow">${stats.jobs.pending}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Jobs Completed</div>
        <div class="stat-value green">${stats.jobs.completed}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Jobs Failed</div>
        <div class="stat-value red">${stats.jobs.failed}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Processes</div>
        <div class="stat-value purple">${stats.processes.running}/${stats.processes.total}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Workflows Running</div>
        <div class="stat-value blue">${stats.workflows.running}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">SSE Clients</div>
        <div class="stat-value green">${stats.sse.clients}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">WebSocket Clients</div>
        <div class="stat-value green">${stats.websocket.clients}</div>
      </div>
    </div>
  `;
}

export function renderJobsList(prefix: string, jobs: any[]): string {
  return `
    <div class="page-header">
      <h2 class="page-title">Jobs</h2>
      <button class="btn" hx-get="/${prefix}.dashboard?view=jobs&partial=1" hx-target="#main-content">
        ${icons.refresh}
        Refresh
      </button>
    </div>

    <div class="filters">
      <select class="filter-select" hx-get="/${prefix}.dashboard?view=jobs&partial=1" hx-target="#main-content" hx-include="this" name="status">
        <option value="">All Status</option>
        <option value="pending">Pending</option>
        <option value="running">Running</option>
        <option value="completed">Completed</option>
        <option value="failed">Failed</option>
        <option value="scheduled">Scheduled</option>
      </select>
    </div>

    <div class="card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${
              jobs.length === 0
                ? '<tr><td colspan="6" class="empty-state">No jobs found</td></tr>'
                : jobs
                    .map(
                      (job) => `
              <tr>
                <td class="mono truncate" title="${job.id}">${job.id.slice(0, 20)}...</td>
                <td>${job.name}</td>
                <td><span class="badge badge-${job.status}">${job.status}</span></td>
                <td>${job.attempts}/${job.maxAttempts}</td>
                <td class="relative-time">${formatRelativeTime(job.createdAt)}</td>
                <td class="action-btns">
                  ${
                    job.status === "pending" || job.status === "running"
                      ? `<button class="btn btn-sm btn-danger"
                           hx-post="/${prefix}.jobs.cancel"
                           hx-vals='{"jobId": "${job.id}"}'
                           hx-target="#main-content"
                           hx-confirm="Cancel this job?">Cancel</button>`
                      : ""
                  }
                </td>
              </tr>
            `
                    )
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export function renderProcessesList(prefix: string, processes: any[]): string {
  return `
    <div class="page-header">
      <h2 class="page-title">Processes</h2>
      <button class="btn" hx-get="/${prefix}.dashboard?view=processes&partial=1" hx-target="#main-content">
        ${icons.refresh}
        Refresh
      </button>
    </div>

    <div class="card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>PID</th>
              <th>Restarts</th>
              <th>Started</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${
              processes.length === 0
                ? '<tr><td colspan="6" class="empty-state">No processes found</td></tr>'
                : processes
                    .map(
                      (proc) => `
              <tr>
                <td>${proc.name}</td>
                <td><span class="badge badge-${proc.status}">${proc.status}</span></td>
                <td class="mono">${proc.pid ?? "-"}</td>
                <td>${proc.restarts ?? 0}</td>
                <td class="relative-time">${formatRelativeTime(proc.startedAt)}</td>
                <td class="action-btns">
                  ${
                    proc.status === "running"
                      ? `<button class="btn btn-sm btn-danger"
                           hx-post="/${prefix}.processes.stop"
                           hx-vals='{"name": "${proc.name}"}'
                           hx-target="#main-content"
                           hx-confirm="Stop this process?">Stop</button>`
                      : `<button class="btn btn-sm btn-primary"
                           hx-post="/${prefix}.processes.restart"
                           hx-vals='{"name": "${proc.name}"}'
                           hx-target="#main-content">Restart</button>`
                  }
                </td>
              </tr>
            `
                    )
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export function renderWorkflowsList(prefix: string, workflows: any[]): string {
  return `
    <div class="page-header">
      <h2 class="page-title">Workflows</h2>
      <button class="btn" hx-get="/${prefix}.dashboard?view=workflows&partial=1" hx-target="#main-content">
        ${icons.refresh}
        Refresh
      </button>
    </div>

    <div class="filters">
      <select class="filter-select" hx-get="/${prefix}.dashboard?view=workflows&partial=1" hx-target="#main-content" hx-include="this" name="status">
        <option value="">All Status</option>
        <option value="pending">Pending</option>
        <option value="running">Running</option>
        <option value="completed">Completed</option>
        <option value="failed">Failed</option>
        <option value="cancelled">Cancelled</option>
      </select>
    </div>

    <div class="card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Workflow</th>
              <th>Status</th>
              <th>Current Step</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${
              workflows.length === 0
                ? '<tr><td colspan="6" class="empty-state">No workflow instances found</td></tr>'
                : workflows
                    .map(
                      (wf) => `
              <tr>
                <td class="mono truncate" title="${wf.id}">${wf.id.slice(0, 20)}...</td>
                <td>${wf.workflowName}</td>
                <td><span class="badge badge-${wf.status}">${wf.status}</span></td>
                <td>${wf.currentStep ?? "-"}</td>
                <td class="relative-time">${formatRelativeTime(wf.createdAt)}</td>
                <td class="action-btns">
                  ${
                    wf.status === "running"
                      ? `<button class="btn btn-sm btn-danger"
                           hx-post="/${prefix}.workflows.cancel"
                           hx-vals='{"instanceId": "${wf.id}"}'
                           hx-target="#main-content"
                           hx-confirm="Cancel this workflow?">Cancel</button>`
                      : ""
                  }
                </td>
              </tr>
            `
                    )
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export function renderAuditLogs(prefix: string, logs: any[]): string {
  return `
    <div class="page-header">
      <h2 class="page-title">Audit Logs</h2>
      <button class="btn" hx-get="/${prefix}.dashboard?view=audit&partial=1" hx-target="#main-content">
        ${icons.refresh}
        Refresh
      </button>
    </div>

    <div class="card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Action</th>
              <th>Actor</th>
              <th>Resource</th>
              <th>Resource ID</th>
              <th>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            ${
              logs.length === 0
                ? '<tr><td colspan="5" class="empty-state">No audit logs found</td></tr>'
                : logs
                    .map(
                      (log) => `
              <tr>
                <td>${log.action}</td>
                <td>${log.actor}</td>
                <td>${log.resource}</td>
                <td>${log.resourceId ?? "-"}</td>
                <td class="relative-time">${formatRelativeTime(log.timestamp)}</td>
              </tr>
            `
                    )
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export function renderSSEClients(prefix: string, clients: any[]): string {
  return `
    <div class="page-header">
      <h2 class="page-title">SSE Clients</h2>
      <button class="btn" hx-get="/${prefix}.dashboard?view=sse&partial=1" hx-target="#main-content">
        ${icons.refresh}
        Refresh
      </button>
    </div>

    <div class="card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Client ID</th>
              <th>Channels</th>
              <th>Connected</th>
            </tr>
          </thead>
          <tbody>
            ${
              clients.length === 0
                ? '<tr><td colspan="3" class="empty-state">No SSE clients connected</td></tr>'
                : clients
                    .map(
                      (client) => `
              <tr>
                <td class="mono truncate" title="${client.id}">${client.id.slice(0, 20)}...</td>
                <td>${client.channels?.join(", ") || "-"}</td>
                <td class="relative-time">${formatRelativeTime(client.connectedAt)}</td>
              </tr>
            `
                    )
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export function renderWebSocketClients(prefix: string, clients: any[]): string {
  return `
    <div class="page-header">
      <h2 class="page-title">WebSocket Clients</h2>
      <button class="btn" hx-get="/${prefix}.dashboard?view=websocket&partial=1" hx-target="#main-content">
        ${icons.refresh}
        Refresh
      </button>
    </div>

    <div class="card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Client ID</th>
              <th>Connected</th>
            </tr>
          </thead>
          <tbody>
            ${
              clients.length === 0
                ? '<tr><td colspan="2" class="empty-state">No WebSocket clients connected</td></tr>'
                : clients
                    .map(
                      (client) => `
              <tr>
                <td class="mono truncate" title="${client.id}">${client.id.slice(0, 20)}...</td>
                <td class="relative-time">${formatRelativeTime(client.connectedAt)}</td>
              </tr>
            `
                    )
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export function renderEvents(prefix: string, events: any[]): string {
  return `
    <div class="page-header">
      <h2 class="page-title">Recent Events</h2>
      <button class="btn" hx-get="/${prefix}.dashboard?view=events&partial=1" hx-target="#main-content">
        ${icons.refresh}
        Refresh
      </button>
    </div>

    <div class="card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Data</th>
              <th>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            ${
              events.length === 0
                ? '<tr><td colspan="3" class="empty-state">No events recorded</td></tr>'
                : events
                    .map(
                      (event) => `
              <tr>
                <td class="mono">${event.event}</td>
                <td class="truncate">${JSON.stringify(event.data).slice(0, 50)}...</td>
                <td class="relative-time">${formatRelativeTime(event.timestamp)}</td>
              </tr>
            `
                    )
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export function renderCache(prefix: string, keys: string[]): string {
  return `
    <div class="page-header">
      <h2 class="page-title">Cache</h2>
      <button class="btn" hx-get="/${prefix}.dashboard?view=cache&partial=1" hx-target="#main-content">
        ${icons.refresh}
        Refresh
      </button>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">Cache Keys (${keys.length})</span>
      </div>
      <div class="card-body">
        ${
          keys.length === 0
            ? '<div class="empty-state">No cached keys</div>'
            : `<div class="code-block">${keys.map((k) => k).join("\n")}</div>`
        }
      </div>
    </div>
  `;
}

export function renderPlugins(prefix: string, plugins: any[]): string {
  return `
    <div class="page-header">
      <h2 class="page-title">Plugins</h2>
    </div>

    <div class="card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Dependencies</th>
              <th>Has Schema</th>
            </tr>
          </thead>
          <tbody>
            ${
              plugins.length === 0
                ? '<tr><td colspan="3" class="empty-state">No plugins registered</td></tr>'
                : plugins
                    .map(
                      (plugin) => `
              <tr>
                <td><strong>${plugin.name}</strong></td>
                <td>${plugin.dependencies?.join(", ") || "-"}</td>
                <td>${plugin.hasSchema ? "Yes" : "No"}</td>
              </tr>
            `
                    )
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export function renderLogs(prefix: string, logs: any[]): string {
  const levelBadgeClass = (level: string) => {
    switch (level) {
      case "error": return "badge-failed";
      case "warn": return "badge-pending";
      case "info": return "badge-running";
      case "debug": return "badge-completed";
      default: return "";
    }
  };

  return `
    <div class="page-header">
      <h2 class="page-title">Logs</h2>
      <button class="btn" hx-get="/${prefix}.dashboard?view=logs&partial=1" hx-target="#main-content">
        ${icons.refresh}
        Refresh
      </button>
    </div>

    <div class="filters">
      <select class="filter-select" hx-get="/${prefix}.dashboard?view=logs&partial=1" hx-target="#main-content" hx-include="this" name="status">
        <option value="">All Sources</option>
        <option value="system">System</option>
        <option value="cron">Cron</option>
        <option value="job">Job</option>
        <option value="workflow">Workflow</option>
        <option value="plugin">Plugin</option>
        <option value="route">Route</option>
      </select>
    </div>

    <div class="card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Level</th>
              <th>Source</th>
              <th>Source ID</th>
              <th>Message</th>
              <th>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            ${
              logs.length === 0
                ? '<tr><td colspan="5" class="empty-state">No log entries found</td></tr>'
                : logs
                    .map(
                      (log: any) => `
              <tr>
                <td><span class="badge ${levelBadgeClass(log.level)}">${log.level}</span></td>
                <td>${log.source}</td>
                <td class="mono truncate" title="${log.sourceId ?? ""}">${log.sourceId ?? "-"}</td>
                <td class="truncate" title="${log.message}">${log.message.slice(0, 80)}${log.message.length > 80 ? "..." : ""}</td>
                <td class="relative-time">${formatRelativeTime(log.timestamp)}</td>
              </tr>
            `
                    )
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export function renderRoutes(prefix: string, routes: any[]): string {
  return `
    <div class="page-header">
      <h2 class="page-title">Routes</h2>
    </div>

    <div class="card">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Route Name</th>
              <th>Handler</th>
              <th>Has Input</th>
              <th>Has Output</th>
            </tr>
          </thead>
          <tbody>
            ${
              routes.length === 0
                ? '<tr><td colspan="4" class="empty-state">No routes registered</td></tr>'
                : routes
                    .map(
                      (route) => `
              <tr>
                <td class="mono">${route.name}</td>
                <td><span class="badge badge-${route.handler === "typed" ? "completed" : "running"}">${route.handler || "typed"}</span></td>
                <td>${route.hasInput ? "Yes" : "No"}</td>
                <td>${route.hasOutput ? "Yes" : "No"}</td>
              </tr>
            `
                    )
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}
