<script lang="ts">
  import { onMount } from 'svelte';

  let health = $state<{ status: string; timestamp?: string; uptime?: number } | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);

  onMount(async () => {
    try {
      const res = await fetch('/api.health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      health = await res.json();
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  });
</script>

<svelte:head>
  <title>test-app</title>
</svelte:head>

<div class="min-h-screen bg-gray-50">
  <div class="container mx-auto max-w-4xl py-16 px-4">
    <div class="text-center mb-12">
      <h1 class="text-4xl font-bold tracking-tight text-gray-900">test-app</h1>
      <p class="text-gray-600 mt-2 text-lg">Built with DonkeyLabs</p>
    </div>

    <div class="bg-white rounded-xl shadow-sm border p-6 mb-6">
      <h2 class="text-xl font-semibold mb-4">Server Status</h2>
      {#if loading}
        <div class="text-gray-500">Checking server...</div>
      {:else if error}
        <div class="flex items-center gap-2 text-red-600">
          <span class="w-3 h-3 bg-red-500 rounded-full"></span>
          Error: {error}
        </div>
      {:else if health}
        <div class="flex items-center gap-2 text-green-600">
          <span class="w-3 h-3 bg-green-500 rounded-full"></span>
          {health.status}
        </div>
        {#if health.timestamp}
          <p class="text-gray-500 text-sm mt-2">Last checked: {new Date(health.timestamp).toLocaleString()}</p>
        {/if}
        {#if health.uptime}
          <p class="text-gray-500 text-sm">Uptime: {Math.floor(health.uptime)}s</p>
        {/if}
      {/if}
    </div>

    <div class="bg-white rounded-xl shadow-sm border p-6 mb-6">
      <h2 class="text-xl font-semibold mb-4">Getting Started</h2>
      <ol class="list-decimal list-inside space-y-2 text-gray-700">
        <li>Edit <code class="bg-gray-100 px-2 py-0.5 rounded text-sm">src/server/routes/api.ts</code> to add API routes</li>
        <li>Edit <code class="bg-gray-100 px-2 py-0.5 rounded text-sm">src/routes/+page.svelte</code> to customize this page</li>
        <li>Run <code class="bg-gray-100 px-2 py-0.5 rounded text-sm">bun run gen:types</code> to generate typed API client</li>
      </ol>
    </div>

    <div class="bg-white rounded-xl shadow-sm border p-6">
      <h2 class="text-xl font-semibold mb-4">Project Info</h2>
      <ul class="space-y-2 text-gray-700">
        <li><strong>Database:</strong> sqlite</li>
        <li><strong>Plugins:</strong> users</li>
        <li><strong>Deployment:</strong> binary</li>
      </ul>
    </div>
  </div>
</div>
