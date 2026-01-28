/**
 * Admin Dashboard Styles
 * Dark theme, minimal CSS (no build step)
 */

export const adminStyles = `
:root {
  --bg-primary: #0f0f0f;
  --bg-secondary: #1a1a1a;
  --bg-tertiary: #252525;
  --text-primary: #e0e0e0;
  --text-secondary: #999;
  --text-muted: #666;
  --border-color: #333;
  --accent-blue: #3b82f6;
  --accent-green: #22c55e;
  --accent-yellow: #eab308;
  --accent-red: #ef4444;
  --accent-purple: #a855f7;
  --font-mono: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', 'Droid Sans Mono', monospace;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-primary);
  background: var(--bg-primary);
  min-height: 100vh;
}

.admin-container {
  display: flex;
  min-height: 100vh;
}

/* Sidebar */
.sidebar {
  width: 220px;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-color);
  padding: 20px 0;
  position: fixed;
  height: 100vh;
  overflow-y: auto;
}

.sidebar-header {
  padding: 0 20px 20px;
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 10px;
}

.sidebar-title {
  font-size: 16px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.sidebar-title svg {
  width: 20px;
  height: 20px;
}

.nav-section {
  padding: 10px 0;
}

.nav-section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 8px 20px 6px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  color: var(--text-secondary);
  text-decoration: none;
  transition: all 0.15s;
  cursor: pointer;
  border-left: 3px solid transparent;
}

.nav-item:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.nav-item.active {
  background: rgba(59, 130, 246, 0.1);
  color: var(--accent-blue);
  border-left-color: var(--accent-blue);
}

.nav-item svg {
  width: 16px;
  height: 16px;
  opacity: 0.7;
}

/* Main content */
.main-content {
  flex: 1;
  margin-left: 220px;
  padding: 24px;
  min-height: 100vh;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.page-title {
  font-size: 24px;
  font-weight: 600;
}

/* Stats grid */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}

.stat-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 20px;
}

.stat-label {
  font-size: 12px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}

.stat-value {
  font-size: 28px;
  font-weight: 600;
  font-family: var(--font-mono);
}

.stat-value.green { color: var(--accent-green); }
.stat-value.yellow { color: var(--accent-yellow); }
.stat-value.red { color: var(--accent-red); }
.stat-value.blue { color: var(--accent-blue); }
.stat-value.purple { color: var(--accent-purple); }

/* Cards */
.card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  margin-bottom: 24px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.card-title {
  font-size: 16px;
  font-weight: 600;
}

.card-body {
  padding: 16px 20px;
}

/* Tables */
.table-container {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th, td {
  text-align: left;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}

th {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  background: var(--bg-tertiary);
}

tr:hover td {
  background: rgba(255, 255, 255, 0.02);
}

td {
  font-size: 13px;
}

/* Status badges */
.badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.badge-pending { background: rgba(234, 179, 8, 0.2); color: var(--accent-yellow); }
.badge-running { background: rgba(59, 130, 246, 0.2); color: var(--accent-blue); }
.badge-completed { background: rgba(34, 197, 94, 0.2); color: var(--accent-green); }
.badge-failed { background: rgba(239, 68, 68, 0.2); color: var(--accent-red); }
.badge-cancelled { background: rgba(156, 163, 175, 0.2); color: var(--text-muted); }
.badge-scheduled { background: rgba(168, 85, 247, 0.2); color: var(--accent-purple); }

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.btn:hover {
  background: var(--bg-secondary);
  border-color: var(--text-muted);
}

.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

.btn-danger {
  background: rgba(239, 68, 68, 0.1);
  border-color: var(--accent-red);
  color: var(--accent-red);
}

.btn-danger:hover {
  background: rgba(239, 68, 68, 0.2);
}

.btn-primary {
  background: var(--accent-blue);
  border-color: var(--accent-blue);
  color: white;
}

.btn-primary:hover {
  background: #2563eb;
}

/* Filters */
.filters {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.filter-select {
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
}

.filter-select:focus {
  outline: none;
  border-color: var(--accent-blue);
}

/* Code/mono text */
.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

.code-block {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 16px;
  font-family: var(--font-mono);
  font-size: 12px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

/* Empty state */
.empty-state {
  text-align: center;
  padding: 48px;
  color: var(--text-muted);
}

.empty-state svg {
  width: 48px;
  height: 48px;
  margin-bottom: 16px;
  opacity: 0.5;
}

/* Responsive */
@media (max-width: 768px) {
  .sidebar {
    width: 60px;
    padding: 10px 0;
  }

  .sidebar-header,
  .nav-section-title,
  .nav-item span {
    display: none;
  }

  .nav-item {
    padding: 12px;
    justify-content: center;
  }

  .main-content {
    margin-left: 60px;
  }
}

/* Loading indicator */
.htmx-indicator {
  opacity: 0;
  transition: opacity 0.2s;
}

.htmx-request .htmx-indicator {
  opacity: 1;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-blue);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Truncate text */
.truncate {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

/* Relative time */
.relative-time {
  color: var(--text-muted);
}

/* Pulse animation for live indicators */
.pulse {
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* Action buttons in tables */
.action-btns {
  display: flex;
  gap: 8px;
}
`;
