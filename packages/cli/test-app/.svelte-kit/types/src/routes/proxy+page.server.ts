// @ts-nocheck
import type { PageServerLoad } from './$types';

export const load = async ({ locals }: Parameters<PageServerLoad>[0]) => {
  return {
    isSSR: true,
    loadedAt: new Date().toISOString(),
  };
};
