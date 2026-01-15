// Test SSR direct service calls using the typed API client
import type { PageServerLoad } from './$types';
import { createApi } from '$lib/api';

export const load: PageServerLoad = async ({ locals }) => {
  // Create API client with locals for direct SSR calls (no HTTP!)
  const api = createApi({ locals });

  try {
    // Direct service call through typed client
    const { count } = await api.counter.get();
    return {
      count,
      loadedAt: new Date().toISOString(),
      isSSR: true,
    };
  } catch (e) {
    // Fallback if plugins not loaded yet
    return {
      count: 'N/A (plugins not loaded)',
      loadedAt: new Date().toISOString(),
      isSSR: true,
    };
  }
};
