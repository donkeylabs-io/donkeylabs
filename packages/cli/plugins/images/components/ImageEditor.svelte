<script lang="ts">
  /**
   * ImageEditor Component
   *
   * Client-side image editing with crop, rotate, and resize using Canvas API
   */

  import { onMount, onDestroy } from "svelte";

  interface CropArea {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  interface Props {
    /** Image source (URL or data URL) */
    src: string;
    /** Aspect ratio constraint (e.g., 1 for square, 16/9 for widescreen) */
    aspectRatio?: number;
    /** Minimum crop size in pixels */
    minSize?: number;
    /** Output format */
    outputFormat?: "jpeg" | "png" | "webp";
    /** Output quality (0-1) */
    quality?: number;
    /** Callback when editing is complete */
    onSave?: (blob: Blob, dataUrl: string) => void;
    /** Callback when editing is cancelled */
    onCancel?: () => void;
  }

  let {
    src,
    aspectRatio,
    minSize = 50,
    outputFormat = "jpeg",
    quality = 0.9,
    onSave,
    onCancel,
  }: Props = $props();

  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let image: HTMLImageElement | null = null;
  let containerRef: HTMLDivElement;

  let rotation = $state(0);
  let scale = $state(1);
  let crop = $state<CropArea | null>(null);
  let isDragging = $state(false);
  let isResizing = $state(false);
  let dragStart = $state({ x: 0, y: 0 });
  let resizeHandle = $state<string | null>(null);

  let imageLoaded = $state(false);
  let displayWidth = $state(0);
  let displayHeight = $state(0);

  onMount(() => {
    loadImage();
  });

  async function loadImage() {
    image = new Image();
    image.crossOrigin = "anonymous";

    image.onload = () => {
      if (!image) return;

      // Calculate display size to fit container
      const container = containerRef.getBoundingClientRect();
      const maxWidth = container.width - 40;
      const maxHeight = 400;

      const imgRatio = image.width / image.height;
      const containerRatio = maxWidth / maxHeight;

      if (imgRatio > containerRatio) {
        displayWidth = maxWidth;
        displayHeight = maxWidth / imgRatio;
      } else {
        displayHeight = maxHeight;
        displayWidth = maxHeight * imgRatio;
      }

      // Initialize crop to full image
      initCrop();
      imageLoaded = true;
      draw();
    };

    image.src = src;
  }

  function initCrop() {
    const padding = 20;
    let cropWidth = displayWidth - padding * 2;
    let cropHeight = displayHeight - padding * 2;

    if (aspectRatio) {
      if (cropWidth / cropHeight > aspectRatio) {
        cropWidth = cropHeight * aspectRatio;
      } else {
        cropHeight = cropWidth / aspectRatio;
      }
    }

    crop = {
      x: (displayWidth - cropWidth) / 2,
      y: (displayHeight - cropHeight) / 2,
      width: cropWidth,
      height: cropHeight,
    };
  }

  function draw() {
    if (!canvas || !ctx || !image) return;

    canvas.width = displayWidth;
    canvas.height = displayHeight;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw image
    ctx.save();
    ctx.translate(displayWidth / 2, displayHeight / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.scale(scale, scale);
    ctx.drawImage(image, -displayWidth / 2, -displayHeight / 2, displayWidth, displayHeight);
    ctx.restore();

    // Draw crop overlay
    if (crop) {
      // Darken outside crop area
      ctx.fillStyle = "rgba(0, 0, 0, 0.5)";

      // Top
      ctx.fillRect(0, 0, canvas.width, crop.y);
      // Bottom
      ctx.fillRect(0, crop.y + crop.height, canvas.width, canvas.height - crop.y - crop.height);
      // Left
      ctx.fillRect(0, crop.y, crop.x, crop.height);
      // Right
      ctx.fillRect(crop.x + crop.width, crop.y, canvas.width - crop.x - crop.width, crop.height);

      // Crop border
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.strokeRect(crop.x, crop.y, crop.width, crop.height);

      // Grid lines (rule of thirds)
      ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
      ctx.lineWidth = 1;
      const thirdW = crop.width / 3;
      const thirdH = crop.height / 3;

      ctx.beginPath();
      ctx.moveTo(crop.x + thirdW, crop.y);
      ctx.lineTo(crop.x + thirdW, crop.y + crop.height);
      ctx.moveTo(crop.x + thirdW * 2, crop.y);
      ctx.lineTo(crop.x + thirdW * 2, crop.y + crop.height);
      ctx.moveTo(crop.x, crop.y + thirdH);
      ctx.lineTo(crop.x + crop.width, crop.y + thirdH);
      ctx.moveTo(crop.x, crop.y + thirdH * 2);
      ctx.lineTo(crop.x + crop.width, crop.y + thirdH * 2);
      ctx.stroke();

      // Resize handles
      const handleSize = 10;
      ctx.fillStyle = "#fff";
      const handles = [
        { x: crop.x, y: crop.y },
        { x: crop.x + crop.width, y: crop.y },
        { x: crop.x, y: crop.y + crop.height },
        { x: crop.x + crop.width, y: crop.y + crop.height },
      ];

      handles.forEach((h) => {
        ctx!.fillRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
      });
    }
  }

  function handleMouseDown(e: MouseEvent) {
    if (!crop) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Check if clicking on resize handle
    const handleSize = 15;
    const handles = [
      { name: "nw", x: crop.x, y: crop.y },
      { name: "ne", x: crop.x + crop.width, y: crop.y },
      { name: "sw", x: crop.x, y: crop.y + crop.height },
      { name: "se", x: crop.x + crop.width, y: crop.y + crop.height },
    ];

    for (const h of handles) {
      if (Math.abs(x - h.x) < handleSize && Math.abs(y - h.y) < handleSize) {
        isResizing = true;
        resizeHandle = h.name;
        dragStart = { x, y };
        return;
      }
    }

    // Check if clicking inside crop area
    if (x >= crop.x && x <= crop.x + crop.width && y >= crop.y && y <= crop.y + crop.height) {
      isDragging = true;
      dragStart = { x: x - crop.x, y: y - crop.y };
    }
  }

  function handleMouseMove(e: MouseEvent) {
    if (!crop) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (isDragging) {
      let newX = x - dragStart.x;
      let newY = y - dragStart.y;

      // Constrain to canvas
      newX = Math.max(0, Math.min(displayWidth - crop.width, newX));
      newY = Math.max(0, Math.min(displayHeight - crop.height, newY));

      crop = { ...crop, x: newX, y: newY };
      draw();
    } else if (isResizing && resizeHandle) {
      let newCrop = { ...crop };

      switch (resizeHandle) {
        case "nw":
          const nwDx = x - crop.x;
          const nwDy = aspectRatio ? nwDx / aspectRatio : y - crop.y;
          newCrop.width = Math.max(minSize, crop.width - nwDx);
          newCrop.height = aspectRatio ? newCrop.width / aspectRatio : Math.max(minSize, crop.height - nwDy);
          newCrop.x = crop.x + crop.width - newCrop.width;
          newCrop.y = crop.y + crop.height - newCrop.height;
          break;
        case "ne":
          newCrop.width = Math.max(minSize, x - crop.x);
          newCrop.height = aspectRatio ? newCrop.width / aspectRatio : Math.max(minSize, crop.height - (y - crop.y));
          if (!aspectRatio) newCrop.y = y;
          break;
        case "sw":
          const swDx = crop.x - x;
          newCrop.width = Math.max(minSize, crop.width + swDx);
          newCrop.height = aspectRatio ? newCrop.width / aspectRatio : Math.max(minSize, y - crop.y);
          newCrop.x = x;
          break;
        case "se":
          newCrop.width = Math.max(minSize, x - crop.x);
          newCrop.height = aspectRatio ? newCrop.width / aspectRatio : Math.max(minSize, y - crop.y);
          break;
      }

      // Constrain to canvas
      newCrop.x = Math.max(0, newCrop.x);
      newCrop.y = Math.max(0, newCrop.y);
      newCrop.width = Math.min(displayWidth - newCrop.x, newCrop.width);
      newCrop.height = Math.min(displayHeight - newCrop.y, newCrop.height);

      crop = newCrop;
      draw();
    }
  }

  function handleMouseUp() {
    isDragging = false;
    isResizing = false;
    resizeHandle = null;
  }

  function rotate(degrees: number) {
    rotation = (rotation + degrees) % 360;
    draw();
  }

  function resetCrop() {
    initCrop();
    rotation = 0;
    scale = 1;
    draw();
  }

  async function save() {
    if (!image || !crop) return;

    // Create output canvas
    const outputCanvas = document.createElement("canvas");
    const outputCtx = outputCanvas.getContext("2d");
    if (!outputCtx) return;

    // Calculate scale from display to actual image
    const scaleX = image.width / displayWidth;
    const scaleY = image.height / displayHeight;

    // Set output size based on crop
    outputCanvas.width = crop.width * scaleX;
    outputCanvas.height = crop.height * scaleY;

    // Draw cropped portion
    outputCtx.save();
    outputCtx.translate(outputCanvas.width / 2, outputCanvas.height / 2);
    outputCtx.rotate((rotation * Math.PI) / 180);
    outputCtx.scale(scale, scale);

    const cropX = crop.x * scaleX;
    const cropY = crop.y * scaleY;
    const cropW = crop.width * scaleX;
    const cropH = crop.height * scaleY;

    outputCtx.drawImage(
      image,
      cropX,
      cropY,
      cropW,
      cropH,
      -outputCanvas.width / 2,
      -outputCanvas.height / 2,
      outputCanvas.width,
      outputCanvas.height
    );
    outputCtx.restore();

    // Convert to blob
    const mimeType = `image/${outputFormat}`;
    const dataUrl = outputCanvas.toDataURL(mimeType, quality);

    outputCanvas.toBlob(
      (blob) => {
        if (blob) {
          onSave?.(blob, dataUrl);
        }
      },
      mimeType,
      quality
    );
  }

  $effect(() => {
    if (canvas) {
      ctx = canvas.getContext("2d");
    }
  });
</script>

<div class="image-editor" bind:this={containerRef}>
  {#if !imageLoaded}
    <div class="loading">
      <div class="spinner"></div>
      <p>Loading image...</p>
    </div>
  {:else}
    <div class="canvas-container">
      <canvas
        bind:this={canvas}
        onmousedown={handleMouseDown}
        onmousemove={handleMouseMove}
        onmouseup={handleMouseUp}
        onmouseleave={handleMouseUp}
      ></canvas>
    </div>

    <div class="controls">
      <div class="control-group">
        <label>Rotation</label>
        <div class="button-group">
          <button onclick={() => rotate(-90)} title="Rotate left">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M2.5 2v6h6M2.66 15.57a10 10 0 1 0 .57-8.38" />
            </svg>
          </button>
          <button onclick={() => rotate(90)} title="Rotate right">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38" />
            </svg>
          </button>
        </div>
      </div>

      <div class="control-group">
        <label>Zoom: {Math.round(scale * 100)}%</label>
        <input
          type="range"
          min="0.5"
          max="2"
          step="0.1"
          bind:value={scale}
          oninput={() => draw()}
        />
      </div>

      <div class="control-group">
        <button class="text-button" onclick={resetCrop}>Reset</button>
      </div>
    </div>

    <div class="actions">
      <button class="secondary" onclick={onCancel}>Cancel</button>
      <button class="primary" onclick={save}>Save</button>
    </div>
  {/if}
</div>

<style>
  .image-editor {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    background: var(--editor-bg, #1a1a1a);
    border-radius: 0.5rem;
    padding: 1rem;
  }

  .loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 300px;
    color: #fff;
  }

  .spinner {
    width: 2rem;
    height: 2rem;
    border: 3px solid rgba(255, 255, 255, 0.2);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .canvas-container {
    display: flex;
    justify-content: center;
    align-items: center;
    background: #000;
    border-radius: 0.25rem;
    overflow: hidden;
  }

  canvas {
    cursor: crosshair;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    flex-wrap: wrap;
  }

  .control-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .control-group label {
    font-size: 0.875rem;
    color: #a1a1aa;
    min-width: 80px;
  }

  .button-group {
    display: flex;
    gap: 0.25rem;
  }

  .button-group button {
    width: 2rem;
    height: 2rem;
    padding: 0.375rem;
    background: #3f3f46;
    border: none;
    border-radius: 0.25rem;
    cursor: pointer;
    color: #fff;
  }

  .button-group button:hover {
    background: #52525b;
  }

  .button-group button svg {
    width: 100%;
    height: 100%;
  }

  input[type="range"] {
    width: 120px;
    accent-color: var(--accent-color, #3b82f6);
  }

  .text-button {
    background: transparent;
    border: none;
    color: #a1a1aa;
    font-size: 0.875rem;
    cursor: pointer;
    padding: 0.25rem 0.5rem;
  }

  .text-button:hover {
    color: #fff;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    padding-top: 0.5rem;
    border-top: 1px solid #3f3f46;
  }

  .actions button {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    cursor: pointer;
  }

  .actions button.secondary {
    background: #3f3f46;
    color: #fff;
  }

  .actions button.secondary:hover {
    background: #52525b;
  }

  .actions button.primary {
    background: var(--accent-color, #3b82f6);
    color: #fff;
  }

  .actions button.primary:hover {
    background: var(--accent-hover, #2563eb);
  }
</style>
