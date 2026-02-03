import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  return {
    isSSR: true,
    loadedAt: new Date().toISOString(),
  };
};
