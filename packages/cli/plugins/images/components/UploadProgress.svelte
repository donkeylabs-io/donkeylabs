<script lang="ts">
  /**
   * UploadProgress Component
   *
   * Displays real-time upload and processing progress via SSE
   */

  import { onMount, onDestroy } from "svelte";

  interface Props {
    imageId: string;
    baseUrl?: string;
    onComplete?: (data: { imageId: string; url: string; variants?: Record<string, unknown> }) => void;
    onError?: (data: { imageId: string; error: string; stage?: string }) => void;
  }

  let { imageId, baseUrl = "", onComplete, onError }: Props = $props();

  let progress = $state(0);
  let stage = $state<string | null>(null);
  let message = $state<string | null>(null);
  let status = $state<"idle" | "connecting" | "processing" | "completed" | "failed">("idle");
  let error = $state<string | null>(null);

  let eventSource: EventSource | null = null;

  const stageLabels: Record<string, string> = {
    validating: "Validating image",
    downloading: "Downloading",
    optimizing: "Optimizing",
    "creating-variants": "Creating variants",
    "applying-watermark": "Applying watermark",
    uploading: "Uploading",
    finalizing: "Finalizing",
  };

  onMount(() => {
    connect();
  });

  onDestroy(() => {
    disconnect();
  });

  function connect() {
    if (eventSource) {
      eventSource.close();
    }

    status = "connecting";
    const url = `${baseUrl}/images.subscribe?imageId=${encodeURIComponent(imageId)}`;
    eventSource = new EventSource(url);

    eventSource.onopen = () => {
      status = "processing";
    };

    eventSource.onerror = () => {
      status = "failed";
      error = "Connection lost";
    };

    eventSource.addEventListener("image.processing.progress", (event) => {
      const data = JSON.parse(event.data);
      progress = data.progress;
      stage = data.stage;
      message = data.message;
      status = "processing";
    });

    eventSource.addEventListener("image.upload.completed", (event) => {
      const data = JSON.parse(event.data);
      progress = 100;
      status = "completed";
      disconnect();
      onComplete?.(data);
    });

    eventSource.addEventListener("image.upload.failed", (event) => {
      const data = JSON.parse(event.data);
      status = "failed";
      error = data.error;
      stage = data.stage;
      disconnect();
      onError?.(data);
    });
  }

  function disconnect() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }
</script>

<div class="upload-progress" data-status={status}>
  <div class="progress-header">
    <span class="progress-label">
      {#if status === "connecting"}
        Connecting...
      {:else if status === "completed"}
        Upload Complete
      {:else if status === "failed"}
        Upload Failed
      {:else if stage}
        {stageLabels[stage] || stage}
      {:else}
        Processing...
      {/if}
    </span>
    <span class="progress-value">{Math.round(progress)}%</span>
  </div>

  <div class="progress-bar-container">
    <div
      class="progress-bar"
      style="width: {progress}%"
      class:completed={status === "completed"}
      class:failed={status === "failed"}
    ></div>
  </div>

  {#if message && status === "processing"}
    <p class="progress-message">{message}</p>
  {/if}

  {#if error}
    <p class="progress-error">{error}</p>
  {/if}
</div>

<style>
  .upload-progress {
    width: 100%;
    padding: 1rem;
    border-radius: 0.5rem;
    background: var(--progress-bg, #f5f5f5);
  }

  .progress-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .progress-label {
    font-weight: 500;
    color: var(--progress-label-color, #333);
  }

  .progress-value {
    font-size: 0.875rem;
    color: var(--progress-value-color, #666);
    font-variant-numeric: tabular-nums;
  }

  .progress-bar-container {
    height: 8px;
    background: var(--progress-track-color, #e0e0e0);
    border-radius: 4px;
    overflow: hidden;
  }

  .progress-bar {
    height: 100%;
    background: var(--progress-bar-color, #3b82f6);
    border-radius: 4px;
    transition: width 0.3s ease;
  }

  .progress-bar.completed {
    background: var(--progress-complete-color, #22c55e);
  }

  .progress-bar.failed {
    background: var(--progress-error-color, #ef4444);
  }

  .progress-message {
    margin-top: 0.5rem;
    font-size: 0.875rem;
    color: var(--progress-message-color, #666);
  }

  .progress-error {
    margin-top: 0.5rem;
    font-size: 0.875rem;
    color: var(--progress-error-color, #ef4444);
  }

  [data-status="completed"] .progress-label {
    color: var(--progress-complete-color, #22c55e);
  }

  [data-status="failed"] .progress-label {
    color: var(--progress-error-color, #ef4444);
  }
</style>
