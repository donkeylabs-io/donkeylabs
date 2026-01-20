<script lang="ts">
  /**
   * ImageGallery Component
   *
   * Grid display of uploaded images with actions
   */

  interface ImageRecord {
    id: string;
    filename: string;
    originalFilename: string;
    mimeType: string;
    size: number;
    status: string;
    width: number | null;
    height: number | null;
    format: string | null;
    variants: string | null;
    createdAt: string;
  }

  interface Props {
    /** Base URL for API calls */
    baseUrl?: string;
    /** Pre-loaded images (if not using fetch) */
    images?: ImageRecord[];
    /** User ID to filter by */
    userId?: string;
    /** Number of images per page */
    pageSize?: number;
    /** Callback when image is selected */
    onSelect?: (image: ImageRecord) => void;
    /** Callback when image is deleted */
    onDelete?: (imageId: string) => void;
    /** Show delete button */
    showDelete?: boolean;
    /** Image variant to display (thumbnail, medium, or original) */
    variant?: string;
  }

  let {
    baseUrl = "",
    images: propImages,
    userId,
    pageSize = 20,
    onSelect,
    onDelete,
    showDelete = true,
    variant = "thumbnail",
  }: Props = $props();

  let images = $state<ImageRecord[]>(propImages || []);
  let loading = $state(!propImages);
  let error = $state<string | null>(null);
  let page = $state(1);
  let totalPages = $state(1);
  let imageUrls = $state<Map<string, string>>(new Map());

  $effect(() => {
    if (!propImages) {
      fetchImages();
    }
  });

  async function fetchImages() {
    loading = true;
    error = null;

    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: pageSize.toString(),
        status: "completed",
      });

      if (userId) {
        params.set("userId", userId);
      }

      const response = await fetch(`${baseUrl}/images.list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page,
          limit: pageSize,
          status: "completed",
          userId,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to fetch images");
      }

      const data = await response.json();
      images = data.images;
      totalPages = data.totalPages;

      // Fetch URLs for each image
      await Promise.all(images.map((img) => fetchImageUrl(img.id)));
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to load images";
    } finally {
      loading = false;
    }
  }

  async function fetchImageUrl(imageId: string) {
    try {
      const response = await fetch(`${baseUrl}/images.url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageId, variant }),
      });

      if (response.ok) {
        const data = await response.json();
        imageUrls = new Map(imageUrls).set(imageId, data.url);
      }
    } catch {
      // Ignore URL fetch errors
    }
  }

  async function handleDelete(imageId: string, e: Event) {
    e.stopPropagation();

    if (!confirm("Are you sure you want to delete this image?")) {
      return;
    }

    try {
      const response = await fetch(`${baseUrl}/images.delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageId }),
      });

      if (!response.ok) {
        throw new Error("Failed to delete image");
      }

      images = images.filter((img) => img.id !== imageId);
      onDelete?.(imageId);
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to delete image";
    }
  }

  function handleImageClick(image: ImageRecord) {
    onSelect?.(image);
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function nextPage() {
    if (page < totalPages) {
      page++;
      fetchImages();
    }
  }

  function prevPage() {
    if (page > 1) {
      page--;
      fetchImages();
    }
  }
</script>

<div class="image-gallery">
  {#if loading}
    <div class="loading">
      <div class="spinner"></div>
      <p>Loading images...</p>
    </div>
  {:else if error}
    <div class="error">
      <p>{error}</p>
      <button onclick={fetchImages}>Retry</button>
    </div>
  {:else if images.length === 0}
    <div class="empty">
      <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
      <p>No images found</p>
    </div>
  {:else}
    <div class="gallery-grid">
      {#each images as image}
        <div
          class="gallery-item"
          role="button"
          tabindex="0"
          onclick={() => handleImageClick(image)}
          onkeydown={(e) => e.key === "Enter" && handleImageClick(image)}
        >
          <div class="image-container">
            {#if imageUrls.has(image.id)}
              <img src={imageUrls.get(image.id)} alt={image.originalFilename} loading="lazy" />
            {:else}
              <div class="image-placeholder">
                <div class="spinner small"></div>
              </div>
            {/if}
          </div>

          <div class="image-info">
            <span class="image-name" title={image.originalFilename}>
              {image.originalFilename}
            </span>
            <span class="image-meta">
              {#if image.width && image.height}
                {image.width}x{image.height} &middot;
              {/if}
              {formatSize(image.size)}
            </span>
          </div>

          {#if showDelete}
            <button
              class="delete-button"
              onclick={(e) => handleDelete(image.id, e)}
              aria-label="Delete image"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          {/if}
        </div>
      {/each}
    </div>

    {#if totalPages > 1}
      <div class="pagination">
        <button onclick={prevPage} disabled={page === 1}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Previous
        </button>
        <span class="page-info">
          Page {page} of {totalPages}
        </span>
        <button onclick={nextPage} disabled={page === totalPages}>
          Next
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .image-gallery {
    width: 100%;
  }

  .loading,
  .error,
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 3rem;
    text-align: center;
    color: var(--text-muted, #6b7280);
  }

  .spinner {
    width: 2rem;
    height: 2rem;
    border: 3px solid var(--spinner-track, #e5e7eb);
    border-top-color: var(--spinner-color, #3b82f6);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .spinner.small {
    width: 1.5rem;
    height: 1.5rem;
    border-width: 2px;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .error button {
    margin-top: 1rem;
    padding: 0.5rem 1rem;
    background: var(--button-bg, #3b82f6);
    color: white;
    border: none;
    border-radius: 0.375rem;
    cursor: pointer;
  }

  .empty-icon {
    width: 3rem;
    height: 3rem;
    color: var(--icon-muted, #9ca3af);
    margin-bottom: 0.5rem;
  }

  .gallery-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 1rem;
  }

  .gallery-item {
    position: relative;
    background: var(--card-bg, #f9fafb);
    border-radius: 0.5rem;
    overflow: hidden;
    cursor: pointer;
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  }

  .gallery-item:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  }

  .gallery-item:focus {
    outline: 2px solid var(--focus-color, #3b82f6);
    outline-offset: 2px;
  }

  .image-container {
    aspect-ratio: 1;
    overflow: hidden;
    background: var(--placeholder-bg, #e5e7eb);
  }

  .image-container img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .image-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .image-info {
    padding: 0.75rem;
  }

  .image-name {
    display: block;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-color, #374151);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .image-meta {
    display: block;
    font-size: 0.75rem;
    color: var(--text-muted, #6b7280);
    margin-top: 0.25rem;
  }

  .delete-button {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    width: 2rem;
    height: 2rem;
    padding: 0.375rem;
    background: rgba(255, 255, 255, 0.9);
    border: none;
    border-radius: 0.375rem;
    cursor: pointer;
    color: var(--text-muted, #6b7280);
    opacity: 0;
    transition: opacity 0.2s ease, color 0.2s ease;
  }

  .gallery-item:hover .delete-button {
    opacity: 1;
  }

  .delete-button:hover {
    color: var(--error-color, #ef4444);
  }

  .delete-button svg {
    width: 100%;
    height: 100%;
  }

  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border-color, #e5e7eb);
  }

  .pagination button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: var(--button-bg, #f3f4f6);
    color: var(--text-color, #374151);
    border: none;
    border-radius: 0.375rem;
    cursor: pointer;
    font-size: 0.875rem;
  }

  .pagination button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .pagination button:not(:disabled):hover {
    background: var(--button-hover-bg, #e5e7eb);
  }

  .pagination button svg {
    width: 1rem;
    height: 1rem;
  }

  .page-info {
    font-size: 0.875rem;
    color: var(--text-muted, #6b7280);
  }
</style>
