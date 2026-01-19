"""
Donkeylabs External Job Python Wrapper

This module provides a simple interface for Python scripts to communicate
with the Donkeylabs job system via Unix sockets or TCP.

Usage:
    from donkeylabs_job import DonkeylabsJob, run_job

    def my_job(job: DonkeylabsJob):
        job.progress(0, "Starting...")
        # Do work...
        job.progress(50, "Halfway done")
        # More work...
        return {"result": "success"}

    if __name__ == "__main__":
        run_job(my_job)
"""

import json
import os
import socket
import sys
import threading
import time
from typing import Any, Callable, Dict, Optional


class DonkeylabsJob:
    """Interface for communicating with the Donkeylabs job system."""

    def __init__(
        self,
        job_id: str,
        name: str,
        data: Any,
        socket_path: str,
        heartbeat_interval: float = 5.0,
        reconnect_interval: float = 2.0,
        max_reconnect_attempts: int = 30,
    ):
        self.job_id = job_id
        self.name = name
        self.data = data
        self._socket_path = socket_path
        self._heartbeat_interval = heartbeat_interval
        self._reconnect_interval = reconnect_interval
        self._max_reconnect_attempts = max_reconnect_attempts
        self._socket: Optional[socket.socket] = None
        self._heartbeat_thread: Optional[threading.Thread] = None
        self._reconnect_thread: Optional[threading.Thread] = None
        self._running = False
        self._connected = False
        self._lock = threading.Lock()
        self._reconnect_lock = threading.Lock()

    def connect(self) -> None:
        """Connect to the job server socket."""
        self._do_connect()
        self._running = True
        self._connected = True
        self._start_heartbeat()
        self._send_started()

    def _do_connect(self) -> None:
        """Internal connection logic."""
        if self._socket_path.startswith("tcp://"):
            # TCP connection (Windows fallback)
            addr = self._socket_path[6:]  # Remove "tcp://"
            host, port = addr.rsplit(":", 1)
            self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self._socket.connect((host, int(port)))
        else:
            # Unix socket
            self._socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self._socket.connect(self._socket_path)

    def _try_reconnect(self) -> bool:
        """Attempt to reconnect to the server (for server restart resilience)."""
        with self._reconnect_lock:
            if self._connected:
                return True

            print(f"[DonkeylabsJob] Attempting to reconnect...", file=sys.stderr)

            for attempt in range(self._max_reconnect_attempts):
                try:
                    # Close old socket
                    if self._socket:
                        try:
                            self._socket.close()
                        except Exception:
                            pass

                    # Try to reconnect
                    self._do_connect()
                    self._connected = True
                    print(f"[DonkeylabsJob] Reconnected after {attempt + 1} attempts", file=sys.stderr)

                    # Send started message to let server know we're back
                    self._send_started()
                    return True
                except Exception as e:
                    print(f"[DonkeylabsJob] Reconnect attempt {attempt + 1}/{self._max_reconnect_attempts} failed: {e}", file=sys.stderr)
                    time.sleep(self._reconnect_interval)

            print(f"[DonkeylabsJob] Failed to reconnect after {self._max_reconnect_attempts} attempts", file=sys.stderr)
            return False

    def disconnect(self) -> None:
        """Disconnect from the job server."""
        self._running = False
        if self._heartbeat_thread:
            self._heartbeat_thread.join(timeout=2.0)
        if self._socket:
            try:
                self._socket.close()
            except Exception:
                pass

    def _send_message(self, message: Dict[str, Any]) -> bool:
        """Send a JSON message to the server. Returns True if sent successfully."""
        if not self._socket:
            return False

        message["jobId"] = self.job_id
        message["timestamp"] = int(time.time() * 1000)

        with self._lock:
            try:
                data = json.dumps(message) + "\n"
                self._socket.sendall(data.encode("utf-8"))
                return True
            except (BrokenPipeError, ConnectionResetError, OSError) as e:
                print(f"[DonkeylabsJob] Connection lost: {e}", file=sys.stderr)
                self._connected = False

                # Try to reconnect in background (don't block the caller)
                if self._running and not self._reconnect_thread:
                    self._reconnect_thread = threading.Thread(
                        target=self._reconnect_loop,
                        daemon=True
                    )
                    self._reconnect_thread.start()
                return False
            except Exception as e:
                print(f"[DonkeylabsJob] Failed to send message: {e}", file=sys.stderr)
                return False

    def _reconnect_loop(self) -> None:
        """Background thread that attempts to reconnect."""
        if self._try_reconnect():
            print(f"[DonkeylabsJob] Reconnection successful, resuming operation", file=sys.stderr)
        else:
            print(f"[DonkeylabsJob] Reconnection failed, job may be lost", file=sys.stderr)
        self._reconnect_thread = None

    def _send_started(self) -> None:
        """Send a started message to the server."""
        self._send_message({"type": "started"})

    def _start_heartbeat(self) -> None:
        """Start the background heartbeat thread."""

        def heartbeat_loop():
            while self._running:
                self._send_message({"type": "heartbeat"})
                time.sleep(self._heartbeat_interval)

        self._heartbeat_thread = threading.Thread(target=heartbeat_loop, daemon=True)
        self._heartbeat_thread.start()

    def progress(
        self,
        percent: float,
        message: Optional[str] = None,
        **data: Any,
    ) -> None:
        """
        Report progress to the job server.

        Args:
            percent: Progress percentage (0-100)
            message: Optional status message
            **data: Additional data to include
        """
        msg: Dict[str, Any] = {
            "type": "progress",
            "percent": percent,
        }
        if message:
            msg["message"] = message
        if data:
            msg["data"] = data

        self._send_message(msg)

    def log(
        self,
        level: str,
        message: str,
        **data: Any,
    ) -> None:
        """
        Send a log message to the job server.

        Args:
            level: Log level (debug, info, warn, error)
            message: Log message
            **data: Additional data to include
        """
        msg: Dict[str, Any] = {
            "type": "log",
            "level": level,
            "message": message,
        }
        if data:
            msg["data"] = data

        self._send_message(msg)

    def debug(self, message: str, **data: Any) -> None:
        """Send a debug log message."""
        self.log("debug", message, **data)

    def info(self, message: str, **data: Any) -> None:
        """Send an info log message."""
        self.log("info", message, **data)

    def warn(self, message: str, **data: Any) -> None:
        """Send a warning log message."""
        self.log("warn", message, **data)

    def error(self, message: str, **data: Any) -> None:
        """Send an error log message."""
        self.log("error", message, **data)

    def complete(self, result: Any = None) -> None:
        """
        Mark the job as completed.

        Args:
            result: Optional result data to return
        """
        msg: Dict[str, Any] = {"type": "completed"}
        if result is not None:
            msg["result"] = result

        self._send_message(msg)

    def fail(self, error: str, stack: Optional[str] = None) -> None:
        """
        Mark the job as failed.

        Args:
            error: Error message
            stack: Optional stack trace
        """
        msg: Dict[str, Any] = {
            "type": "failed",
            "error": error,
        }
        if stack:
            msg["stack"] = stack

        self._send_message(msg)


def run_job(
    handler: Callable[[DonkeylabsJob], Any],
    heartbeat_interval: float = 5.0,
) -> None:
    """
    Run a job handler function.

    This function reads the job payload from stdin, connects to the job server,
    runs the handler, and reports the result.

    Args:
        handler: A function that takes a DonkeylabsJob and returns the result
        heartbeat_interval: How often to send heartbeats (seconds)

    Example:
        def my_job(job: DonkeylabsJob):
            job.progress(0, "Starting...")
            result = do_work(job.data)
            return result

        if __name__ == "__main__":
            run_job(my_job)
    """
    # Read payload from stdin
    payload_line = sys.stdin.readline()
    if not payload_line:
        print("No payload received on stdin", file=sys.stderr)
        sys.exit(1)

    try:
        payload = json.loads(payload_line)
    except json.JSONDecodeError as e:
        print(f"Failed to parse payload: {e}", file=sys.stderr)
        sys.exit(1)

    job_id = payload.get("jobId")
    name = payload.get("name")
    data = payload.get("data")
    socket_path = payload.get("socketPath")

    # Fall back to environment variables if not in payload
    if not job_id:
        job_id = os.environ.get("DONKEYLABS_JOB_ID")
    if not socket_path:
        socket_path = os.environ.get("DONKEYLABS_SOCKET_PATH")
        tcp_port = os.environ.get("DONKEYLABS_TCP_PORT")
        if tcp_port and not socket_path:
            socket_path = f"tcp://127.0.0.1:{tcp_port}"

    if not job_id or not socket_path:
        print("Missing jobId or socketPath", file=sys.stderr)
        sys.exit(1)

    job = DonkeylabsJob(
        job_id=job_id,
        name=name or "unknown",
        data=data,
        socket_path=socket_path,
        heartbeat_interval=heartbeat_interval,
    )

    try:
        job.connect()

        # Run the handler
        result = handler(job)

        # Send completion
        job.complete(result)
    except Exception as e:
        import traceback

        job.fail(str(e), traceback.format_exc())
        sys.exit(1)
    finally:
        job.disconnect()


# Example job handler
def example_handler(job: DonkeylabsJob) -> Dict[str, Any]:
    """Example job handler that processes data in steps."""
    job.info(f"Starting job with data: {job.data}")

    total_steps = job.data.get("steps", 5)

    for i in range(total_steps):
        progress = (i / total_steps) * 100
        job.progress(progress, f"Processing step {i + 1} of {total_steps}")
        time.sleep(0.5)  # Simulate work

    job.progress(100, "Complete!")
    return {"processed": True, "steps": total_steps}


if __name__ == "__main__":
    # If run directly, use the example handler
    run_job(example_handler)
