<script lang="ts">
  /**
   * ImageUploader Component
   *
   * Drag-and-drop image upload with SSE progress tracking
   */

  import { onDestroy } from "svelte";
  import UploadProgress from "./UploadProgress.svelte";

  interface Props {
    /** Base URL for API calls (e.g., '/api' or 'https://api.example.com') */
    baseUrl?: string;
    /** Maximum file size in bytes (default: 10MB) */
    maxSize?: number;
    /** Allowed MIME types */
    allowedTypes?: string[];
    /** Whether to auto-process after upload */
    autoProcess?: boolean;
    /** User ID to associate with uploads */
    userId?: string;
    /** Callback when upload completes */
    onUpload?: (data: { imageId: string; url: string; variants?: Record<string, unknown> }) => void;
    /** Callback when upload fails */
    onError?: (error: { message: string; imageId?: string }) => void;
    /** Allow multiple files */
    multiple?: boolean;
  }

  let {
    baseUrl = "",
    maxSize = 10 * 1024 * 1024,
    allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"],
    autoProcess = true,
    userId,
    onUpload,
    onError,
    multiple = false,
  }: Props = $props();

  let isDragging = $state(false);
  let uploads = $state<Map<string, { file: File; imageId: string; status: string }>>(new Map());
  let fileInput: HTMLInputElement;

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function validateFile(file: File): string | null {
    if (!allowedTypes.includes(file.type)) {
      return `Invalid file type. Allowed: ${allowedTypes.map((t) => t.split("/")[1]).join(", ")}`;
    }
    if (file.size > maxSize) {
      return `File too large. Maximum: ${formatSize(maxSize)}`;
    }
    return null;
  }

  async function uploadFile(file: File) {
    const error = validateFile(file);
    if (error) {
      onError?.({ message: error });
      return;
    }

    try {
      // Initialize upload
      const initResponse = await fetch(`${baseUrl}/images.upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          mimeType: file.type,
          size: file.size,
          userId,
        }),
      });

      if (!initResponse.ok) {
        const err = await initResponse.json();
        throw new Error(err.error || "Failed to initialize upload");
      }

      const { imageId, uploadUrl } = await initResponse.json();

      // Track this upload
      uploads = new Map(uploads).set(imageId, {
        file,
        imageId,
        status: "uploading",
      });

      // Upload directly to S3
      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });

      if (!uploadResponse.ok) {
        throw new Error("Failed to upload to S3");
      }

      // Update status
      uploads = new Map(uploads).set(imageId, {
        file,
        imageId,
        status: "uploaded",
      });

      // Auto-process if enabled
      if (autoProcess) {
        uploads = new Map(uploads).set(imageId, {
          file,
          imageId,
          status: "processing",
        });

        await fetch(`${baseUrl}/images.process`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageId }),
        });
      }
    } catch (err) {
      onError?.({
        message: err instanceof Error ? err.message : "Upload failed",
      });
    }
  }

  function handleDragEnter(e: DragEvent) {
    e.preventDefault();
    isDragging = true;
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    isDragging = false;
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    isDragging = false;

    const files = Array.from(e.dataTransfer?.files || []);
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));

    if (!multiple && imageFiles.length > 1) {
      imageFiles.splice(1);
    }

    imageFiles.forEach(uploadFile);
  }

  function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    files.forEach(uploadFile);
    input.value = "";
  }

  function handleUploadComplete(data: { imageId: string; url: string; variants?: Record<string, unknown> }) {
    const upload = uploads.get(data.imageId);
    if (upload) {
      uploads = new Map(uploads).set(data.imageId, {
        ...upload,
        status: "completed",
      });
    }
    onUpload?.(data);
  }

  function handleUploadError(data: { imageId: string; error: string }) {
    const upload = uploads.get(data.imageId);
    if (upload) {
      uploads = new Map(uploads).set(data.imageId, {
        ...upload,
        status: "failed",
      });
    }
    onError?.({ message: data.error, imageId: data.imageId });
  }

  function removeUpload(imageId: string) {
    const newUploads = new Map(uploads);
    newUploads.delete(imageId);
    uploads = newUploads;
  }

  function openFilePicker() {
    fileInput?.click();
  }
</script>

<div class="image-uploader">
  <div
    class="dropzone"
    class:dragging={isDragging}
    role="button"
    tabindex="0"
    ondragenter={handleDragEnter}
    ondragleave={handleDragLeave}
    ondragover={handleDragOver}
    ondrop={handleDrop}
    onclick={openFilePicker}
    onkeydown={(e) => e.key === "Enter" && openFilePicker()}
  >
    <input
      bind:this={fileInput}
      type="file"
      accept={allowedTypes.join(",")}
      {multiple}
      onchange={handleFileSelect}
      class="file-input"
    />

    <div class="dropzone-content">
      <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>
      <p class="dropzone-text">
        {#if isDragging}
          Drop images here
        {:else}
          Drag and drop images here, or click to select
        {/if}
      </p>
      <p class="dropzone-hint">
        Max {formatSize(maxSize)} per file
      </p>
    </div>
  </div>

  {#if uploads.size > 0}
    <div class="upload-list">
      {#each [...uploads.entries()] as [imageId, upload]}
        <div class="upload-item">
          <div class="upload-info">
            <span class="upload-filename">{upload.file.name}</span>
            <span class="upload-size">{formatSize(upload.file.size)}</span>
          </div>

          {#if upload.status === "processing"}
            <UploadProgress
              {imageId}
              {baseUrl}
              onComplete={handleUploadComplete}
              onError={handleUploadError}
            />
          {:else if upload.status === "completed"}
            <div class="upload-status completed">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Completed
            </div>
          {:else if upload.status === "failed"}
            <div class="upload-status failed">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              Failed
            </div>
          {:else}
            <div class="upload-status uploading">Uploading to S3...</div>
          {/if}

          <button
            class="remove-button"
            onclick={() => removeUpload(imageId)}
            aria-label="Remove upload"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .image-uploader {
    width: 100%;
  }

  .dropzone {
    border: 2px dashed var(--dropzone-border, #d1d5db);
    border-radius: 0.75rem;
    padding: 2rem;
    text-align: center;
    cursor: pointer;
    transition: all 0.2s ease;
    background: var(--dropzone-bg, #fafafa);
  }

  .dropzone:hover,
  .dropzone.dragging {
    border-color: var(--dropzone-active-border, #3b82f6);
    background: var(--dropzone-active-bg, #eff6ff);
  }

  .dropzone:focus {
    outline: 2px solid var(--dropzone-focus, #3b82f6);
    outline-offset: 2px;
  }

  .file-input {
    display: none;
  }

  .dropzone-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }

  .upload-icon {
    width: 3rem;
    height: 3rem;
    color: var(--icon-color, #9ca3af);
  }

  .dropzone.dragging .upload-icon {
    color: var(--icon-active-color, #3b82f6);
  }

  .dropzone-text {
    font-size: 1rem;
    color: var(--text-color, #374151);
    margin: 0;
  }

  .dropzone-hint {
    font-size: 0.875rem;
    color: var(--hint-color, #9ca3af);
    margin: 0;
  }

  .upload-list {
    margin-top: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .upload-item {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1rem;
    background: var(--item-bg, #f9fafb);
    border-radius: 0.5rem;
    position: relative;
  }

  .upload-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .upload-filename {
    font-weight: 500;
    color: var(--text-color, #374151);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .upload-size {
    font-size: 0.875rem;
    color: var(--hint-color, #9ca3af);
    flex-shrink: 0;
  }

  .upload-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
  }

  .upload-status svg {
    width: 1rem;
    height: 1rem;
  }

  .upload-status.completed {
    color: var(--success-color, #22c55e);
  }

  .upload-status.failed {
    color: var(--error-color, #ef4444);
  }

  .upload-status.uploading {
    color: var(--info-color, #3b82f6);
  }

  .remove-button {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    width: 1.5rem;
    height: 1.5rem;
    border: none;
    background: transparent;
    cursor: pointer;
    padding: 0;
    color: var(--hint-color, #9ca3af);
    border-radius: 0.25rem;
  }

  .remove-button:hover {
    color: var(--error-color, #ef4444);
  }

  .remove-button svg {
    width: 100%;
    height: 100%;
  }
</style>
