#!/bin/bash
#
# Donkeylabs External Job Shell Wrapper
#
# This script provides functions for shell scripts to communicate
# with the Donkeylabs job system via Unix sockets or TCP.
#
# Usage:
#   #!/bin/bash
#   source /path/to/donkeylabs-job.sh
#
#   # Initialize the job (reads from stdin)
#   job_init
#
#   # Report progress
#   job_progress 50 "Halfway done"
#
#   # Log messages
#   job_log info "Processing data..."
#
#   # Complete the job
#   job_complete '{"result": "success"}'
#
#   # Or fail the job
#   job_fail "Something went wrong"
#

# Global variables (set by job_init)
DONKEYLABS_JOB_ID=""
DONKEYLABS_JOB_NAME=""
DONKEYLABS_JOB_DATA=""
DONKEYLABS_SOCKET_PATH=""
DONKEYLABS_HEARTBEAT_PID=""

# Get current timestamp in milliseconds
_job_timestamp() {
    # Try to use date with milliseconds, fall back to seconds * 1000
    if date '+%s%3N' >/dev/null 2>&1; then
        date '+%s%3N'
    else
        echo "$(($(date '+%s') * 1000))"
    fi
}

# Send a message to the socket
_job_send() {
    local message="$1"

    if [[ "$DONKEYLABS_SOCKET_PATH" == tcp://* ]]; then
        # TCP connection
        local addr="${DONKEYLABS_SOCKET_PATH#tcp://}"
        local host="${addr%:*}"
        local port="${addr##*:}"

        # Use bash's /dev/tcp or nc
        if [[ -e /dev/tcp ]]; then
            echo "$message" > /dev/tcp/"$host"/"$port" 2>/dev/null
        else
            echo "$message" | nc -q0 "$host" "$port" 2>/dev/null || \
            echo "$message" | nc -w0 "$host" "$port" 2>/dev/null
        fi
    else
        # Unix socket
        if command -v socat >/dev/null 2>&1; then
            echo "$message" | socat - UNIX-CONNECT:"$DONKEYLABS_SOCKET_PATH" 2>/dev/null
        elif command -v nc >/dev/null 2>&1; then
            echo "$message" | nc -U "$DONKEYLABS_SOCKET_PATH" 2>/dev/null
        else
            echo "Error: Neither socat nor nc (netcat) found. Cannot send messages." >&2
            return 1
        fi
    fi
}

# Build a JSON message
_job_build_message() {
    local type="$1"
    local extra="$2"

    local timestamp
    timestamp=$(_job_timestamp)

    local message="{\"type\":\"$type\",\"jobId\":\"$DONKEYLABS_JOB_ID\",\"timestamp\":$timestamp"

    if [[ -n "$extra" ]]; then
        message="$message,$extra"
    fi

    message="$message}"

    echo "$message"
}

# Start the heartbeat background process
_job_start_heartbeat() {
    local interval="${1:-5}"

    (
        while true; do
            sleep "$interval"
            _job_send "$(_job_build_message "heartbeat")"
        done
    ) &

    DONKEYLABS_HEARTBEAT_PID=$!
}

# Stop the heartbeat background process
_job_stop_heartbeat() {
    if [[ -n "$DONKEYLABS_HEARTBEAT_PID" ]]; then
        kill "$DONKEYLABS_HEARTBEAT_PID" 2>/dev/null
        wait "$DONKEYLABS_HEARTBEAT_PID" 2>/dev/null
        DONKEYLABS_HEARTBEAT_PID=""
    fi
}

# Initialize the job by reading payload from stdin
job_init() {
    local heartbeat_interval="${1:-5}"

    # Read payload from stdin
    local payload
    read -r payload

    if [[ -z "$payload" ]]; then
        echo "Error: No payload received on stdin" >&2
        exit 1
    fi

    # Parse JSON payload using jq if available, otherwise use basic grep/sed
    if command -v jq >/dev/null 2>&1; then
        DONKEYLABS_JOB_ID=$(echo "$payload" | jq -r '.jobId // empty')
        DONKEYLABS_JOB_NAME=$(echo "$payload" | jq -r '.name // empty')
        DONKEYLABS_JOB_DATA=$(echo "$payload" | jq -c '.data // {}')
        DONKEYLABS_SOCKET_PATH=$(echo "$payload" | jq -r '.socketPath // empty')
    else
        # Basic parsing (less robust)
        DONKEYLABS_JOB_ID=$(echo "$payload" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)
        DONKEYLABS_JOB_NAME=$(echo "$payload" | grep -o '"name":"[^"]*"' | cut -d'"' -f4)
        DONKEYLABS_SOCKET_PATH=$(echo "$payload" | grep -o '"socketPath":"[^"]*"' | cut -d'"' -f4)
        DONKEYLABS_JOB_DATA="{}"
    fi

    # Fall back to environment variables
    DONKEYLABS_JOB_ID="${DONKEYLABS_JOB_ID:-$DONKEYLABS_JOB_ID}"
    DONKEYLABS_SOCKET_PATH="${DONKEYLABS_SOCKET_PATH:-$DONKEYLABS_SOCKET_PATH}"

    # If TCP port is set but not socket path, construct TCP URL
    if [[ -z "$DONKEYLABS_SOCKET_PATH" && -n "$DONKEYLABS_TCP_PORT" ]]; then
        DONKEYLABS_SOCKET_PATH="tcp://127.0.0.1:$DONKEYLABS_TCP_PORT"
    fi

    if [[ -z "$DONKEYLABS_JOB_ID" || -z "$DONKEYLABS_SOCKET_PATH" ]]; then
        echo "Error: Missing jobId or socketPath" >&2
        exit 1
    fi

    # Start heartbeat in background
    _job_start_heartbeat "$heartbeat_interval"

    # Send started message
    _job_send "$(_job_build_message "started")"

    # Set up cleanup trap
    trap '_job_stop_heartbeat' EXIT
}

# Report progress
# Usage: job_progress <percent> [message]
job_progress() {
    local percent="$1"
    local message="${2:-}"

    local extra="\"percent\":$percent"

    if [[ -n "$message" ]]; then
        # Escape message for JSON
        message="${message//\\/\\\\}"
        message="${message//\"/\\\"}"
        message="${message//$'\n'/\\n}"
        extra="$extra,\"message\":\"$message\""
    fi

    _job_send "$(_job_build_message "progress" "$extra")"
}

# Send a log message
# Usage: job_log <level> <message>
job_log() {
    local level="$1"
    local message="$2"

    # Escape message for JSON
    message="${message//\\/\\\\}"
    message="${message//\"/\\\"}"
    message="${message//$'\n'/\\n}"

    _job_send "$(_job_build_message "log" "\"level\":\"$level\",\"message\":\"$message\"")"
}

# Convenience log functions
job_debug() { job_log "debug" "$1"; }
job_info() { job_log "info" "$1"; }
job_warn() { job_log "warn" "$1"; }
job_error() { job_log "error" "$1"; }

# Complete the job
# Usage: job_complete [result_json]
job_complete() {
    local result="${1:-null}"

    _job_stop_heartbeat

    if [[ "$result" == "null" || -z "$result" ]]; then
        _job_send "$(_job_build_message "completed")"
    else
        _job_send "$(_job_build_message "completed" "\"result\":$result")"
    fi
}

# Fail the job
# Usage: job_fail <error_message>
job_fail() {
    local error="$1"

    _job_stop_heartbeat

    # Escape error for JSON
    error="${error//\\/\\\\}"
    error="${error//\"/\\\"}"
    error="${error//$'\n'/\\n}"

    _job_send "$(_job_build_message "failed" "\"error\":\"$error\"")"
}

# Get a value from job data (requires jq)
# Usage: job_data_get <path>
job_data_get() {
    local path="$1"

    if command -v jq >/dev/null 2>&1; then
        echo "$DONKEYLABS_JOB_DATA" | jq -r "$path"
    else
        echo "Error: jq is required to parse job data" >&2
        return 1
    fi
}

# Example usage (only runs if script is executed directly)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "Donkeylabs Job Shell Wrapper"
    echo ""
    echo "Usage: source this file in your shell script"
    echo ""
    echo "Example:"
    echo "  #!/bin/bash"
    echo "  source donkeylabs-job.sh"
    echo ""
    echo "  job_init"
    echo "  job_progress 0 \"Starting...\""
    echo "  # Do work..."
    echo "  job_progress 100 \"Done!\""
    echo "  job_complete '{\"result\": \"success\"}'"
fi
