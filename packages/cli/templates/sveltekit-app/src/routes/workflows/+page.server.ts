// Workflow demo page - SSR load
import type { PageServerLoad } from "./$types";
import { createApi } from "$lib/api";

export const load: PageServerLoad = async ({ locals }) => {
  const client = createApi({ locals });

  try {
    // Load initial workflow instances
    const result = await client.api.workflow.list({});
    return {
      instances: result.instances || [],
      loadedAt: new Date().toISOString(),
      isSSR: true,
    };
  } catch (e) {
    return {
      instances: [],
      loadedAt: new Date().toISOString(),
      isSSR: true,
    };
  }
};
