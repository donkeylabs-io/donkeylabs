<script lang="ts">
  import { browser } from "$app/environment";
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import type { Routes } from "$lib/api";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card";
  import { Input } from "$lib/components/ui/input";
  import { Badge } from "$lib/components/ui/badge";
  import { createApi } from "$lib/api";

  // Type for cron tasks returned by the API
  interface CronTask {
    id: string;
    name: string;
    expression: string;
    enabled: boolean;
    lastRun?: string;
    nextRun?: string;
  }

  let { data } = $props();

  // Create typed API client (browser mode - no locals)
  const client = createApi();

  // SSE Events state
  let events = $state<
    Array<{ id: number; message: string; timestamp: string; source?: string }>
  >([]);
  let sseConnected = $state(false);
  let sseClients = $state({ total: 0, byChannel: 0 });

  // Counter state
  let count = $state(data.count);
  let counterLoading = $state(false);

  // Cache state
  let cacheKey = $state("demo-key");
  let cacheValue = $state("Hello World");
  let cacheTTL = $state(30000);
  let cacheResult = $state<any>(null);
  let cacheKeys = $state<string[]>([]);

  // Jobs state
  let jobMessage = $state("Test job");
  let jobDelay = $state(0);
  let jobStats = $state({ pending: 0, running: 0, completed: 0 });
  let lastJobId = $state<string | null>(null);

  // Rate Limiter state
  let rateLimitKey = $state("demo");
  let rateLimitMax = $state(5);
  let rateLimitWindow = $state(60000);
  let rateLimitResult = $state<any>(null);

  // Cron state
  let cronTasks = $state<CronTask[]>([]);

  // Events (pub/sub) state
  let eventName = $state("demo.test");
  let eventData = $state('{"hello": "world"}');

  // Counter actions - using typed client
  async function counterAction(
    action: "get" | "increment" | "decrement" | "reset",
  ) {
    counterLoading = true;

    const result = await client.api.counter[action]({});
    count = result.count;
    counterLoading = false;
  }

  // Cache actions - using typed client
  async function cacheSet() {
    await client.api.cache.set({ key: cacheKey, value: cacheValue, ttl: cacheTTL });
    cacheResult = { action: "set", success: true };
    refreshCacheKeys();
  }

  async function cacheGet() {
    cacheResult = await client.api.cache.get({ key: cacheKey });
    refreshCacheKeys();
  }

  async function cacheDelete() {
    await client.api.cache.delete({ key: cacheKey });
    cacheResult = { action: "deleted", success: true };
    refreshCacheKeys();
  }

  async function refreshCacheKeys() {
    const result = await client.api.cache.keys({});
    cacheKeys = result.keys || [];
  }

  // Jobs actions - using typed client
  async function enqueueJob() {
    const result = (await client.api.jobs.enqueue({
      name: "demo-job",
      data: { message: jobMessage },
      delay: jobDelay > 0 ? jobDelay : undefined,
    })) as { jobId: string };
    lastJobId = result.jobId;
    refreshJobStats();
  }

  async function refreshJobStats() {
    jobStats = (await client.api.jobs.stats({})) as {
      pending: number;
      running: number;
      completed: number;
    };
  }

  // Rate limiter actions - using typed client
  async function checkRateLimit() {
    rateLimitResult = await client.api.ratelimit.check({
      key: rateLimitKey,
      limit: rateLimitMax,
      window: rateLimitWindow,
    });
  }

  async function resetRateLimit() {
    await client.api.ratelimit.reset({ key: rateLimitKey });
    rateLimitResult = { reset: true, message: "Rate limit reset" };
  }

  // Cron actions - using typed client
  async function refreshCronTasks() {
    const result = (await client.api.cron.list({})) as { tasks: CronTask[] };
    cronTasks = result.tasks;
  }

  // Events (pub/sub) actions - using typed client
  async function emitEvent() {
    try {
      const parsedData = JSON.parse(eventData);
      await client.api.events.emit({ event: eventName, data: parsedData });
    } catch (e) {
      console.error("Invalid JSON:", e);
    }
  }

  // SSE actions - using typed client
  async function manualBroadcast() {
    await client.api.sse.broadcast({
      channel: "events",
      event: "manual",
      data: {
        id: Date.now(),
        message: "Manual broadcast!",
        timestamp: new Date().toISOString(),
        source: "manual",
      },
    });
  }

  async function refreshSSEClients() {
    sseClients = (await client.api.sse.clients({})) as {
      total: number;
      byChannel: number;
    };
  }

  onMount(() => {
    if (!browser) return;

    // Initial data fetches
    refreshCacheKeys();
    refreshJobStats();
    refreshCronTasks();
    refreshSSEClients();

    // SSE subscription using the typed client
    const unsubscribe = client.sse.subscribe(
      ["events"],
      (eventType, eventData) => {
        // Handle all event types
        if (
          ["cron-event", "job-completed", "internal-event", "manual"].includes(
            eventType,
          )
        ) {
          // Simple prepend - CSS handles animation via :first-child or key-based animation
          events = [{ ...eventData }, ...events].slice(0, 15);

          if (eventType === "job-completed") {
            refreshJobStats();
          }
        }
      },
    );

    // Track connection status
    const checkConnection = setInterval(() => {
      // The SSE subscribe auto-reconnects, so we just refresh clients
      refreshSSEClients().then(() => {
        sseConnected = sseClients.byChannel > 0;
      });
      refreshJobStats();
    }, 5000);

    // Set connected after initial subscribe
    setTimeout(() => {
      sseConnected = true;
      refreshSSEClients();
    }, 500);

    return () => {
      unsubscribe();
      clearInterval(checkConnection);
    };
  });

  function getSourceColor(
    source?: string,
  ): "default" | "secondary" | "destructive" | "outline" | "success" {
    switch (source) {
      case "cron":
        return "default";
      case "manual":
        return "secondary";
      case "events":
        return "outline";
      default:
        return "success";
    }
  }

  function getSourceLabel(source?: string) {
    switch (source) {
      case "cron":
        return "CRON";
      case "manual":
        return "MANUAL";
      case "events":
        return "PUB/SUB";
      default:
        return "JOB";
    }
  }
</script>

<div class="min-h-screen bg-background">
  <div class="container mx-auto max-w-7xl py-8 px-4">
    <!-- Header -->
    <div class="text-center mb-8">
      <h1 class="text-3xl font-bold tracking-tight">@donkeylabs/server Demo</h1>
      <p class="text-muted-foreground mt-2">
        SvelteKit Adapter — All Core Services
      </p>
      <div class="flex gap-2 justify-center mt-3">
        <Badge variant="outline">
          SSR: {data.isSSR ? "Yes" : "No"} | Loaded: {data.loadedAt}
        </Badge>
        <a href="/workflows">
          <Badge variant="default" class="cursor-pointer hover:bg-primary/90">
            Try Workflows Demo
          </Badge>
        </a>
      </div>
    </div>

    <!-- Grid of feature cards -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-6">
      <!-- Counter / RPC Demo -->
      <Card>
        <CardHeader>
          <CardTitle>RPC Routes</CardTitle>
          <CardDescription
            >Type-safe API calls with Zod validation</CardDescription
          >
        </CardHeader>
        <CardContent>
          <div class="text-center py-4">
            <span class="text-5xl font-bold text-primary">{count}</span>
          </div>
          <div class="flex gap-2 justify-center">
            <Button
              variant="outline"
              size="icon"
              onclick={() => counterAction("decrement")}
              disabled={counterLoading}>−</Button
            >
            <Button
              variant="secondary"
              onclick={() => counterAction("get")}
              disabled={counterLoading}>Refresh</Button
            >
            <Button
              variant="outline"
              size="icon"
              onclick={() => counterAction("increment")}
              disabled={counterLoading}>+</Button
            >
            <Button
              variant="ghost"
              onclick={() => counterAction("reset")}
              disabled={counterLoading}>Reset</Button
            >
          </div>
        </CardContent>
      </Card>

      <!-- Cache Demo -->
      <Card>
        <CardHeader>
          <CardTitle>Cache</CardTitle>
          <CardDescription>In-memory caching with TTL support</CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <div class="flex gap-2">
            <Input bind:value={cacheKey} placeholder="Key" class="flex-1" />
            <Input bind:value={cacheValue} placeholder="Value" class="flex-1" />
          </div>
          <div class="flex gap-2">
            <Button onclick={cacheSet} size="sm">Set</Button>
            <Button onclick={cacheGet} size="sm" variant="secondary">Get</Button
            >
            <Button onclick={cacheDelete} size="sm" variant="outline"
              >Delete</Button
            >
          </div>
          {#if cacheResult}
            <pre
              class="text-xs bg-muted p-2 rounded-md overflow-auto">{JSON.stringify(
                cacheResult,
                null,
                2,
              )}</pre>
          {/if}
          <p class="text-xs text-muted-foreground">
            Keys ({cacheKeys.length}): {cacheKeys.length > 0
              ? cacheKeys.join(", ")
              : "none"}
          </p>
        </CardContent>
      </Card>

      <!-- Jobs Demo -->
      <Card>
        <CardHeader>
          <CardTitle>Background Jobs</CardTitle>
          <CardDescription>Async job queue with optional delay</CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <div class="flex gap-2">
            <Input
              bind:value={jobMessage}
              placeholder="Job message"
              class="flex-1"
            />
            <Input
              bind:value={jobDelay}
              type="number"
              placeholder="Delay"
              class="w-20"
            />
          </div>
          <div class="flex gap-2">
            <Button onclick={enqueueJob} size="sm">Enqueue</Button>
            <Button onclick={refreshJobStats} size="sm" variant="outline"
              >Refresh</Button
            >
          </div>
          {#if lastJobId}
            <p class="text-xs text-muted-foreground">
              Last Job: <code class="bg-muted px-1 rounded">{lastJobId}</code>
            </p>
          {/if}
          <div class="flex gap-3 text-xs text-muted-foreground">
            <span>Pending: {jobStats.pending}</span>
            <span>Running: {jobStats.running}</span>
            <span>Done: {jobStats.completed}</span>
          </div>
        </CardContent>
      </Card>

      <!-- Rate Limiter Demo -->
      <Card>
        <CardHeader>
          <CardTitle>Rate Limiter</CardTitle>
          <CardDescription>Sliding window rate limiting</CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <div class="flex gap-2">
            <Input bind:value={rateLimitKey} placeholder="Key" class="flex-1" />
            <Input
              bind:value={rateLimitMax}
              type="number"
              placeholder="Limit"
              class="w-16"
            />
            <Input
              bind:value={rateLimitWindow}
              type="number"
              placeholder="Window"
              class="w-20"
            />
          </div>
          <div class="flex gap-2">
            <Button onclick={checkRateLimit} size="sm">Check</Button>
            <Button onclick={resetRateLimit} size="sm" variant="outline"
              >Reset</Button
            >
          </div>
          {#if rateLimitResult}
            <pre
              class="text-xs p-2 rounded-md overflow-auto {rateLimitResult.allowed ===
              false
                ? 'bg-destructive/10 text-destructive'
                : 'bg-muted'}">{JSON.stringify(rateLimitResult, null, 2)}</pre>
          {/if}
        </CardContent>
      </Card>

      <!-- Cron Demo -->
      <Card>
        <CardHeader>
          <CardTitle>Cron Jobs</CardTitle>
          <CardDescription
            >Scheduled tasks with cron expressions</CardDescription
          >
        </CardHeader>
        <CardContent class="space-y-3">
          <Button onclick={refreshCronTasks} size="sm" variant="outline"
            >Refresh Tasks</Button
          >
          {#if cronTasks.length > 0}
            <ul class="space-y-2">
              {#each cronTasks as task}
                <li class="flex items-center gap-2 text-sm">
                  <span class="font-medium">{task.name}</span>
                  <code class="text-xs bg-muted px-1 rounded"
                    >{task.expression}</code
                  >
                  <Badge
                    variant={task.enabled ? "success" : "secondary"}
                    class="text-xs"
                  >
                    {task.enabled ? "Active" : "Paused"}
                  </Badge>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="text-sm text-muted-foreground italic">
              No scheduled tasks
            </p>
          {/if}
        </CardContent>
      </Card>

      <!-- Events (Pub/Sub) Demo -->
      <Card>
        <CardHeader>
          <CardTitle>Events (Pub/Sub)</CardTitle>
          <CardDescription>Internal event system with wildcards</CardDescription
          >
        </CardHeader>
        <CardContent class="space-y-3">
          <Input
            bind:value={eventName}
            placeholder="Event name (e.g., demo.test)"
          />
          <textarea
            bind:value={eventData}
            placeholder="JSON data"
            rows="2"
            class="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          ></textarea>
          <Button onclick={emitEvent} size="sm">Emit Event</Button>
          <p class="text-xs text-muted-foreground italic">
            Events matching "demo.*" broadcast to SSE
          </p>
        </CardContent>
      </Card>
    </div>

    <!-- SSE Events Stream - Full Width -->
    <Card>
      <CardHeader class="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Live Events (SSE)</CardTitle>
          <CardDescription>Real-time server → client push</CardDescription>
        </div>
        <div class="flex items-center gap-2">
          <span class="relative flex h-3 w-3">
            {#if sseConnected}
              <span
                class="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"
              ></span>
              <span
                class="relative inline-flex rounded-full h-3 w-3 bg-green-500"
              ></span>
            {:else}
              <span
                class="relative inline-flex rounded-full h-3 w-3 bg-gray-400"
              ></span>
            {/if}
          </span>
          <span class="text-sm text-muted-foreground">
            {sseConnected ? "Connected" : "Disconnected"} ({sseClients.byChannel}
            clients)
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div class="flex gap-2 mb-4">
          <Button onclick={manualBroadcast} size="sm">Manual Broadcast</Button>
          <Button onclick={refreshSSEClients} size="sm" variant="outline"
            >Refresh Clients</Button
          >
        </div>
        {#if events.length === 0}
          <p class="text-sm text-muted-foreground italic">
            Waiting for events... (cron broadcasts every 5s)
          </p>
        {:else}
          <ul class="space-y-2 max-h-80 overflow-y-auto">
            {#each events as event}
              <li
                class="flex items-center gap-3 p-3 rounded-lg border bg-muted/50 animate-in slide-in-from-left-2 duration-300"
              >
                <Badge variant={getSourceColor(event.source)}
                  >{getSourceLabel(event.source)}</Badge
                >
                <span class="flex-1 text-sm font-medium">{event.message}</span>
                <span class="text-xs text-muted-foreground"
                  >{new Date(event.timestamp).toLocaleTimeString()}</span
                >
              </li>
            {/each}
          </ul>
        {/if}
      </CardContent>
    </Card>
  </div>
</div>
