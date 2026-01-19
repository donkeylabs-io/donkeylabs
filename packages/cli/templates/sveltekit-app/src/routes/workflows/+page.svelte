<script lang="ts">
  import { browser } from "$app/environment";
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";
  import { createApi } from "$lib/api";

  // Workflow steps for visual display
  const WORKFLOW_STEPS = [
    { id: "validate", label: "Validate Order", icon: "1" },
    { id: "payment", label: "Process Payment", icon: "2" },
    { id: "fulfill", label: "Fulfill Order", icon: "3", parallel: true },
    { id: "complete", label: "Complete", icon: "4" },
  ];

  // Parallel sub-steps
  const PARALLEL_STEPS = {
    fulfill: [
      { id: "send-email", label: "Send Email" },
      { id: "prepare-shipment", label: "Prepare Shipment" },
    ],
  };

  let { data } = $props();

  const client = createApi();

  // Active workflow state
  let activeWorkflow = $state<any>(null);
  let workflowProgress = $state(0);
  let currentStep = $state<string | null>(null);
  let stepStatuses = $state<Record<string, string>>({});
  let stepResults = $state<Record<string, any>>({});
  let isStarting = $state(false);

  // History state
  let instances = $state(data.instances || []);

  // Event log for debugging
  let eventLog = $state<Array<{ time: string; event: string; data: any }>>([]);

  function getStepStatus(stepId: string): "pending" | "running" | "completed" | "failed" {
    return (stepStatuses[stepId] as any) || "pending";
  }

  function getStatusColor(status: string): "default" | "secondary" | "destructive" | "outline" | "success" {
    switch (status) {
      case "completed":
        return "success";
      case "running":
        return "default";
      case "failed":
        return "destructive";
      case "cancelled":
        return "secondary";
      default:
        return "outline";
    }
  }

  function getStepBgClass(status: string): string {
    switch (status) {
      case "completed":
        return "bg-green-500 text-white";
      case "running":
        return "bg-blue-500 text-white animate-pulse";
      case "failed":
        return "bg-red-500 text-white";
      default:
        return "bg-muted text-muted-foreground";
    }
  }

  function getStepBorderClass(status: string): string {
    switch (status) {
      case "completed":
        return "border-green-500";
      case "running":
        return "border-blue-500";
      case "failed":
        return "border-red-500";
      default:
        return "border-muted";
    }
  }

  async function startWorkflow() {
    isStarting = true;
    stepStatuses = {};
    stepResults = {};
    workflowProgress = 0;
    currentStep = null;
    eventLog = [];

    try {
      const result = await client.api.workflow.start({});
      activeWorkflow = { id: result.instanceId, status: "pending" };

      // Subscribe to this specific workflow's SSE channel
      const unsubscribe = client.sse.subscribe(
        [`workflow:${result.instanceId}`],
        handleWorkflowEvent
      );

      // Store unsubscribe for cleanup
      (activeWorkflow as any)._unsubscribe = unsubscribe;
    } catch (e) {
      console.error("Failed to start workflow:", e);
    } finally {
      isStarting = false;
    }
  }

  function handleWorkflowEvent(eventType: string, eventData: any) {
    // Log the event
    eventLog = [
      { time: new Date().toLocaleTimeString(), event: eventType, data: eventData },
      ...eventLog,
    ].slice(0, 20);

    switch (eventType) {
      case "workflow.started":
        activeWorkflow = { ...activeWorkflow, status: "running" };
        break;

      case "workflow.progress":
        workflowProgress = eventData.progress || 0;
        currentStep = eventData.currentStep;
        break;

      case "workflow.step.started":
        stepStatuses = { ...stepStatuses, [eventData.stepName]: "running" };
        currentStep = eventData.stepName;
        break;

      case "workflow.step.completed":
        stepStatuses = { ...stepStatuses, [eventData.stepName]: "completed" };
        if (eventData.output) {
          stepResults = { ...stepResults, [eventData.stepName]: eventData.output };
        }
        break;

      case "workflow.step.failed":
        stepStatuses = { ...stepStatuses, [eventData.stepName]: "failed" };
        break;

      case "workflow.completed":
        activeWorkflow = { ...activeWorkflow, status: "completed", output: eventData.output };
        workflowProgress = 100;
        refreshInstances();
        break;

      case "workflow.failed":
        activeWorkflow = { ...activeWorkflow, status: "failed", error: eventData.error };
        refreshInstances();
        break;

      case "workflow.cancelled":
        activeWorkflow = { ...activeWorkflow, status: "cancelled" };
        refreshInstances();
        break;
    }
  }

  async function cancelWorkflow() {
    if (!activeWorkflow) return;
    try {
      await client.api.workflow.cancel({ instanceId: activeWorkflow.id });
    } catch (e) {
      console.error("Failed to cancel workflow:", e);
    }
  }

  async function refreshInstances() {
    try {
      const result = await client.api.workflow.list({});
      instances = result.instances || [];
    } catch (e) {
      console.error("Failed to refresh instances:", e);
    }
  }

  async function viewWorkflowDetails(instanceId: string) {
    try {
      const status = await client.api.workflow.status({ instanceId });
      if (status) {
        activeWorkflow = status;
        stepStatuses = {};
        stepResults = {};
        workflowProgress = status.status === "completed" ? 100 : 0;

        // Rebuild step statuses from stepResults
        if (status.stepResults) {
          for (const [stepName, result] of Object.entries(status.stepResults as Record<string, any>)) {
            stepStatuses[stepName] = result.status || "completed";
            if (result.output) {
              stepResults[stepName] = result.output;
            }
          }
        }
      }
    } catch (e) {
      console.error("Failed to get workflow status:", e);
    }
  }

  function clearWorkflow() {
    if (activeWorkflow?._unsubscribe) {
      activeWorkflow._unsubscribe();
    }
    activeWorkflow = null;
    stepStatuses = {};
    stepResults = {};
    workflowProgress = 0;
    currentStep = null;
    eventLog = [];
  }

  onMount(() => {
    if (!browser) return;

    // Subscribe to workflow-updates channel for list updates
    const unsubscribe = client.sse.subscribe(
      ["workflow-updates"],
      (eventType, eventData) => {
        if (["workflow.completed", "workflow.failed", "workflow.cancelled"].includes(eventType)) {
          refreshInstances();
        }
      }
    );

    return () => {
      unsubscribe();
      if (activeWorkflow?._unsubscribe) {
        activeWorkflow._unsubscribe();
      }
    };
  });
</script>

<div class="min-h-screen bg-background">
  <div class="container mx-auto max-w-6xl py-8 px-4">
    <!-- Header -->
    <div class="text-center mb-8">
      <h1 class="text-3xl font-bold tracking-tight">Workflow Demo</h1>
      <p class="text-muted-foreground mt-2">
        Step Function Orchestration with Real-time Progress
      </p>
      <div class="flex gap-2 justify-center mt-4">
        <a href="/">
          <Button variant="outline" size="sm">Back to Main Demo</Button>
        </a>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- Workflow Runner -->
      <div class="lg:col-span-2 space-y-6">
        <!-- Control Panel -->
        <Card>
          <CardHeader>
            <CardTitle>Order Processing Workflow</CardTitle>
            <CardDescription>
              Multi-step workflow with validation, payment, and parallel fulfillment
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div class="flex gap-3 items-center">
              <Button
                onclick={startWorkflow}
                disabled={isStarting || (activeWorkflow && activeWorkflow.status === "running")}
              >
                {isStarting ? "Starting..." : "Start New Workflow"}
              </Button>
              {#if activeWorkflow && activeWorkflow.status === "running"}
                <Button variant="destructive" onclick={cancelWorkflow}>
                  Cancel
                </Button>
              {/if}
              {#if activeWorkflow && activeWorkflow.status !== "running"}
                <Button variant="outline" onclick={clearWorkflow}>
                  Clear
                </Button>
              {/if}
              {#if activeWorkflow}
                <Badge variant={getStatusColor(activeWorkflow.status)}>
                  {activeWorkflow.status.toUpperCase()}
                </Badge>
              {/if}
            </div>
          </CardContent>
        </Card>

        <!-- Progress Visualization -->
        {#if activeWorkflow}
          <Card>
            <CardHeader>
              <CardTitle class="text-lg">Progress</CardTitle>
              <CardDescription>
                Instance: <code class="bg-muted px-1 rounded text-xs">{activeWorkflow.id}</code>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <!-- Progress Bar -->
              <div class="mb-6">
                <div class="flex justify-between text-sm mb-1">
                  <span>Progress</span>
                  <span>{Math.round(workflowProgress)}%</span>
                </div>
                <div class="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    class="h-full bg-primary transition-all duration-500 ease-out"
                    style="width: {workflowProgress}%"
                  ></div>
                </div>
              </div>

              <!-- Step Visualization -->
              <div class="space-y-4">
                {#each WORKFLOW_STEPS as step, i}
                  {@const status = getStepStatus(step.id)}
                  <div class="flex items-start gap-4">
                    <!-- Step Number/Icon -->
                    <div
                      class="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-all duration-300 {getStepBgClass(status)}"
                    >
                      {#if status === "completed"}
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                        </svg>
                      {:else if status === "running"}
                        <svg class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                      {:else if status === "failed"}
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                      {:else}
                        {step.icon}
                      {/if}
                    </div>

                    <!-- Step Content -->
                    <div class="flex-1">
                      <div class="flex items-center gap-2">
                        <span class="font-medium">{step.label}</span>
                        {#if step.parallel}
                          <Badge variant="outline" class="text-xs">Parallel</Badge>
                        {/if}
                      </div>

                      <!-- Parallel Sub-steps -->
                      {#if step.parallel && PARALLEL_STEPS[step.id as keyof typeof PARALLEL_STEPS]}
                        <div class="mt-2 ml-4 space-y-2">
                          {#each PARALLEL_STEPS[step.id as keyof typeof PARALLEL_STEPS] as subStep}
                            {@const subStatus = getStepStatus(subStep.id)}
                            <div class="flex items-center gap-2 text-sm">
                              <div
                                class="w-6 h-6 rounded-full flex items-center justify-center text-xs transition-all duration-300 {getStepBgClass(subStatus)}"
                              >
                                {#if subStatus === "completed"}
                                  <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                                  </svg>
                                {:else if subStatus === "running"}
                                  <svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                                  </svg>
                                {:else}
                                  -
                                {/if}
                              </div>
                              <span class={subStatus === "completed" ? "text-green-600" : subStatus === "running" ? "text-blue-600" : "text-muted-foreground"}>
                                {subStep.label}
                              </span>
                            </div>
                          {/each}
                        </div>
                      {/if}

                      <!-- Step Result -->
                      {#if stepResults[step.id]}
                        <pre class="mt-2 text-xs bg-muted p-2 rounded overflow-auto max-h-20">{JSON.stringify(stepResults[step.id], null, 2)}</pre>
                      {/if}
                    </div>
                  </div>

                  <!-- Connector Line -->
                  {#if i < WORKFLOW_STEPS.length - 1}
                    <div class="ml-5 w-0.5 h-4 bg-muted"></div>
                  {/if}
                {/each}
              </div>

              <!-- Final Output -->
              {#if activeWorkflow.status === "completed" && activeWorkflow.output}
                <div class="mt-6 p-4 bg-green-50 dark:bg-green-950 rounded-lg border border-green-200 dark:border-green-800">
                  <h4 class="font-medium text-green-800 dark:text-green-200 mb-2">Workflow Complete</h4>
                  <pre class="text-xs overflow-auto">{JSON.stringify(activeWorkflow.output, null, 2)}</pre>
                </div>
              {/if}

              {#if activeWorkflow.status === "failed" && activeWorkflow.error}
                <div class="mt-6 p-4 bg-red-50 dark:bg-red-950 rounded-lg border border-red-200 dark:border-red-800">
                  <h4 class="font-medium text-red-800 dark:text-red-200 mb-2">Workflow Failed</h4>
                  <p class="text-sm text-red-600 dark:text-red-400">{activeWorkflow.error}</p>
                </div>
              {/if}
            </CardContent>
          </Card>
        {/if}

        <!-- Event Log -->
        {#if eventLog.length > 0}
          <Card>
            <CardHeader>
              <CardTitle class="text-lg">SSE Event Log</CardTitle>
              <CardDescription>Real-time events from the server</CardDescription>
            </CardHeader>
            <CardContent>
              <ul class="space-y-1 max-h-48 overflow-y-auto font-mono text-xs">
                {#each eventLog as log}
                  <li class="flex gap-2 p-1 hover:bg-muted rounded">
                    <span class="text-muted-foreground">{log.time}</span>
                    <Badge variant="outline" class="text-xs">{log.event.replace("workflow.", "")}</Badge>
                    {#if log.data.stepName}
                      <span class="text-primary">{log.data.stepName}</span>
                    {/if}
                    {#if log.data.progress !== undefined}
                      <span class="text-green-600">{log.data.progress}%</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            </CardContent>
          </Card>
        {/if}
      </div>

      <!-- Sidebar - History -->
      <div class="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle class="text-lg">Workflow History</CardTitle>
            <CardDescription>Recent workflow instances</CardDescription>
          </CardHeader>
          <CardContent>
            <div class="flex gap-2 mb-4">
              <Button size="sm" variant="outline" onclick={refreshInstances}>
                Refresh
              </Button>
            </div>
            {#if instances.length === 0}
              <p class="text-sm text-muted-foreground italic">No workflows yet</p>
            {:else}
              <ul class="space-y-2 max-h-96 overflow-y-auto">
                {#each instances as instance}
                  <li>
                    <button
                      class="w-full text-left p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
                      onclick={() => viewWorkflowDetails(instance.id)}
                    >
                      <div class="flex items-center justify-between">
                        <code class="text-xs truncate max-w-[120px]">{instance.id}</code>
                        <Badge variant={getStatusColor(instance.status)} class="text-xs">
                          {instance.status}
                        </Badge>
                      </div>
                      {#if instance.currentStep}
                        <p class="text-xs text-muted-foreground mt-1">
                          Step: {instance.currentStep}
                        </p>
                      {/if}
                      <p class="text-xs text-muted-foreground mt-1">
                        {new Date(instance.createdAt).toLocaleString()}
                      </p>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </CardContent>
        </Card>

        <!-- Workflow Info -->
        <Card>
          <CardHeader>
            <CardTitle class="text-lg">About This Demo</CardTitle>
          </CardHeader>
          <CardContent class="text-sm space-y-2">
            <p>
              This demo shows a <strong>step function workflow</strong> for order processing:
            </p>
            <ol class="list-decimal list-inside space-y-1 text-muted-foreground">
              <li>Validate order (1s)</li>
              <li>Process payment (2s)</li>
              <li>Parallel fulfillment:
                <ul class="list-disc list-inside ml-4">
                  <li>Send confirmation email</li>
                  <li>Prepare shipment</li>
                </ul>
              </li>
              <li>Complete with summary</li>
            </ol>
            <p class="text-muted-foreground">
              Progress is streamed via <strong>Server-Sent Events (SSE)</strong> for real-time updates.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  </div>
</div>
