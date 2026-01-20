<script lang="ts">
  /**
   * WatermarkEditor Component
   *
   * Configure and preview watermark positioning on images
   */

  type WatermarkPosition = "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

  interface WatermarkConfig {
    enabled: boolean;
    logoUrl?: string;
    position: WatermarkPosition;
    opacity: number;
    scale: number;
  }

  interface Props {
    /** Image source to preview watermark on */
    imageSrc: string;
    /** Watermark logo source (URL or data URL) */
    logoSrc?: string;
    /** Initial watermark configuration */
    initialConfig?: Partial<WatermarkConfig>;
    /** Callback when configuration changes */
    onChange?: (config: WatermarkConfig) => void;
    /** Callback when save is clicked */
    onSave?: (config: WatermarkConfig) => void;
    /** Callback when cancelled */
    onCancel?: () => void;
  }

  let {
    imageSrc,
    logoSrc,
    initialConfig,
    onChange,
    onSave,
    onCancel,
  }: Props = $props();

  let config = $state<WatermarkConfig>({
    enabled: true,
    logoUrl: logoSrc,
    position: "bottom-right",
    opacity: 0.5,
    scale: 0.2,
    ...initialConfig,
  });

  let imageLoaded = $state(false);
  let logoLoaded = $state(false);
  let imageRef: HTMLImageElement;
  let imageWidth = $state(0);
  let imageHeight = $state(0);

  const positions: { value: WatermarkPosition; label: string }[] = [
    { value: "top-left", label: "Top Left" },
    { value: "top-right", label: "Top Right" },
    { value: "center", label: "Center" },
    { value: "bottom-left", label: "Bottom Left" },
    { value: "bottom-right", label: "Bottom Right" },
  ];

  function handleImageLoad() {
    imageLoaded = true;
    if (imageRef) {
      imageWidth = imageRef.naturalWidth;
      imageHeight = imageRef.naturalHeight;
    }
  }

  function handleLogoLoad() {
    logoLoaded = true;
  }

  function updateConfig(updates: Partial<WatermarkConfig>) {
    config = { ...config, ...updates };
    onChange?.(config);
  }

  function handleSave() {
    onSave?.(config);
  }

  function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];

    if (file && file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = () => {
        updateConfig({ logoUrl: reader.result as string });
      };
      reader.readAsDataURL(file);
    }
  }

  // Calculate watermark position styles
  function getWatermarkStyles(): string {
    const size = `${config.scale * 100}%`;
    const baseStyles = `
      position: absolute;
      width: ${size};
      max-width: ${size};
      opacity: ${config.opacity};
    `;

    switch (config.position) {
      case "top-left":
        return `${baseStyles} top: 5%; left: 5%;`;
      case "top-right":
        return `${baseStyles} top: 5%; right: 5%;`;
      case "center":
        return `${baseStyles} top: 50%; left: 50%; transform: translate(-50%, -50%);`;
      case "bottom-left":
        return `${baseStyles} bottom: 5%; left: 5%;`;
      case "bottom-right":
        return `${baseStyles} bottom: 5%; right: 5%;`;
      default:
        return baseStyles;
    }
  }
</script>

<div class="watermark-editor">
  <div class="preview-section">
    <div class="preview-container">
      {#if !imageLoaded}
        <div class="loading">
          <div class="spinner"></div>
        </div>
      {/if}

      <img
        bind:this={imageRef}
        src={imageSrc}
        alt="Preview"
        class="preview-image"
        class:hidden={!imageLoaded}
        onload={handleImageLoad}
      />

      {#if config.enabled && config.logoUrl && imageLoaded}
        <img
          src={config.logoUrl}
          alt="Watermark"
          class="watermark-preview"
          style={getWatermarkStyles()}
          onload={handleLogoLoad}
        />
      {/if}
    </div>
  </div>

  <div class="controls-section">
    <div class="control-group">
      <label class="toggle-label">
        <input
          type="checkbox"
          checked={config.enabled}
          onchange={(e) => updateConfig({ enabled: (e.target as HTMLInputElement).checked })}
        />
        <span>Enable Watermark</span>
      </label>
    </div>

    <div class="control-group">
      <label>Watermark Image</label>
      <div class="logo-upload">
        {#if config.logoUrl}
          <img src={config.logoUrl} alt="Logo preview" class="logo-thumbnail" />
        {:else}
          <div class="logo-placeholder">No logo</div>
        {/if}
        <label class="upload-button">
          <input type="file" accept="image/*" onchange={handleFileSelect} />
          {config.logoUrl ? "Change" : "Upload"}
        </label>
      </div>
    </div>

    <div class="control-group">
      <label>Position</label>
      <div class="position-grid">
        {#each positions as pos}
          <button
            class="position-btn"
            class:active={config.position === pos.value}
            onclick={() => updateConfig({ position: pos.value })}
            disabled={!config.enabled}
          >
            {pos.label}
          </button>
        {/each}
      </div>
    </div>

    <div class="control-group">
      <label>Opacity: {Math.round(config.opacity * 100)}%</label>
      <input
        type="range"
        min="0.1"
        max="1"
        step="0.05"
        value={config.opacity}
        oninput={(e) => updateConfig({ opacity: parseFloat((e.target as HTMLInputElement).value) })}
        disabled={!config.enabled}
      />
    </div>

    <div class="control-group">
      <label>Size: {Math.round(config.scale * 100)}%</label>
      <input
        type="range"
        min="0.05"
        max="0.5"
        step="0.01"
        value={config.scale}
        oninput={(e) => updateConfig({ scale: parseFloat((e.target as HTMLInputElement).value) })}
        disabled={!config.enabled}
      />
    </div>

    <div class="actions">
      {#if onCancel}
        <button class="secondary" onclick={onCancel}>Cancel</button>
      {/if}
      {#if onSave}
        <button class="primary" onclick={handleSave}>
          Apply Watermark
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .watermark-editor {
    display: grid;
    grid-template-columns: 1fr 280px;
    gap: 1.5rem;
    background: var(--editor-bg, #f9fafb);
    border-radius: 0.5rem;
    padding: 1rem;
  }

  @media (max-width: 768px) {
    .watermark-editor {
      grid-template-columns: 1fr;
    }
  }

  .preview-section {
    min-height: 300px;
  }

  .preview-container {
    position: relative;
    background: var(--preview-bg, #e5e7eb);
    border-radius: 0.5rem;
    overflow: hidden;
    aspect-ratio: 16 / 10;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .spinner {
    width: 2rem;
    height: 2rem;
    border: 3px solid var(--spinner-track, #d1d5db);
    border-top-color: var(--spinner-color, #3b82f6);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .preview-image {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  .preview-image.hidden {
    opacity: 0;
  }

  .watermark-preview {
    pointer-events: none;
  }

  .controls-section {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .control-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .control-group > label {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--label-color, #374151);
  }

  .toggle-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }

  .toggle-label input {
    width: 1rem;
    height: 1rem;
    accent-color: var(--accent-color, #3b82f6);
  }

  .toggle-label span {
    font-weight: 500;
    color: var(--text-color, #374151);
  }

  .logo-upload {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .logo-thumbnail {
    width: 3rem;
    height: 3rem;
    object-fit: contain;
    background: #fff;
    border: 1px solid var(--border-color, #e5e7eb);
    border-radius: 0.25rem;
  }

  .logo-placeholder {
    width: 3rem;
    height: 3rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--placeholder-bg, #f3f4f6);
    border: 1px dashed var(--border-color, #d1d5db);
    border-radius: 0.25rem;
    font-size: 0.625rem;
    color: var(--text-muted, #9ca3af);
  }

  .upload-button {
    padding: 0.375rem 0.75rem;
    background: var(--button-bg, #f3f4f6);
    border: 1px solid var(--border-color, #e5e7eb);
    border-radius: 0.25rem;
    font-size: 0.75rem;
    color: var(--text-color, #374151);
    cursor: pointer;
  }

  .upload-button:hover {
    background: var(--button-hover-bg, #e5e7eb);
  }

  .upload-button input {
    display: none;
  }

  .position-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.375rem;
  }

  .position-btn {
    padding: 0.375rem 0.5rem;
    background: var(--button-bg, #f3f4f6);
    border: 1px solid var(--border-color, #e5e7eb);
    border-radius: 0.25rem;
    font-size: 0.75rem;
    color: var(--text-color, #374151);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .position-btn:hover:not(:disabled) {
    background: var(--button-hover-bg, #e5e7eb);
  }

  .position-btn.active {
    background: var(--accent-color, #3b82f6);
    border-color: var(--accent-color, #3b82f6);
    color: #fff;
  }

  .position-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  input[type="range"] {
    width: 100%;
    accent-color: var(--accent-color, #3b82f6);
  }

  input[type="range"]:disabled {
    opacity: 0.5;
  }

  .actions {
    display: flex;
    gap: 0.75rem;
    margin-top: auto;
    padding-top: 1rem;
    border-top: 1px solid var(--border-color, #e5e7eb);
  }

  .actions button {
    flex: 1;
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    cursor: pointer;
  }

  .actions button.secondary {
    background: var(--button-bg, #f3f4f6);
    color: var(--text-color, #374151);
  }

  .actions button.secondary:hover {
    background: var(--button-hover-bg, #e5e7eb);
  }

  .actions button.primary {
    background: var(--accent-color, #3b82f6);
    color: #fff;
  }

  .actions button.primary:hover {
    background: var(--accent-hover, #2563eb);
  }
</style>
