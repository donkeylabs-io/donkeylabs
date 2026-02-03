import adapter from '@donkeylabs/adapter-sveltekit';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

import type { Config } from '@sveltejs/kit';

const config: Config = {
  preprocess: vitePreprocess(),

  kit: {
    adapter: adapter(),
    alias: {
      $server: '.@donkeylabs/server',
    }
  }
};

export default config;
